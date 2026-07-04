/**
 * Fake-worker driver (issue 63) — a scripted, deterministic stand-in for an
 * afk-issue-runner Worker. Per issue, it does exactly what the skill's contract
 * says a Worker does at each exit — writes the deliverable, flips the issue's
 * status, writes the Receipt (`issues/completions/NN-slug.md`, one save, last),
 * and in parallel mode commits on its `afk/NN-slug` branch — with configurable
 * **misbehavior modes** so the suite can exercise the seams that only sloppy
 * real Workers ever hit. No LLM anywhere.
 *
 * Exits (the skill's three):
 *   - `completed`          — flip `done`, Receipt `outcome: completed`.
 *   - `needs-verification` — HITL park: stays `wip`, Receipt declares it.
 *   - `blocked`            — stays `wip`, Receipt `outcome: blocked`.
 *
 * Misbehavior modes (issue 63):
 *   - `none`                       — the well-behaved contract above.
 *   - `receipt-to-wrong-checkout`  — parallel Worker writes its Receipt into the
 *                                    MAIN checkout's `issues/completions/`
 *                                    instead of its own worktree's copy (the
 *                                    walkthrough-58 second-attempt bug, issue 62).
 *   - `no-receipt`                 — finishes (flip/commit) but never writes a
 *                                    Receipt (issue 57's honest-gap signal).
 *   - `receipt-before-commit`      — writes the Receipt, then dies BEFORE
 *                                    committing: the Receipt is on disk (the
 *                                    watcher can ingest it live) while the
 *                                    branch tip still reads `wip`.
 *   - `die-mid-exit`               — flips `done`, then stops: no Receipt, no
 *                                    commit. The drain must not stall on it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueFileContent, type SandboxIssue } from './sandbox';

const exec = promisify(execFile);

export type WorkerExit = 'completed' | 'needs-verification' | 'blocked';

export type Misbehavior =
  | 'none'
  | 'receipt-to-wrong-checkout'
  | 'no-receipt'
  | 'receipt-before-commit'
  | 'die-mid-exit';

export interface WorkerTask {
  /** The shared Project checkout (`main`). */
  repo: string;
  /** The Run's own worktree — present means PARALLEL mode (Worker commits). */
  worktree?: string;
  issue: SandboxIssue;
  exit?: WorkerExit;
  misbehavior?: Misbehavior;
  /** The Receipt's `finished` stamp; injectable so re-runs are testable. */
  finished?: string;
}

export interface WorkerTrace {
  /** Where the deliverable landed, or null (a blocked Worker builds nothing). */
  deliverablePath: string | null;
  /** Where the Receipt landed, or null when the mode suppressed it. */
  receiptPath: string | null;
  /** Whether the Worker committed on its branch (parallel, well-behaved). */
  committed: boolean;
}

/** The Receipt body for each exit — the same block the Worker's final message is. */
function receiptBody(issue: SandboxIssue, exit: WorkerExit): string {
  const label = `${String(issue.id).padStart(2, '0')} — ${issue.slug}`;
  switch (exit) {
    case 'completed':
      return (
        `## Completed issue ${label}\n\n` +
        `**What changed** — ${issue.title} now exists; the app gained the scripted deliverable.\n\n` +
        `**Try it yourself** — open work/${issue.slug}.txt and read the line the Worker wrote.\n\n` +
        `**Verified** — read the deliverable back from disk after writing it.\n\n` +
        `**Bookkeeping** — files touched: work/${issue.slug}.txt, issues/${issue.slug}.md.\n\n` +
        `**Doc drift** — none.\n`
      );
    case 'needs-verification':
      return (
        `## Ready for manual verification — issue ${issue.id} — ${issue.slug}\n\n` +
        `Steps:\n` +
        `1. Open the surface this issue changed.\n` +
        `2. Confirm the acceptance-criteria behavior by hand.\n\n` +
        `The issue stays wip until you verify it and mark it done.\n`
      );
    case 'blocked':
      return (
        `No AFK-eligible work completable on issue ${issue.id} — ${issue.slug}. ` +
        `I stopped because a dependency the issue says is done turned out not to be done in the code. ` +
        `Recommend the user unstick it before running AFK again.\n`
      );
  }
}

/** The full Receipt file text: declared frontmatter, then the block verbatim. */
export function receiptText(issue: SandboxIssue, exit: WorkerExit, finished: string): string {
  const outcome =
    exit === 'completed' ? 'completed' : exit === 'needs-verification' ? 'needs-verification' : 'blocked';
  return (
    `---\n` +
    `issue: ${issue.id}\n` +
    `slug: ${issue.slug}\n` +
    `outcome: ${outcome}\n` +
    `finished: ${finished}\n` +
    `---\n` +
    receiptBody(issue, exit)
  );
}

/**
 * Run one scripted Worker to its exit. Deterministic: every file write and the
 * optional commit happen before this resolves — "the Worker's turn ended".
 */
export async function runFakeWorker(task: WorkerTask): Promise<WorkerTrace> {
  const { repo, worktree, issue } = task;
  const exit = task.exit ?? 'completed';
  const misbehavior = task.misbehavior ?? 'none';
  const finished = task.finished ?? new Date().toISOString();
  const root = worktree ?? repo;
  const issueFile = join(root, 'issues', `${issue.slug}.md`);

  // Claim: flip open → wip (the skill's section-1 claim marker).
  await writeFile(issueFile, issueFileContent(issue, 'wip'));

  // Do the work: a blocked Worker built nothing; the others leave a deliverable.
  let deliverablePath: string | null = null;
  if (exit !== 'blocked') {
    deliverablePath = join(root, 'work', `${issue.slug}.txt`);
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(deliverablePath, `deliverable for ${issue.slug}\n`);
  }

  // Exit status: only a completed Run flips done; HITL parks and blocked stops
  // leave the claim's `wip` in place (the skill's §2/§6 contracts).
  if (exit === 'completed') {
    await writeFile(issueFile, issueFileContent(issue, 'done'));
  }

  // Receipt — one save, last (the skill's Receipts section) — unless the mode
  // suppresses it or redirects it to the wrong checkout.
  let receiptPath: string | null = null;
  if (misbehavior !== 'no-receipt' && misbehavior !== 'die-mid-exit') {
    const receiptRoot = misbehavior === 'receipt-to-wrong-checkout' ? repo : root;
    receiptPath = join(receiptRoot, 'issues', 'completions', `${issue.slug}.md`);
    await mkdir(join(receiptRoot, 'issues', 'completions'), { recursive: true });
    await writeFile(receiptPath, receiptText(issue, exit, finished));
  }

  // Parallel mode: a well-behaved Worker commits its work (deliverable + flip +
  // its worktree's Receipt) on the `afk/NN-slug` branch. A Worker that died
  // mid-exit — or one scripted to write its Receipt and stop — commits nothing.
  // Solo Workers NEVER commit: Mission Control owns the solo commit (issue 59).
  let committed = false;
  if (worktree && misbehavior !== 'receipt-before-commit' && misbehavior !== 'die-mid-exit') {
    await exec('git', ['add', '-A'], { cwd: worktree });
    await exec(
      'git',
      ['commit', '-m', `afk: ${exit === 'completed' ? 'complete' : exit} issue ${issue.id} — ${issue.slug}`],
      { cwd: worktree },
    );
    committed = true;
  }

  return { deliverablePath, receiptPath, committed };
}
