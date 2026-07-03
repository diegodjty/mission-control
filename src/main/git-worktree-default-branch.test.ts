/**
 * Integration check for non-`main` default branches (issue 27). Drives REAL git
 * against a throwaway scratch repo initialised on `master` (not `main`) — the
 * exact repo shape that used to break the Merge path: `isMergedIntoMain` ran
 * `merge-base --is-ancestor afk/<slug> main`, which ERRORS when there is no
 * `main` ref, so every branch read as unmerged forever and the Merge affordance
 * never cleared. This proves detection + the merged check now use the repo's
 * actual default branch.
 *
 * Never touches the real project or the real backlog.
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
  detectDefaultBranch,
} from './git-worktree-adapter';
import { branchFor } from '../shared/isolation-policy';
import { deriveWorktreeRunStates, mergeReadinessOnDisk } from '../shared/worktree-scan';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

const ALPHA = '02-alpha';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

function issueFile(id: string, title: string, status: 'open' | 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# ${id} — ${title}\n\nbody\n`;
}

async function simulateFinished(wt: string, slug: string, id: string): Promise<void> {
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, `src/${slug}.ts`), `export const x${id} = true;\n`);
  await writeFile(join(wt, `issues/${slug}.md`), issueFile(id, slug, 'done'));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-defbranch-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  // The whole point: initialise on `master`, NOT `main`.
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, `issues/${ALPHA}.md`), issueFile('02', 'alpha', 'open'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial on master');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('detectDefaultBranch — reads the repo real branch, not a hardcoded main (issue 27)', () => {
  it('detects `master` on a master repo', async () => {
    expect(await detectDefaultBranch(repo)).toBe('master');
  });
});

describe('scanAfkBranches on a master repo — merged detection uses the default branch (issue 27)', () => {
  it('reports a finished, unmerged branch as NOT merged (mergeable)', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    expect((await commitFinishedWorktree(repo, ALPHA)).committed).toBe(true);

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.committedStatus).toBe('done');
    expect(alpha?.mergedIntoMain).toBe(false); // not yet merged into master
    expect(mergeReadinessOnDisk(scan).ready).toBe(true);
    expect(deriveWorktreeRunStates(scan)).toEqual([
      { issueId: 2, slug: ALPHA, kind: 'finished-unmerged' },
    ]);
  });

  it('correctly detects the branch as merged AFTER it is integrated into master — the bug', async () => {
    const wt = await createWorktree(repo, ALPHA, branchFor(ALPHA));
    await simulateFinished(wt, ALPHA, '02');
    await commitFinishedWorktree(repo, ALPHA);
    await removeWorktree(repo, ALPHA);
    // Integrate it into master (as a clean Merge would). Before the fix, the scan
    // compared against `main` (which errors) and this stayed "unmerged" forever.
    await git(repo, 'merge', '--no-ff', '-m', 'merge alpha', branchFor(ALPHA));

    const scan = await scanAfkBranches(repo);
    const alpha = scan.find((b) => b.slug === ALPHA);
    expect(alpha?.mergedIntoMain).toBe(true); // now correctly seen as merged
    // Merged work is neither in flight nor awaiting merge — the Merge affordance clears.
    expect(deriveWorktreeRunStates(scan)).toEqual([]);
    expect(mergeReadinessOnDisk(scan).ready).toBe(false);
  });
});
