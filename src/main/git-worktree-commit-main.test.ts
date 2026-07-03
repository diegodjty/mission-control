/**
 * Integration check for auto-committing finished SOLO Runs on `main` (issue 25).
 * It spans the REAL seam the batch-QA walkthrough hit end-to-end (corr-4): a
 * solo Run works directly on `main`; the spawned agent (single-issue mode) flips
 * its issue to `done` and leaves the created file + the flip UNCOMMITTED, so
 * `main` stays dirty. The next parallel Merge then fails `afk-merge.sh`'s
 * clean-tree preflight ("commit or stash them first") with no in-app remedy.
 *
 * Here we simulate the finished-but-uncommitted solo work, assert Mission
 * Control auto-commits it onto `main` (symmetric with issue 15's isolated
 * auto-commit), that it is idempotent and gated on the done transition, and —
 * the acceptance-criteria integration — that a real parallel Merge which was
 * BLOCKED by the leftover solo changes succeeds once MC has committed them.
 *
 * Drives real git (and the real `afk-merge.sh`) against a throwaway temp repo —
 * never the real project, never the real backlog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktree,
  commitFinishedWorktree,
  commitFinishedMain,
} from './git-worktree-adapter';
import { mergeRuns, defaultMergeScriptPath } from './run-merge';
import { readBacklog } from './backlog-reader';
import { branchFor } from '../shared/isolation-policy';
import { decideSoloCommitStep, type SoloCommitPhase } from '../shared/run-state';

const exec = promisify(execFile);
const SCRIPT = defaultMergeScriptPath();

let scratch: string;
let repo: string;

// The solo Run finishing on `main`.
const SOLO_SLUG = '25-commit-solo-runs-keep-main-clean';
const SOLO_ISSUE_PATH = `issues/${SOLO_SLUG}.md`;
const SOLO_FEATURE_PATH = 'src/solo-feature.ts';

// A separate parallel Run whose branch a later Merge integrates.
const PAR_SLUG = '04-tracer-bullet';
const PAR_ISSUE_PATH = `issues/${PAR_SLUG}.md`;
const PAR_FEATURE_PATH = 'src/par-feature.ts';

function issueFile(id: number, title: string, status: 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# ${id} — ${title}\n\nbody\n`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Is `main`'s working tree clean (afk-merge.sh's preflight condition)? */
async function mainIsClean(): Promise<boolean> {
  return (await git(repo, 'status', '--porcelain')).trim().length === 0;
}

async function commitCountMain(): Promise<number> {
  return Number((await git(repo, 'rev-list', '--count', 'main')).trim());
}

/**
 * Simulate the spawned agent for the SOLO Run on `main`: create a new file and
 * flip the issue to the given status, both left UNCOMMITTED (single-issue mode
 * never commits) — exactly the state that leaves `main` dirty.
 */
async function simulateSoloAgent(status: 'wip' | 'done'): Promise<void> {
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, SOLO_FEATURE_PATH), 'export const solo = true;\n');
  await writeFile(join(repo, SOLO_ISSUE_PATH), issueFile(25, 'Solo', status));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-commit-main-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  // Both issues start `wip` on main — what the main-checkout watcher sees.
  await writeFile(join(repo, SOLO_ISSUE_PATH), issueFile(25, 'Solo', 'wip'));
  await writeFile(join(repo, PAR_ISSUE_PATH), issueFile(4, 'Tracer bullet', 'wip'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: issues 04 + 25 wip');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('commitFinishedMain — auto-commit a finished solo Run on main', () => {
  it('commits the created file + done flip onto main, leaving main clean', async () => {
    await simulateSoloAgent('done');
    expect(await mainIsClean()).toBe(false);
    const before = await commitCountMain();

    const outcome = await commitFinishedMain(repo, SOLO_SLUG);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();

    // main now carries a new commit with both the file and the done flip, and
    // the working tree is clean (mergeable).
    expect(await commitCountMain()).toBe(before + 1);
    expect(await mainIsClean()).toBe(true);
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain(SOLO_FEATURE_PATH);
    const message = await git(repo, 'log', '-1', '--format=%s', 'main');
    expect(message.trim()).toBe('afk: complete issue 25 — commit-solo-runs-keep-main-clean');
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 25)?.status).toBe('done');
  });

  it('is idempotent — a solo Run already committed is not committed again', async () => {
    await simulateSoloAgent('done');
    expect((await commitFinishedMain(repo, SOLO_SLUG)).committed).toBe(true);
    const after = await commitCountMain();

    // A second observation finds a clean tree — nothing to commit.
    expect((await commitFinishedMain(repo, SOLO_SLUG)).committed).toBe(false);
    expect(await commitCountMain()).toBe(after);
  });

  it('does NOT commit a blocked/stopped solo Run (still wip) — left for the user', async () => {
    await simulateSoloAgent('wip');
    const before = await commitCountMain();
    expect((await commitFinishedMain(repo, SOLO_SLUG)).committed).toBe(false);
    // Nothing committed; the user's in-progress work stays untouched on main.
    expect(await commitCountMain()).toBe(before);
    expect(await mainIsClean()).toBe(false);
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 25)?.status).toBe('wip');
  });
});

