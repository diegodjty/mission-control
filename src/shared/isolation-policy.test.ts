import { describe, it, expect } from 'vitest';
import {
  decideIsolation,
  reconcile,
  branchFor,
  type IsolationRun,
  type IsolationState,
} from './isolation-policy';

const run = (issueId: number, slug: string): IsolationRun => ({ issueId, slug });

describe('decideIsolation — solo vs parallel', () => {
  it('an empty set is solo with no placements', () => {
    const d = decideIsolation([]);
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([]);
  });

  it('a lone Run works on main, no worktree (solo)', () => {
    const d = decideIsolation([run(3, '03-run-issue-in-pane')]);
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-run-issue-in-pane', placement: { kind: 'main' } },
    ]);
  });

  it('a second concurrent Run enables parallel and gives each a worktree', () => {
    const d = decideIsolation([
      run(4, '04-dependency-graph-map'),
      run(3, '03-run-issue-in-pane'),
    ]);
    expect(d.parallel).toBe(true);
    // sorted ascending by issueId
    expect(d.placements).toEqual([
      {
        issueId: 3,
        slug: '03-run-issue-in-pane',
        placement: { kind: 'worktree', branch: 'afk/03-run-issue-in-pane' },
      },
      {
        issueId: 4,
        slug: '04-dependency-graph-map',
        placement: { kind: 'worktree', branch: 'afk/04-dependency-graph-map' },
      },
    ]);
  });

  it('three concurrent Runs are all isolated', () => {
    const d = decideIsolation([run(1, 'a'), run(2, 'b'), run(3, 'c')]);
    expect(d.parallel).toBe(true);
    expect(d.placements.map((p) => p.placement.kind)).toEqual([
      'worktree',
      'worktree',
      'worktree',
    ]);
  });

  it('is deterministic — same input yields the same decision', () => {
    const runs = [run(2, 'b'), run(1, 'a')];
    expect(decideIsolation(runs)).toEqual(decideIsolation(runs));
  });
});

describe('branchFor', () => {
  it('is the afk/NN-slug branch', () => {
    expect(branchFor('07-parallel-worktree-isolation')).toBe(
      'afk/07-parallel-worktree-isolation',
    );
  });
});

const solo: IsolationState = { parallel: false, worktreeSlugs: [] };

describe('reconcile — transitions', () => {
  it('solo → parallel: enable then create a worktree for each Run', () => {
    const desired = decideIsolation([run(1, 'a'), run(2, 'b')]);
    expect(reconcile(solo, desired)).toEqual([
      { type: 'enable-parallel' },
      { type: 'create-worktree', issueId: 1, slug: 'a', branch: 'afk/a' },
      { type: 'create-worktree', issueId: 2, slug: 'b', branch: 'afk/b' },
    ]);
  });

  it('parallel → solo: the lone survivor moves back to main, so BOTH worktrees go', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    // Down to a single active Run — solo means it works on main, no worktree,
    // so even the surviving Run's worktree is torn down.
    const desired = decideIsolation([run(1, 'a')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'remove-worktree', slug: 'a', branch: 'afk/a' },
      { type: 'remove-worktree', slug: 'b', branch: 'afk/b' },
      { type: 'disable-parallel' },
    ]);
  });

  it('parallel → zero runs: remove all worktrees and disable parallel', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    const desired = decideIsolation([]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'remove-worktree', slug: 'a', branch: 'afk/a' },
      { type: 'remove-worktree', slug: 'b', branch: 'afk/b' },
      { type: 'disable-parallel' },
    ]);
  });

  it('adds a worktree for a Run that joins an already-parallel set', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    const desired = decideIsolation([run(1, 'a'), run(2, 'b'), run(3, 'c')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'create-worktree', issueId: 3, slug: 'c', branch: 'afk/c' },
    ]);
  });

  it('removes only the departed worktree when still 2+ remain', () => {
    const current: IsolationState = {
      parallel: true,
      worktreeSlugs: ['a', 'b', 'c'],
    };
    const desired = decideIsolation([run(1, 'a'), run(3, 'c')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'remove-worktree', slug: 'b', branch: 'afk/b' },
    ]);
  });

  it('is a no-op when the disk already matches the desired parallel state', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    const desired = decideIsolation([run(1, 'a'), run(2, 'b')]);
    expect(reconcile(current, desired)).toEqual([]);
  });

  it('is a no-op when the disk already matches the desired solo state', () => {
    const desired = decideIsolation([run(1, 'a')]);
    expect(reconcile(solo, desired)).toEqual([]);
  });

  it('does not re-enable parallel that is already on, nor recreate existing worktrees', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a'] };
    const desired = decideIsolation([run(1, 'a'), run(2, 'b')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'create-worktree', issueId: 2, slug: 'b', branch: 'afk/b' },
    ]);
  });
});
