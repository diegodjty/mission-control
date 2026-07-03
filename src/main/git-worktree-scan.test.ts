/**
 * Integration check for the on-disk `afk/` scan (issue 16). It exercises the
 * REAL git seam the batch-QA walkthrough found broken: the Map showed
 * worktree-Runs as plain `open`, and closing the Panes orphaned finished-but-
 * unmerged branches. `scanAfkBranches` reads the ground truth (worktrees +
 * committed branch tips) so the pure `worktree-scan` derivations can drive the
 * Map indicators and a Merge affordance that survives closing every Pane.
 *
 * Drives real git against a throwaway temp repo with real `afk/NN-slug`
 * worktrees and branches — never the real project, never the real backlog.
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
  removeWorktree,
  scanAfkBranches,
} from './git-worktree-adapter';
import { branchFor } from '../shared/isolation-policy';
import {
  deriveWorktreeRunStates,
  mergeReadinessOnDisk,
} from '../shared/worktree-scan';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

const ALPHA = '02-alpha';
const BETA = '03-beta';

function issueFile(id: string, title: string, status: 'open' | 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# ${id} — ${title}\n\nbody\n`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Simulate the spawned agent finishing in its worktree (uncommitted). */
async function simulateFinished(wt: string, slug: string, id: string): Promise<void> {
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, `src/${slug}.ts`), `export const ${id} = true;\n`);
  await writeFile(join(wt, `issues/${slug}.md`), issueFile(id, slug, 'done'));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-scan-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  // Both issues start `open` on main — what the main-checkout watcher sees.
  await writeFile(join(repo, `issues/${ALPHA}.md`), issueFile('02', 'alpha', 'open'));
  await writeFile(join(repo, `issues/${BETA}.md`), issueFile('03', 'beta', 'open'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: issues 02, 03 open');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('scanAfkBranches — on-disk afk/ state (issue 16)', () => {
  it('returns nothing when the Project has no afk/ branches', async () => {
    expect(await scanAfkBranches(repo)).toEqual([]);
  });

  it('reports a live worktree as running (committed status still open on the branch tip)', async () => {
    await createWorktree(repo, ALPHA, branchFor(ALPHA));

    const scan = await scanAfkBranches(repo);
    expect(scan).toEqual([
      {
        issueId: 2,
        slug: ALPHA,
        hasWorktree: true,
        committedStatus: 'open',
        worktreeStatus: 'open',
        mergedIntoMain: expect.any(Boolean),
      },
    ]);
    // A fresh worktree with no committed `done` and a LIVE Run session is
    // in-flight (issue 22: liveness, not the worktree alone, makes it running).
    expect(deriveWorktreeRunStates(scan, [2])).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'running' },
    ]);
    // No Merge while it's still in flight.
    expect(mergeReadinessOnDisk(scan, [2]).ready).toBe(false);
    // With no live session the very same worktree reads STRANDED, not running
    // forever (corr-1 / state-M3).
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'stranded' },
    ]);
  });

  it('reports a committed-done, unmerged branch as finished-unmerged and mergeable', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    expect((await commitFinishedWorktree(repo, ALPHA)).committed).toBe(true);

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.committedStatus).toBe('done');
    expect(alpha?.hasWorktree).toBe(true);
    expect(alpha?.mergedIntoMain).toBe(false);

    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
    ]);
    const plan = mergeReadinessOnDisk(scan);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable).toEqual([{ issueId: 2, slug: ALPHA }]);
  });

  it('still reports finished-unmerged after the worktree is removed (survives Pane close)', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    await commitFinishedWorktree(repo, ALPHA);
    // Closing the Pane / dropping the Run removes the worktree; the branch stays.
    await removeWorktree(repo, ALPHA);

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.hasWorktree).toBe(false);
    expect(alpha?.committedStatus).toBe('done');

    // The Merge is still offered from disk alone — the whole point of issue 16.
    const plan = mergeReadinessOnDisk(scan);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.slug)).toEqual([ALPHA]);
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
    ]);
  });

  it('withholds the Merge while one sibling is finished but another is still running', async () => {
    const alphaWt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(alphaWt, ALPHA, '02');
    await commitFinishedWorktree(repo, ALPHA);
    // Beta is still in flight (worktree open, nothing committed done) and its
    // Run session is live (issue 3).
    await createWorktree(repo, BETA, branchFor(BETA));

    const scan = await scanAfkBranches(repo);
    expect(deriveWorktreeRunStates(scan, [3])).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
      { issueId: 3, slug: BETA, kind: 'running' },
    ]);
    const plan = mergeReadinessOnDisk(scan, [3]);
    expect(plan.ready).toBe(false);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([2]);
    expect(plan.pendingRunning).toEqual([3]);
  });

  it('a stranded worktree (ended, uncommitted) does not block a finished sibling Merge (issue 22)', async () => {
    // Alpha finished and committed → mergeable.
    const alphaWt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(alphaWt, ALPHA, '02');
    await commitFinishedWorktree(repo, ALPHA);
    // Beta has a worktree with uncommitted work but its Run has ENDED (no live
    // session id passed) — the exact case that used to suppress Merge forever.
    const betaWt = await createWorktree(repo, BETA, branchFor(BETA));
    await writeFile(join(betaWt, `issues/${BETA}.md`), issueFile('03', 'beta', 'wip'));

    const scan = await scanAfkBranches(repo);
    const beta = scan.find((b) => b.slug === BETA);
    expect(beta?.hasWorktree).toBe(true);
    expect(beta?.committedStatus).toBe('open'); // nothing committed on the branch tip
    expect(beta?.worktreeStatus).toBe('wip'); // working-tree edit, uncommitted

    // With no live session, beta is stranded (not running) and does NOT gate Merge.
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
      { issueId: 3, slug: BETA, kind: 'stranded' },
    ]);
    const plan = mergeReadinessOnDisk(scan);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([2]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('detects a commit-failed Run: worktree done, branch tip not (issue 22)', async () => {
    // The agent finished in the worktree (done in the working tree) but the
    // auto-commit never landed — so the branch tip still reads the pre-Run status.
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02'); // writes done into the WORKING tree only

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.worktreeStatus).toBe('done');
    expect(alpha?.committedStatus).toBe('open'); // never committed

    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'commit-failed' },
    ]);
    // A commit-failed Run isn't mergeable and doesn't block a sibling either.
    expect(mergeReadinessOnDisk(scan).pendingRunning).toEqual([]);
  });

  it('excludes an afk branch already merged into main', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    await commitFinishedWorktree(repo, ALPHA);
    await removeWorktree(repo, ALPHA);
    // Integrate it into main (as a clean Merge would).
    await git(repo, 'merge', '--no-ff', '-m', 'merge alpha', branchFor(ALPHA));

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.mergedIntoMain).toBe(true);
    // Merged work is neither in flight nor awaiting merge.
    expect(deriveWorktreeRunStates(scan)).toEqual([]);
    expect(mergeReadinessOnDisk(scan).ready).toBe(false);
  });
});