describe('issue 59 — the solo finished-commit waits for (and captures) the Receipt', () => {
  const RECEIPT_PATH = `issues/completions/${SOLO_SLUG}.md`;

  /** The skill's last write: the Receipt file, landing a beat after the flip. */
  async function writeReceipt(): Promise<void> {
    await mkdir(join(repo, 'issues/completions'), { recursive: true });
    await writeFile(
      join(repo, RECEIPT_PATH),
      `---\nissue: 25\nslug: ${SOLO_SLUG}\noutcome: completed\nfinished: 2026-07-03T00:00:00Z\n---\n## Completed issue 25 — solo\n`,
    );
  }

  /**
   * Drive one observation exactly as the renderer does: run the pure decision
   * against the live facts, and execute a `commit` step via the real adapter.
   * Returns the next phase (unchanged when the step was not a commit).
   */
  async function observe(
    phase: SoloCommitPhase,
    receiptPresent: boolean,
    graceElapsed: boolean,
  ): Promise<SoloCommitPhase> {
    const step = decideSoloCommitStep({
      runStatus: 'finished',
      isolated: false,
      phase,
      receiptPresent,
      graceElapsed,
    });
    if (step.act === 'commit') {
      await commitFinishedMain(repo, SOLO_SLUG);
      return step.nextPhase;
    }
    return step.act === 'schedule-grace' ? 'waiting' : phase;
  }

  it('skill write-order (flip done → beat → Receipt): ONE commit with deliverable + flip + Receipt, main clean', async () => {
    const before = await commitCountMain();

    // The Worker flips `done`; the Receipt has not landed yet — the decision
    // WAITS instead of firing the auto-commit on the flip observation.
    await simulateSoloAgent('done');
    let phase = await observe('unstarted', false, false);
    expect(phase).toBe('waiting');
    expect(await commitCountMain()).toBe(before); // nothing committed yet

    // A beat later the Receipt lands (the skill's last write) → NOW commit.
    await writeReceipt();
    phase = await observe(phase, true, false);
    expect(phase).toBe('committed');

    // Exactly ONE commit, containing the deliverable, the flip AND the Receipt.
    expect(await commitCountMain()).toBe(before + 1);
    expect(await mainIsClean()).toBe(true);
    const inCommit = await git(repo, 'show', '--name-only', '--format=', 'main');
    expect(inCommit).toContain(SOLO_FEATURE_PATH);
    expect(inCommit).toContain(SOLO_ISSUE_PATH);
    expect(inCommit).toContain(RECEIPT_PATH);

    // Re-observation stays quiet — never a double commit.
    phase = await observe(phase, true, true);
    expect(phase).toBe('committed');
    expect(await commitCountMain()).toBe(before + 1);
  });

  it('Receipt after the grace window: work commits without it (no stall), the late Receipt is committed by the next observation', async () => {
    const before = await commitCountMain();

    await simulateSoloAgent('done');
    let phase = await observe('unstarted', false, false);
    expect(phase).toBe('waiting');

    // The grace window elapses with NO Receipt → commit the work anyway
    // (honesty over stalling; the missing-receipt note is the only signal).
    phase = await observe(phase, false, true);
    expect(phase).toBe('committed-sans-receipt');
    expect(await commitCountMain()).toBe(before + 1);
    expect(await mainIsClean()).toBe(true);

    // The Receipt straggles in later, leaving main dirty again…
    await writeReceipt();
    expect(await mainIsClean()).toBe(false);

    // …and the NEXT observation commits it (idempotent follow-up).
    phase = await observe(phase, true, true);
    expect(phase).toBe('committed');
    expect(await commitCountMain()).toBe(before + 2);
    expect(await mainIsClean()).toBe(true);
    const straggler = await git(repo, 'show', '--name-only', '--format=', 'main');
    expect(straggler.trim()).toBe(RECEIPT_PATH);

    // Further observations are no-ops.
    phase = await observe(phase, true, true);
    expect(phase).toBe('committed');
    expect(await commitCountMain()).toBe(before + 2);
  });
});

