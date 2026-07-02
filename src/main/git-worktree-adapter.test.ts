/**
 * Integration check for the Git/Worktree Adapter (PRD Testing Decisions:
 * adapters are verified by integration/manual runs, not unit tests). This
 * exercises REAL git worktree operations against a throwaway scratch repo in a
 * temp dir — never the real project, never the backlog — proving that the
 * commands the Isolation Policy emits actually create and remove worktrees and
 * toggle parallel mode on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyIsolation,
  currentState,
  createWorktree,
  removeWorktree,
  listWorktreeSlugs,
  isParallel,
  worktreePathFor,
  worktreeBase,
} from './git-worktree-adapter';
import { branchFor, decideIsolation, reconcile } from '../shared/isolation-policy';

const exec = promisify(execFile);

let scratch: string; // parent dir; the repo lives at scratch/repo
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-worktree-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# scratch repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('createWorktree / removeWorktree (real git)', () => {
  it('creates a worktree on afk/<slug> and lists it, then removes it cleanly', async () => {
    const slug = '03-run-issue-in-pane';
    const path = await createWorktree(repo, slug, branchFor(slug));

    // The worktree dir exists at the expected .afk-worktrees/<slug> location...
    expect(path).toBe(worktreePathFor(repo, slug));
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'README.md'))).toBe(true); // checked-out content

    // ...git knows about it, on the afk/<slug> branch...
    const list = await git(repo, 'worktree', 'list', '--porcelain');
    expect(list).toContain(`branch refs/heads/${branchFor(slug)}`);
    expect(await listWorktreeSlugs(repo)).toContain(slug);

    // ...and removing it deletes the dir but keeps the branch.
    await removeWorktree(repo, slug);
    expect(existsSync(path)).toBe(false);
    expect(await listWorktreeSlugs(repo)).not.toContain(slug);
    const branches = await git(repo, 'branch', '--list', branchFor(slug));
    expect(branches).toContain(branchFor(slug)); // branch preserved for Merge (08)
  });

  it('reattaches an existing afk branch instead of failing', async () => {
    const slug = 'redo';
    await createWorktree(repo, slug, branchFor(slug));
    await removeWorktree(repo, slug); // branch afk/redo now exists, no worktree
    // Recreating must not throw ("branch already exists") — it reattaches.
    const path = await createWorktree(repo, slug, branchFor(slug));
    expect(existsSync(path)).toBe(true);
    await removeWorktree(repo, slug);
  });
});

describe('applyIsolation — the full solo↔parallel lifecycle (real git)', () => {
  const run = (issueId: number, slug: string) => ({ issueId, slug });

  it('a lone Run stays on main with no worktree and no parallel flag', async () => {
    const result = await applyIsolation(repo, [run(3, '03-a')]);
    expect(result.parallel).toBe(false);
    expect(result.placements).toEqual([
      { issueId: 3, slug: '03-a', cwd: repo, branch: null },
    ]);
    expect(isParallel(repo)).toBe(false);
    expect(existsSync(worktreeBase(repo))).toBe(false);
  });

  it('a second concurrent Run enables parallel and gives each a real worktree', async () => {
    const result = await applyIsolation(repo, [run(3, '03-a'), run(4, '04-b')]);

    expect(result.parallel).toBe(true);
    expect(isParallel(repo)).toBe(true); // issues/.afk-parallel written
    for (const placed of result.placements) {
      expect(placed.branch).toBe(branchFor(placed.slug));
      expect(placed.cwd).toBe(worktreePathFor(repo, placed.slug));
      expect(existsSync(placed.cwd)).toBe(true); // worktree actually on disk
    }
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['03-a', '04-b']);
  });

  it('dropping back to a single Run removes worktrees and returns to solo', async () => {
    await applyIsolation(repo, [run(3, '03-a'), run(4, '04-b')]);
    expect((await listWorktreeSlugs(repo)).length).toBe(2);

    // Run 04 is gone; only 03 remains active → solo on main again.
    const result = await applyIsolation(repo, [run(3, '03-a')]);
    expect(result.parallel).toBe(false);
    expect(result.placements).toEqual([
      { issueId: 3, slug: '03-a', cwd: repo, branch: null },
    ]);
    expect(isParallel(repo)).toBe(false); // flag removed
    expect(await listWorktreeSlugs(repo)).toEqual([]); // both worktrees gone
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(false);
  });

  it('is idempotent — re-applying the same parallel set makes no further changes', async () => {
    await applyIsolation(repo, [run(3, '03-a'), run(4, '04-b')]);
    // Reconcile should now be a no-op against the same desired state.
    const state = await currentState(repo);
    expect(reconcile(state, decideIsolation([run(3, '03-a'), run(4, '04-b')]))).toEqual(
      [],
    );
    // And re-applying still yields the same worktrees.
    await applyIsolation(repo, [run(3, '03-a'), run(4, '04-b')]);
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['03-a', '04-b']);
  });
});
