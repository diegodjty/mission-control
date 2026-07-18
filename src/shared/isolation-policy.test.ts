import { describe, it, expect } from 'vitest';
import {
  decideIsolation,
  decideIsolationByRepo,
  decideIsolationWith,
  isolationRunSetWith,
  runNeedsIsolation,
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

describe('decideIsolation — dependency chains stay solo (issue 111)', () => {
  const chained = (issueId: number, slug: string): IsolationRun => ({
    issueId,
    slug,
    chained: true,
  });

  it('a chained Run stays on main even when a concurrent independent Run isolates', () => {
    // 3 sits on a dependency chain (chained); 4 is independent. The concurrency
    // is real, so parallel mode is on and 4 gets a worktree — but 3 must build
    // on its dependency's committed work on the integration branch, so it stays
    // solo on `main`, never a worktree cut from a stale base.
    const d = decideIsolation([chained(3, '03-dependent'), run(4, '04-independent')]);
    expect(d.parallel).toBe(true);
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-dependent', placement: { kind: 'main' } },
      {
        issueId: 4,
        slug: '04-independent',
        placement: { kind: 'worktree', branch: 'afk/04-independent' },
      },
    ]);
  });

  it('two Runs on a dependency edge (both chained) stay solo — no parallel mode', () => {
    // A 2-issue chain: both endpoints are chained, so neither takes a worktree
    // and parallel mode is never enabled — they serialize solo on the
    // integration branch (the dependent can't run until the dependency is done).
    const d = decideIsolation([chained(2, '02-a'), chained(3, '03-b')]);
    expect(d.parallel).toBe(false);
    expect(d.placements.map((p) => p.placement.kind)).toEqual(['main', 'main']);
  });

  it('two independent Runs still parallelize into worktrees — no regression', () => {
    // Neither is chained: the pre-issue-111 behavior is unchanged.
    const d = decideIsolation([run(6, '06-parallel-a'), run(7, '07-parallel-b')]);
    expect(d.parallel).toBe(true);
    expect(d.placements.map((p) => p.placement.kind)).toEqual(['worktree', 'worktree']);
  });

  it('a lone chained Run is solo, exactly like any lone Run', () => {
    const d = decideIsolation([chained(3, '03-dependent')]);
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-dependent', placement: { kind: 'main' } },
    ]);
  });

  it('an unisolatable target keeps a chained Run solo too, and clamps to 1 live (issue 157)', () => {
    const d = decideIsolation([chained(3, '03-dependent'), run(4, '04-independent')], {
      isolatable: false,
    });
    expect(d.parallel).toBe(false);
    // Only the lowest issueId (3, chained) is placed live; 4 queues — an
    // unisolatable target has no worktree to give a 2nd Run either way.
    expect(d.placements).toEqual([
      { issueId: 3, slug: '03-dependent', placement: { kind: 'main' } },
    ]);
    expect(d.queuedIssueIds).toEqual([4]);
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

describe('runNeedsIsolation — the isolation-set membership rule (issue 134)', () => {
  it('a live Run on main belongs in the set', () => {
    // Solo but running: it is competing for the working tree right now.
    expect(runNeedsIsolation({ live: true, isolated: false })).toBe(true);
  });

  it('a live Run in a worktree belongs in the set', () => {
    expect(runNeedsIsolation({ live: true, isolated: true })).toBe(true);
  });

  it('a finished-unmerged Run (in a worktree) belongs in the set', () => {
    // The documented exception: its work still lives on an unmerged afk/ branch,
    // so its worktree must survive for the pending Merge — it stays in the set.
    expect(runNeedsIsolation({ live: false, isolated: true })).toBe(true);
  });

  it('a terminal SOLO Run (finished/blocked/parked/stopped on main) is OUT of the set', () => {
    // The bug this closes (issue 134): a terminal Run on `main` is done competing
    // for the working tree and has no worktree to preserve. Feeding it in inflates
    // concurrency and lets a finished chained Run get a spurious worktree cut that
    // keeps `.afk-parallel` stuck on across drain rounds.
    expect(runNeedsIsolation({ live: false, isolated: false })).toBe(false);
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

  it('a chained Run beside a leftover worktree lands on main, leftover kept, parallel on (issue 111)', () => {
    // The reported bug's shape: a leftover worktree `x` from a pending merge
    // keeps `.afk-parallel` on. A dependent Run (3, chained) starts. It must NOT
    // be cut a worktree from the stale integration-branch HEAD — it lands solo
    // on `main` (no create-worktree command for it), the leftover survives, and
    // parallel mode stays on for the pending merge.
    const current: IsolationState = { parallel: true, worktreeSlugs: ['x'] };
    const desired = decideIsolation([
      { issueId: 3, slug: '03-dependent', chained: true },
      { issueId: 9, slug: 'x' },
    ]);
    // 9/x is an independent leftover-owned Run in the set, so parallel stays on…
    expect(desired.parallel).toBe(true);
    // …but nothing is created for the chained Run, and the leftover is untouched.
    expect(reconcile(current, desired)).toEqual([]);
    expect(desired.placements.find((p) => p.issueId === 3)?.placement).toEqual({
      kind: 'main',
    });
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

describe('decideIsolation — unisolatable target serializes solo (issue 94, ADR-0017)', () => {
  it('forces a 2+ Run set solo when the target cannot host worktrees', () => {
    const d = decideIsolation([run(1, '01-a'), run(2, '02-b')], { isolatable: false });
    expect(d.parallel).toBe(false);
    expect(d.placements.map((p) => p.placement)).toEqual([{ kind: 'main' }]);
  });

  it('an unisolatable-target group emits no worktree commands on reconcile', () => {
    const d = decideIsolation([run(1, '01-a'), run(2, '02-b')], { isolatable: false });
    const commands = reconcile({ parallel: false, worktreeSlugs: [] }, d);
    expect(commands).toEqual([]);
  });

  it('an isolatable target (the default) still isolates 2+ Runs into worktrees', () => {
    const d = decideIsolation([run(1, '01-a'), run(2, '02-b')], { isolatable: true });
    expect(d.parallel).toBe(true);
    expect(d.placements.map((p) => p.placement.kind)).toEqual(['worktree', 'worktree']);
    expect(d.queuedIssueIds).toEqual([]);
  });
});

describe('decideIsolation — unisolatable concurrency clamp (issue 157)', () => {
  it('an isolatable::false set of N Runs yields exactly 1 live placement + N-1 queued, regardless of N', () => {
    for (const n of [2, 3, 5]) {
      const runs = Array.from({ length: n }, (_, i) => run(i + 1, `0${i + 1}-issue`));
      const d = decideIsolation(runs, { isolatable: false });
      expect(d.parallel).toBe(false);
      expect(d.placements).toHaveLength(1);
      expect(d.placements[0]).toEqual({
        issueId: 1,
        slug: '01-issue',
        placement: { kind: 'main' },
      });
      expect(d.queuedIssueIds).toEqual(runs.slice(1).map((r) => r.issueId));
    }
  });

  it('a lone Run on an unisolatable target is live, nothing queued', () => {
    const d = decideIsolation([run(9, '09-solo')], { isolatable: false });
    expect(d.placements).toEqual([
      { issueId: 9, slug: '09-solo', placement: { kind: 'main' } },
    ]);
    expect(d.queuedIssueIds).toEqual([]);
  });

  it('an empty set on an unisolatable target is empty, nothing queued', () => {
    const d = decideIsolation([], { isolatable: false });
    expect(d.parallel).toBe(false);
    expect(d.placements).toEqual([]);
    expect(d.queuedIssueIds).toEqual([]);
  });

  it('an isolatable set is unaffected — no queuing ever happens', () => {
    const runs = [run(1, 'a'), run(2, 'b'), run(3, 'c'), run(4, 'd'), run(5, 'e')];
    const d = decideIsolation(runs);
    expect(d.placements).toHaveLength(5);
    expect(d.queuedIssueIds).toEqual([]);
  });
});

describe('decideIsolationByRepo — unisolatable workspace root (issue 94, ADR-0017)', () => {
  const WORKSPACE = '/Users/dev/Developer/billing'; // repo-less project's workspace root

  it('serializes an unisolatable-target group with 2+ Runs to exactly 1 live + rest queued (issue 157)', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-scaffold-api', repoPath: WORKSPACE },
        { issueId: 2, slug: '02-scaffold-web', repoPath: WORKSPACE },
      ],
      WORKSPACE,
      { unisolatablePaths: [WORKSPACE] },
    );
    expect(groups).toHaveLength(1);
    const { decision } = groups[0];
    expect(decision.parallel).toBe(false);
    expect(decision.placements.map((p) => p.placement)).toEqual([{ kind: 'main' }]);
    expect(decision.queuedIssueIds).toEqual([2]);
    // no worktree commands: reconcile against a clean tree is a no-op
    expect(reconcile({ parallel: false, worktreeSlugs: [] }, decision)).toEqual([]);
  });

  it('a real-repo group with 2+ Runs still isolates into worktrees', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-a', repoPath: '/repos/real' },
        { issueId: 2, slug: '02-b', repoPath: '/repos/real' },
      ],
      WORKSPACE,
      { unisolatablePaths: [WORKSPACE] },
    );
    expect(groups[0].decision.parallel).toBe(true);
    expect(groups[0].decision.placements.map((p) => p.placement.kind)).toEqual([
      'worktree',
      'worktree',
    ]);
  });

  it('a no-repo group and a real-repo group run concurrently (different keys)', () => {
    const groups = decideIsolationByRepo(
      [
        { issueId: 1, slug: '01-scaffold', repoPath: WORKSPACE },
        { issueId: 2, slug: '02-feature', repoPath: '/repos/real' },
      ],
      WORKSPACE,
      { unisolatablePaths: [WORKSPACE] },
    );
    // two independent groups — neither blocks the other
    expect(groups).toHaveLength(2);
    const workspaceGroup = groups.find((g) => g.repoPath === WORKSPACE);
    const realGroup = groups.find((g) => g.repoPath === '/repos/real');
    expect(workspaceGroup?.decision.placements[0].placement).toEqual({ kind: 'main' });
    expect(realGroup?.decision.placements[0].placement).toEqual({ kind: 'main' });
    // each is the lone Run in its own key ⇒ both solo, no mutual contention
    expect(workspaceGroup?.decision.parallel).toBe(false);
    expect(realGroup?.decision.parallel).toBe(false);
  });
});