describe('the corr-4 wall: leftover solo work blocks a parallel Merge (issue 25)', () => {
  it('solo Run done → committed+clean → the parallel Merge preflight now passes', async () => {
    // A parallel Run finished on its own branch, committed and mergeable.
    const wt = await createWorktree(repo, PAR_SLUG, branchFor(PAR_SLUG));
    await mkdir(join(wt, 'src'), { recursive: true });
    await writeFile(join(wt, PAR_FEATURE_PATH), 'export const par = true;\n');
    await writeFile(join(wt, PAR_ISSUE_PATH), issueFile(4, 'Tracer bullet', 'done'));
    expect((await commitFinishedWorktree(repo, PAR_SLUG)).committed).toBe(true);

    // Meanwhile a solo Run finished on main and left it dirty (the QA wall).
    await simulateSoloAgent('done');
    expect(await mainIsClean()).toBe(false);

    // The Merge is refused by afk-merge.sh's clean-tree preflight.
    const blocked = await mergeRuns(repo, [PAR_SLUG], { scriptPath: SCRIPT });
    expect(blocked.ok).toBe(false);
    expect(blocked.merged).toEqual([]);

    // MC auto-commits the finished solo Run → main is clean and mergeable.
    expect((await commitFinishedMain(repo, SOLO_SLUG)).committed).toBe(true);
    expect(await mainIsClean()).toBe(true);

    // The very same Merge now succeeds and lands the parallel branch on main.
    const ok = await mergeRuns(repo, [PAR_SLUG], { scriptPath: SCRIPT });
    expect(ok.ok).toBe(true);
    expect(ok.conflicted).toBe(false);
    expect(ok.merged).toEqual([PAR_SLUG]);

    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain(PAR_FEATURE_PATH);
    // The solo work is still present and both issues read done on main.
    expect(tracked).toContain(SOLO_FEATURE_PATH);
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 4)?.status).toBe('done');
    expect(backlog.issues.find((i) => i.id === 25)?.status).toBe('done');
  });
});

describe('issue 62 — the solo finished path adopts a stray Receipt', () => {
  const OWN_RECEIPT = `issues/completions/${SOLO_SLUG}.md`;
  const STRAY_RECEIPT = 'issues/completions/07-parked-elsewhere.md';

  async function writeReceiptFile(path: string, issue: number): Promise<void> {
    await mkdir(join(repo, 'issues/completions'), { recursive: true });
    await writeFile(
      join(repo, path),
      `---\nissue: ${issue}\noutcome: completed\n---\nbody\n`,
    );
  }

  async function subjects(): Promise<string[]> {
    return (await git(repo, 'log', '--format=%s', 'main')).trim().split('\n');
  }

  it('a stray Receipt present at the solo finish is adopted in its OWN chore commit; the run commit keeps the Run\'s work + its own Receipt', async () => {
    const before = await commitCountMain();

    // The solo Run finished (work + done flip + its own Receipt), and a stray
    // Receipt from some other Run sits misplaced on main.
    await simulateSoloAgent('done');
    await writeReceiptFile(OWN_RECEIPT, 25);
    await writeReceiptFile(STRAY_RECEIPT, 7);

    const outcome = await commitFinishedMain(repo, SOLO_SLUG);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.adopted).toEqual([STRAY_RECEIPT]);

    // Two commits: the dedicated adoption, then the run commit — main clean.
    expect(await commitCountMain()).toBe(before + 2);
    expect(await mainIsClean()).toBe(true);
    const log = await subjects();
    expect(log[0]).toBe('afk: complete issue 25 — commit-solo-runs-keep-main-clean');
    expect(log[1]).toBe(`chore: adopt stray Receipt(s) — ${STRAY_RECEIPT}`);

    // Attribution stays honest: the stray is ONLY in the adoption commit; the
    // Run's own Receipt and work are ONLY in the run commit (issue 59 intact).
    const adoptFiles = await git(repo, 'show', '--name-only', '--format=', 'main~1');
    expect(adoptFiles.trim()).toBe(STRAY_RECEIPT);
    const runFiles = await git(repo, 'show', '--name-only', '--format=', 'main');
    expect(runFiles).toContain(SOLO_FEATURE_PATH);
    expect(runFiles).toContain(OWN_RECEIPT);
    expect(runFiles).not.toContain(STRAY_RECEIPT);
  });

  it('a not-yet-finished solo Run adopts nothing (the guard still gates on done)', async () => {
    await simulateSoloAgent('wip');
    await writeReceiptFile(STRAY_RECEIPT, 7);
    const before = await commitCountMain();

    const outcome = await commitFinishedMain(repo, SOLO_SLUG);
    expect(outcome.committed).toBe(false);
    expect(outcome.adopted).toBeUndefined();
    expect(await commitCountMain()).toBe(before);
  });
});
