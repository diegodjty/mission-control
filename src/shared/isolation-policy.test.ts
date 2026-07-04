import { describe, it, expect } from 'vitest';
import {
  decideIsolation,
  decideIsolationByRepo,
  decideIsolationWith,
  isolationRunSetWith,
  reconcile,
  canFallBackToMain,
  branchFor,
  commitMessageForRun,
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

describe('decideIsolationWith — the manual "▶ Run" path (issue 20)', () => {
  it('a single manual Run (nothing else live) stays solo on main', () => {
    const d = decideIsolationWith([], run(3, '03-run-issue-in-pane'));
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-run-issue-in-pane', placement: { kind: 'main' } },
    ]);
  });

  it('a second manual Run started while one is active isolates BOTH into worktrees', () => {
    // One Run already live; the user hits ▶ Run on another issue.
    const d = decideIsolationWith(
      [run(3, '03-run-issue-in-pane')],
      run(4, '04-dependency-graph-map'),
    );
    expect(d.parallel).toBe(true);
    // Neither Run is left on the shared main checkout — each gets a worktree.
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
    expect(d.placements.every((p) => p.placement.kind === 'worktree')).toBe(true);
  });

  it('re-triggering an already-live issue does not double-count it (stays solo)', () => {
    // Clicking Run again on the only live issue must not fabricate a second Run
    // and flip the lone Run into a needless worktree.
    const d = decideIsolationWith(
      [run(3, '03-run-issue-in-pane')],
      run(3, '03-run-issue-in-pane'),
    );
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-run-issue-in-pane', placement: { kind: 'main' } },
    ]);
  });

  it('isolationRunSetWith dedupes and sorts the resulting concurrency set', () => {
    expect(
      isolationRunSetWith([run(4, 'd'), run(2, 'b')], run(3, 'c')),
    ).toEqual([run(2, 'b'), run(3, 'c'), run(4, 'd')]);
    // Adding a Run already in the set is a no-op on the set (still sorted).
    expect(isolationRunSetWith([run(4, 'd'), run(2, 'b')], run(2, 'b'))).toEqual([
      run(2, 'b'),
      run(4, 'd'),
    ]);
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

  it('down to a single owned Run: only that Run’s worktree is removed; a leftover stays', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    // The decision owns only Run `a` (solo, back to main). `b` is not in this
    // set — a leftover from a previous batch (issue 28), so its worktree AND its
    // branch are left intact for a pending Merge, and its presence keeps
    // parallel mode on rather than disabling it out from under that Merge.
    const desired = decideIsolation([run(1, 'a')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'remove-worktree', slug: 'a', branch: 'afk/a' },
    ]);
  });

  it('an empty decision touches nothing: leftover worktrees + parallel are preserved', () => {
    // A fresh solo drain (no Runs yet in this batch) must never tear down
    // worktrees it did not create or disable parallel mode (issue 28) — those
    // worktrees belong to a previous batch’s pending Merges.
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    const desired = decideIsolation([]);
    expect(reconcile(current, desired)).toEqual([]);
  });

  it('adds a worktree for a Run that joins an already-parallel set', () => {
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a', 'b'] };
    const desired = decideIsolation([run(1, 'a'), run(2, 'b'), run(3, 'c')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'create-worktree', issueId: 3, slug: 'c', branch: 'afk/c' },
    ]);
  });

  it('leaves a worktree the decision does not own intact even while 2+ remain', () => {
    // `b` is on disk but not in the decision {a, c}: a leftover, not this batch’s
    // to remove (issue 28). Both owned Runs already have worktrees, so there is
    // nothing to do — `b` survives for its pending Merge.
    const current: IsolationState = {
      parallel: true,
      worktreeSlugs: ['a', 'b', 'c'],
    };
    const desired = decideIsolation([run(1, 'a'), run(3, 'c')]);
    expect(reconcile(current, desired)).toEqual([]);
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

describe('reconcile — leftover worktrees survive an unrelated Run (issue 28)', () => {
  it('a fresh solo Run beside leftover worktrees removes nothing and keeps parallel on', () => {
    // A previous batch left finished-unmerged worktrees `x`, `y` on disk with
    // `.afk-parallel` still set (pending Merge). Now a single new Run `n` starts
    // solo. It must NOT remove `x`/`y` (they belong to the pending Merge) nor
    // disable parallel mode as a side effect — the acceptance criterion here.
    const current: IsolationState = { parallel: true, worktreeSlugs: ['x', 'y'] };
    const desired = decideIsolation([run(9, 'n')]);
    expect(desired.parallel).toBe(false); // the new Run itself is solo on main
    expect(reconcile(current, desired)).toEqual([]);
  });

  it('an owned Run may still be created alongside preserved leftovers', () => {
    // Two owned Runs go parallel; a leftover `z` from a prior batch is untouched.
    const current: IsolationState = { parallel: true, worktreeSlugs: ['z'] };
    const desired = decideIsolation([run(1, 'a'), run(2, 'b')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'create-worktree', issueId: 1, slug: 'a', branch: 'afk/a' },
      { type: 'create-worktree', issueId: 2, slug: 'b', branch: 'afk/b' },
    ]);
  });

  it('disables parallel only once the batch’s own worktrees are the only ones gone', () => {
    // No leftovers: the batch’s single owned worktree is torn down and, with the
    // disk now empty, parallel mode is correctly disabled.
    const current: IsolationState = { parallel: true, worktreeSlugs: ['a'] };
    const desired = decideIsolation([run(1, 'a')]);
    expect(reconcile(current, desired)).toEqual([
      { type: 'remove-worktree', slug: 'a', branch: 'afk/a' },
      { type: 'disable-parallel' },
    ]);
  });
});

describe('canFallBackToMain — isolation-failure safety (issue 28)', () => {
  it('allows a lone Run to fall back to main', () => {
    expect(canFallBackToMain(0)).toBe(true);
    expect(canFallBackToMain(1)).toBe(true);
  });

  it('refuses the fallback for 2+ concurrent Runs (the concurrent-main collision)', () => {
    expect(canFallBackToMain(2)).toBe(false);
    expect(canFallBackToMain(5)).toBe(false);
  });
});

describe('commitMessageForRun (issue 15 — auto-commit message)', () => {
  it('names the issue number and descriptive slug from an NN-slug stem', () => {
    expect(commitMessageForRun('04-tracer-bullet')).toBe(
      'afk: complete issue 04 — tracer-bullet',
    );
  });

  it('preserves a multi-hyphen descriptive slug', () => {
    expect(commitMessageForRun('15-commit-finished-worktree-runs')).toBe(
      'afk: complete issue 15 — commit-finished-worktree-runs',
    );
  });

  it('falls back gracefully when the slug has no NN- prefix', () => {
    expect(commitMessageForRun('adhoc-fix')).toBe('afk: complete issue — adhoc-fix');
  });
});

describe('decideIsolationByRepo (issue 72, ADR-0015 — per-repo concurrency)', () => {
  const DEFAULT = '/repos/default';

  it('keeps two concurrent Runs in DIFFERENT repos solo — no worktrees', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-a', repoPath: '/repos/a' },
        { issueId: 2, slug: '02-b', repoPath: '/repos/b' },
      ],
      DEFAULT,
    );
    expect(groups.map((g) => g.repoPath)).toEqual(['/repos/a', '/repos/b']);
    for (const group of groups) {
      expect(group.decision.parallel).toBe(false);
      expect(group.decision.placements).toHaveLength(1);
      expect(group.decision.placements[0].placement).toEqual({ kind: 'main' });
    }
  });

  it('isolates 2+ Runs in the SAME repo exactly as decideIsolation does', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 2, slug: '02-b', repoPath: '/repos/a' },
        { issueId: 1, slug: '01-a', repoPath: '/repos/a' },
      ],
      DEFAULT,
    );
    expect(groups).toHaveLength(1);
    const { decision } = groups[0];
    expect(decision.parallel).toBe(true);
    expect(decision.placements.map((p) => p.placement)).toEqual([
      { kind: 'worktree', branch: 'afk/01-a' },
      { kind: 'worktree', branch: 'afk/02-b' },
    ]);
  });

  it('mixes per-repo: the contended repo isolates, the lone repo stays solo', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-a', repoPath: '/repos/a' },
        { issueId: 2, slug: '02-b', repoPath: '/repos/a' },
        { issueId: 3, slug: '03-c', repoPath: '/repos/b' },
      ],
      DEFAULT,
    );
    expect(groups).toHaveLength(2);
    const [a, b] = groups;
    expect(a.repoPath).toBe('/repos/a');
    expect(a.decision.parallel).toBe(true);
    expect(b.repoPath).toBe('/repos/b');
    expect(b.decision.parallel).toBe(false);
  });

  it('groups Runs without a repoPath into the default repo (legacy behavior)', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-a' },
        { issueId: 2, slug: '02-b' },
      ],
      DEFAULT,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].repoPath).toBe(DEFAULT);
    expect(groups[0].decision.parallel).toBe(true);
  });

  it('is deterministic: groups sorted by repoPath, runs ascending by issueId', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 9, slug: '09-z', repoPath: '/repos/b' },
        { issueId: 3, slug: '03-c', repoPath: '/repos/a' },
        { issueId: 1, slug: '01-a', repoPath: '/repos/b' },
      ],
      DEFAULT,
    );
    expect(groups.map((g) => g.repoPath)).toEqual(['/repos/a', '/repos/b']);
    expect(groups[1].runs.map((r) => r.issueId)).toEqual([1, 9]);
  });
});
