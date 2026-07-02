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
        mergedIntoMain: expect.any(Boolean),
      },
    ]);
    // A fresh worktree with no committed `done` is an in-flight Run.
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'running' },
    ]);
    // No Merge while it's still in flight.
    expect(mergeReadinessOnDisk(scan).ready).toBe(false);
  });

  it('reports a committed-done, unmerged branch as finished-unmerged and mergeable', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    expect(await commitFinishedWorktree(repo, ALPHA)).toBe(true);

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
    // Beta is still in flight (worktree open, nothing committed done).
    await createWorktree(repo, BETA, branchFor(BETA));

    const scan = await scanAfkBranches(repo);
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
      { issueId: 3, slug: BETA, kind: 'running' },
    ]);
    const plan = mergeReadinessOnDisk(scan);
    expect(plan.ready).toBe(false);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([2]);
    expect(plan.pendingRunning).toEqual([3]);
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
