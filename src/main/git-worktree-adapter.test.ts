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
import { mkdtemp, mkdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  applyIsolation,
  currentState,
  createWorktree,
  provisionWorktree,
  removeWorktree,
  discardWorktree,
  enableParallel,
  listWorktreeSlugs,
  isParallel,
  worktreePathFor,
  worktreeBase,
} from './git-worktree-adapter';
import {
  branchFor,
  decideIsolation,
  isolationRunSetWith,
  reconcile,
} from '../shared/isolation-policy';

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

describe('worktree provisioning — copy the main checkout node_modules (issue 136, real git+fs)', () => {
  const slug = '06-provision';

  /** Seed a realistic `node_modules` in the MAIN checkout: a nested dep file and
   *  a `.bin` symlink (the shape a real install has), all UNCOMMITTED. */
  async function seedMainNodeModules(): Promise<void> {
    await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(repo, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => "installed";\n',
    );
    await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
    // A relative symlink like a real `.bin` shim — must survive as a symlink.
    await symlink('../left-pad/index.js', join(repo, 'node_modules', '.bin', 'left-pad'));
  }

  it('a repo WITH node_modules yields a worktree whose deps are present (no install needed)', async () => {
    await seedMainNodeModules();
    const wt = await createWorktree(repo, slug, branchFor(slug));

    // The dep the "test command" would need is on disk in the worktree — the
    // provisioning ran as part of cutting the worktree, no network install.
    expect(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

    // The provisioned node_modules is a REAL directory, not the self-referential
    // symlink that corrupted main (issue 98)...
    expect((await lstat(join(wt, 'node_modules'))).isDirectory()).toBe(true);
    // ...and the inner `.bin` shim was preserved AS a symlink, not dereferenced.
    expect((await lstat(join(wt, 'node_modules', '.bin', 'left-pad'))).isSymbolicLink()).toBe(true);
  });

  it('a repo WITHOUT node_modules provisions nothing and does not throw', async () => {
    // No node_modules in the main checkout (a non-Node repo) — a silent skip.
    const wt = await createWorktree(repo, slug, branchFor(slug));
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);

    // provisionWorktree is a clean no-op that reports nothing was copied.
    expect(await provisionWorktree(repo, wt)).toEqual([]);
  });

  it('provisionWorktree reports what it copied and is idempotent', async () => {
    await seedMainNodeModules();
    // createWorktree already provisioned once; a direct re-call finds the dir
    // present and copies nothing (never overwrites, never errors).
    const wt = await createWorktree(repo, slug, branchFor(slug));
    expect(await provisionWorktree(repo, wt)).toEqual([]);

    // Remove the provisioned dir and re-call: now it reports the copy it made.
    await rm(join(wt, 'node_modules'), { recursive: true, force: true });
    expect(await provisionWorktree(repo, wt)).toEqual(['node_modules']);
    expect(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('the provisioned node_modules stays IGNORED/uncommitted on the afk branch', async () => {
    // A real Node repo commits a .gitignore that ignores node_modules; the
    // worktree inherits it (checked out from main), so the provisioned install
    // never dirties the tree nor enters the afk branch.
    await writeFile(join(repo, '.gitignore'), 'node_modules\n');
    await git(repo, 'add', '.gitignore');
    await git(repo, 'commit', '-m', 'ignore node_modules');
    await seedMainNodeModules();

    const wt = await createWorktree(repo, slug, branchFor(slug));
    expect(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

    // The worktree working tree is CLEAN — node_modules is ignored, so it shows
    // no untracked change (nothing to trip the merge preflight)...
    const porcelain = (await git(wt, 'status', '--porcelain')).trim();
    expect(porcelain).toBe('');
    // ...and nothing under node_modules is tracked on the afk/<slug> branch.
    const tracked = (await git(wt, 'ls-files')).split('\n');
    expect(tracked.some((p) => p.split('/').includes('node_modules'))).toBe(false);
  });
});

describe('discardWorktree — recover a stranded Run (issue 22, real git)', () => {
  it('force-removes a worktree with uncommitted work AND deletes its branch', async () => {
    const slug = '05-stranded';
    const path = await createWorktree(repo, slug, branchFor(slug));
    // Simulate a stranded Run: uncommitted work in the worktree, and a plain
    // (non-force) remove would REFUSE — which is exactly why discard force-removes.
    await writeFile(join(path, 'README.md'), '# scratch repo\n\npartial, never committed\n');
    await expect(removeWorktree(repo, slug)).rejects.toThrow();

    await discardWorktree(repo, slug);

    // The worktree dir is gone, git no longer lists it, and the branch is deleted
    // so it stops cluttering the Map / blocking the batch.
    expect(existsSync(path)).toBe(false);
    expect(await listWorktreeSlugs(repo)).not.toContain(slug);
    const branches = await git(repo, 'branch', '--list', branchFor(slug));
    expect(branches.trim()).toBe('');
  });

  it('is idempotent — discarding an already-gone Run does not throw', async () => {
    const slug = '06-none';
    // Never created — discard must be a clean no-op, not an error.
    await expect(discardWorktree(repo, slug)).resolves.toBeUndefined();

    // And a second discard after a real one is also safe.
    await createWorktree(repo, slug, branchFor(slug));
    await discardWorktree(repo, slug);
    await expect(discardWorktree(repo, slug)).resolves.toBeUndefined();
    expect(await listWorktreeSlugs(repo)).not.toContain(slug);
  });
});

describe('enableParallel — the .afk-parallel marker never dirties the repo (issue 18)', () => {
  async function porcelain(): Promise<string> {
    return (await git(repo, 'status', '--porcelain')).trim();
  }

  it('writes the marker but leaves the working tree clean (locally ignored)', async () => {
    await enableParallel(repo);

    // The marker is on disk...
    expect(isParallel(repo)).toBe(true);
    // ...but git does not see it as a change — the tree is clean, so the merge
    // preflight (afk-merge.sh) is not blocked by the marker's presence.
    expect(await porcelain()).toBe('');

    // And it landed in .git/info/exclude exactly once.
    const excludePath = join(repo, '.git', 'info', 'exclude');
    const exclude = await readFile(excludePath, 'utf8');
    const hits = exclude
      .split('\n')
      .filter((line) => line.trim() === 'issues/.afk-parallel').length;
    expect(hits).toBe(1);
  });

  it('is idempotent — re-enabling does not double-append the exclude entry', async () => {
    await enableParallel(repo);
    await enableParallel(repo);
    await enableParallel(repo);

    expect(await porcelain()).toBe(''); // still clean
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const hits = exclude
      .split('\n')
      .filter((line) => line.trim() === 'issues/.afk-parallel').length;
    expect(hits).toBe(1); // added once, never duplicated
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

  it('an unisolatable workspace root: 2+ Runs stay solo there, no worktrees (issue 94, ADR-0017)', async () => {
    // A repo-less project's workspace root is a plain (non-git) directory. Two
    // no-repo Runs must serialize solo IN that directory — never attempt a git
    // worktree against a non-repo (which would throw) — so a scaffold Run lands
    // in the workspace root itself.
    const workspace = join(scratch, 'workspace');
    await mkdir(workspace, { recursive: true });

    const result = await applyIsolation(
      workspace,
      [run(1, '01-scaffold-api'), run(2, '02-scaffold-web')],
      { isolatable: false },
    );

    expect(result.parallel).toBe(false);
    expect(result.placements).toEqual([
      { issueId: 1, slug: '01-scaffold-api', cwd: workspace, branch: null },
      { issueId: 2, slug: '02-scaffold-web', cwd: workspace, branch: null },
    ]);
    // No worktrees cut from the non-git directory, no parallel flag written.
    expect(existsSync(worktreeBase(workspace))).toBe(false);
    expect(isParallel(workspace)).toBe(false);
  });

  it('the surviving Run returns to main, but a dropped Run’s worktree is preserved (issue 28)', async () => {
    await applyIsolation(repo, [run(3, '03-a'), run(4, '04-b')]);
    expect((await listWorktreeSlugs(repo)).length).toBe(2);

    // Only 03 remains in the set → 03 goes solo on main and its worktree is torn
    // down. 04-b is NOT in this batch’s set: reconcile must leave its worktree
    // AND keep parallel mode on, because an unmerged branch still awaits a Merge
    // — tearing it down here is the concurrent-main-cascade bug issue 28 fixes.
    const result = await applyIsolation(repo, [run(3, '03-a')]);
    expect(result.parallel).toBe(false); // the batch’s own Run is solo
    expect(result.placements).toEqual([
      { issueId: 3, slug: '03-a', cwd: repo, branch: null },
    ]);
    expect(isParallel(repo)).toBe(true); // flag kept — 04-b awaits Merge
    expect(await listWorktreeSlugs(repo)).toEqual(['04-b']); // 03 gone, 04 kept
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(false);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(true);
  });

  it('a fresh solo Run leaves a previous batch’s leftover worktree + parallel intact (issue 28)', async () => {
    // Simulate a leftover from a previous batch: a worktree on disk that this
    // batch never surfaced, with parallel mode still set (a pending Merge).
    await applyIsolation(repo, [run(4, '04-b'), run(5, '05-c')]);
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['04-b', '05-c']);

    // A brand-new SOLO Run starts (only 09 in its set). It must not remove the
    // leftover worktrees nor disable parallel mode out from under their Merge.
    const result = await applyIsolation(repo, [run(9, '09-n')]);
    expect(result.parallel).toBe(false); // the new Run itself is solo on main
    expect(result.placements).toEqual([
      { issueId: 9, slug: '09-n', cwd: repo, branch: null },
    ]);
    expect(isParallel(repo)).toBe(true); // leftovers keep parallel mode on
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['04-b', '05-c']);
  });

  it('the MANUAL path: a lone Run runs on main, then a second isolates BOTH (issue 20)', async () => {
    // First manual "▶ Run": the only live Run → solo on main, no worktree.
    const first = await applyIsolation(
      repo,
      isolationRunSetWith([], run(3, '03-a')),
    );
    expect(first.parallel).toBe(false);
    expect(first.placements).toEqual([
      { issueId: 3, slug: '03-a', cwd: repo, branch: null },
    ]);
    expect(existsSync(worktreeBase(repo))).toBe(false);

    // Second manual "▶ Run" while the first is still active → BOTH isolate into
    // worktrees; neither is left on the shared main checkout. This composes the
    // manual path's set-builder with real git exactly as startRun does.
    const active = [run(3, '03-a')]; // the first Run, still live
    const second = await applyIsolation(
      repo,
      isolationRunSetWith(active, run(4, '04-b')),
    );
    expect(second.parallel).toBe(true);
    expect(isParallel(repo)).toBe(true);
    for (const placed of second.placements) {
      expect(placed.cwd).toBe(worktreePathFor(repo, placed.slug));
      expect(placed.cwd).not.toBe(repo); // NEITHER Run runs on main
      expect(existsSync(placed.cwd)).toBe(true);
    }
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['03-a', '04-b']);
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
