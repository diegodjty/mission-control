import { describe, it, expect } from 'vitest';
import {
  afkScanUnchanged,
  classifyBranch,
  deriveWorktreeRunStates,
  dropMergedBranches,
  markBranchCommitted,
  mergeReadinessOnDisk,
  needsWorktreeCommit,
  issueIdFromSlug,
  type AfkBranchFacts,
} from './worktree-scan';

const branch = (
  issueId: number,
  overrides: Partial<Omit<AfkBranchFacts, 'issueId' | 'slug'>> = {},
): AfkBranchFacts => ({
  issueId,
  slug: `${String(issueId).padStart(2, '0')}-x`,
  hasWorktree: false,
  committedStatus: null,
  worktreeStatus: null,
  mergedIntoMain: false,
  ...overrides,
});

describe('issueIdFromSlug', () => {
  it('parses the leading issue number from a NN-slug stem', () => {
    expect(issueIdFromSlug('04-tracer-bullet')).toBe(4);
    expect(issueIdFromSlug('16-map-progress')).toBe(16);
  });
});

describe('classifyBranch — in-flight vs stranded vs commit-failed (issue 22)', () => {
  it('is running only while a live Run session drives its worktree', () => {
    const f = branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' });
    expect(classifyBranch(f, [3])).toBe('running');
  });

  it('is stranded once the Run session has ended (blocked/stopped/exited)', () => {
    // Same on-disk facts, but no live session drives it any more — the exact
    // case that used to read `running` forever (corr-1 / state-M3).
    const f = branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' });
    expect(classifyBranch(f, [])).toBe('stranded');
  });

  it('is commit-failed when the agent finished but the done never committed', () => {
    // worktree working tree says done, but the branch tip does not (corr-5).
    const f = branch(4, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' });
    // Liveness is irrelevant: the work is done, only the commit is missing.
    expect(classifyBranch(f, [4])).toBe('commit-failed');
    expect(classifyBranch(f, [])).toBe('commit-failed');
  });

  it('is finished-unmerged once the done is committed on the branch', () => {
    const f = branch(4, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' });
    expect(classifyBranch(f, [4])).toBe('finished-unmerged');
  });

  it('contributes nothing when already merged into main, or a bare branch', () => {
    expect(
      classifyBranch(branch(4, { committedStatus: 'done', mergedIntoMain: true }), []),
    ).toBeNull();
    // Bare branch: no worktree, nothing committed-done → no Map indicator.
    expect(classifyBranch(branch(5, { hasWorktree: false, committedStatus: 'wip' }), [])).toBeNull();
  });
});

describe('deriveWorktreeRunStates', () => {
  it('marks a live worktree with no committed done as running (in-worktree)', () => {
    const states = deriveWorktreeRunStates(
      [branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' })],
      [3],
    );
    expect(states).toEqual([{ issueId: 3, slug: '03-x', kind: 'running' }]);
  });

  it('marks a worktree whose Run has ended as stranded, not running', () => {
    const states = deriveWorktreeRunStates([
      branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
    ]);
    expect(states).toEqual([{ issueId: 3, slug: '03-x', kind: 'stranded' }]);
  });

  it('marks a finished-but-uncommitted worktree as commit-failed', () => {
    const states = deriveWorktreeRunStates([
      branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' }),
    ]);
    expect(states).toEqual([{ issueId: 3, slug: '03-x', kind: 'commit-failed' }]);
  });

  it('marks a committed-done, unmerged branch as finished-unmerged', () => {
    const states = deriveWorktreeRunStates([
      branch(4, {
        hasWorktree: true,
        committedStatus: 'done',
        worktreeStatus: 'done',
        mergedIntoMain: false,
      }),
    ]);
    expect(states).toEqual([{ issueId: 4, slug: '04-x', kind: 'finished-unmerged' }]);
  });

  it('reports finished-unmerged even after the worktree is gone (survives Pane close)', () => {
    const states = deriveWorktreeRunStates([
      branch(4, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: false }),
    ]);
    expect(states).toEqual([{ issueId: 4, slug: '04-x', kind: 'finished-unmerged' }]);
  });

  it('shows nothing for a branch already merged into main', () => {
    expect(
      deriveWorktreeRunStates([
        branch(4, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: true }),
      ]),
    ).toEqual([]);
  });

  it('sorts by issue id and handles a mixed batch', () => {
    const states = deriveWorktreeRunStates(
      [
        branch(5, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' }),
        branch(2, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
        branch(7, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
        branch(8, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' }),
        branch(9, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: true }),
      ],
      [2], // only issue 2 has a live session; 7's ended → stranded
    );
    expect(states).toEqual([
      { issueId: 2, slug: '02-x', kind: 'running' },
      { issueId: 5, slug: '05-x', kind: 'finished-unmerged' },
      { issueId: 7, slug: '07-x', kind: 'stranded' },
      { issueId: 8, slug: '08-x', kind: 'commit-failed' },
    ]);
  });
});

describe('mergeReadinessOnDisk', () => {
  it('offers no Merge when there are no afk branches', () => {
    expect(mergeReadinessOnDisk([])).toEqual({
      ready: false,
      mergeable: [],
      pendingRunning: [],
    });
  });

  it('offers the Merge once every isolated Run is committed-done and none is running', () => {
    const plan = mergeReadinessOnDisk([
      branch(4, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' }),
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable).toEqual([
      { issueId: 3, slug: '03-x' },
      { issueId: 4, slug: '04-x' },
    ]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('withholds the Merge while a sibling Run is still LIVE', () => {
    const plan = mergeReadinessOnDisk(
      [
        branch(3, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' }),
        branch(4, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
      ],
      [4], // issue 4's Run is live → genuinely pending
    );
    expect(plan.ready).toBe(false);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([4]);
  });

  it('does NOT let a stranded (blocked/stopped) sibling suppress the Merge (corr-1)', () => {
    // Issue 4's Run ended without a done commit and no live session drives it.
    // Its finished sibling (3) must still be mergeable — the whole point of 22.
    const plan = mergeReadinessOnDisk([
      branch(3, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' }),
      branch(4, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('does NOT let a commit-failed sibling suppress the Merge (corr-5)', () => {
    const plan = mergeReadinessOnDisk([
      branch(3, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' }),
      branch(4, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('offers the Merge after all Panes closed (committed branches, no worktrees)', () => {
    const plan = mergeReadinessOnDisk([
      branch(2, { hasWorktree: false, committedStatus: 'done' }),
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([2, 3]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('excludes an already-merged branch from the mergeable set', () => {
    const plan = mergeReadinessOnDisk([
      branch(2, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: true }),
      branch(3, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: false }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
  });
});

describe('dropMergedBranches — closes the double-merge race (issue 29)', () => {
  it('removes exactly the merged slugs, leaving the rest untouched', () => {
    const facts = [
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
      branch(4, { hasWorktree: false, committedStatus: 'done' }),
      branch(5, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }),
    ];
    const next = dropMergedBranches(facts, ['03-x', '04-x']);
    expect(next.map((f) => f.issueId)).toEqual([5]);
  });

  it('makes readiness recompute to not-ready synchronously with a full merge (not the poll)', () => {
    // Two finished-unmerged branches: the Merge is offered.
    const before = [
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
      branch(4, { hasWorktree: false, committedStatus: 'done' }),
    ];
    const merged = mergeReadinessOnDisk(before);
    expect(merged.ready).toBe(true);
    expect(merged.mergeable.map((m) => m.slug)).toEqual(['03-x', '04-x']);

    // The instant the merge succeeds we drop those slugs from the SAME scan the
    // button reads — no waiting for the next ~1.5s poll. A rapid second click
    // now sees an empty mergeable set, so it can never target the deleted
    // branches.
    const after = dropMergedBranches(before, merged.mergeable.map((m) => m.slug));
    const replanned = mergeReadinessOnDisk(after);
    expect(replanned.ready).toBe(false);
    expect(replanned.mergeable).toEqual([]);
  });

  it('clears only the merged branch, keeping a stranded sibling that was NOT merged', () => {
    const before = [
      branch(3, { hasWorktree: false, committedStatus: 'done' }), // merged
      branch(4, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' }), // stranded
    ];
    const after = dropMergedBranches(before, ['03-x']);
    // The merged branch is gone; the stranded one remains for the user to resolve.
    expect(deriveWorktreeRunStates(after)).toEqual([{ issueId: 4, slug: '04-x', kind: 'stranded' }]);
    expect(mergeReadinessOnDisk(after).ready).toBe(false);
  });

  it('returns the input unchanged when no slugs were merged', () => {
    const facts = [branch(3, { hasWorktree: false, committedStatus: 'done' })];
    expect(dropMergedBranches(facts, [])).toBe(facts);
  });

  it('does not mutate the input array', () => {
    const facts = [
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
      branch(4, { hasWorktree: false, committedStatus: 'done' }),
    ];
    dropMergedBranches(facts, ['03-x']);
    expect(facts.map((f) => f.issueId)).toEqual([3, 4]);
  });
});

describe('needsWorktreeCommit — the once-only, event-driven commit trigger (issue 30)', () => {
  it('is true exactly on the finished transition: worktree done, branch tip not', () => {
    const f = branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' });
    expect(needsWorktreeCommit(f)).toBe(true);
  });

  it('is false once the done flip is already committed (no re-commit each tick)', () => {
    const f = branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'done' });
    expect(needsWorktreeCommit(f)).toBe(false);
  });

  it('is false while the Run is still in progress (worktree not yet done)', () => {
    const f = branch(3, { hasWorktree: true, worktreeStatus: 'wip', committedStatus: 'wip' });
    expect(needsWorktreeCommit(f)).toBe(false);
  });

  it('is false for a bare branch with no worktree (nothing to commit from)', () => {
    const f = branch(3, { hasWorktree: false, worktreeStatus: null, committedStatus: 'done' });
    expect(needsWorktreeCommit(f)).toBe(false);
  });

  it('matches the on-disk `commit-failed` shape classifyBranch reports', () => {
    // A finished-but-uncommitted worktree is exactly what fires the commit; if it
    // never lands it reads commit-failed, so the trigger and the state agree.
    const f = branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' });
    expect(needsWorktreeCommit(f)).toBe(true);
    expect(classifyBranch(f)).toBe('commit-failed');
  });
});

describe('afkScanUnchanged — value-stable scan across no-change ticks (issue 30)', () => {
  it('is true when two scans carry identical facts (keep the same state identity)', () => {
    const a = [branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' })];
    const b = [branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'wip' })];
    expect(afkScanUnchanged(a, b)).toBe(true);
  });

  it('is false when a committed status changes (a real finished transition)', () => {
    const a = [branch(3, { hasWorktree: true, committedStatus: 'wip', worktreeStatus: 'done' })];
    const b = [branch(3, { hasWorktree: true, committedStatus: 'done', worktreeStatus: 'done' })];
    expect(afkScanUnchanged(a, b)).toBe(false);
  });

  it('is false when a branch appears or disappears', () => {
    const a = [branch(3, { hasWorktree: true })];
    const b = [branch(3, { hasWorktree: true }), branch(4, { hasWorktree: true })];
    expect(afkScanUnchanged(a, b)).toBe(false);
    expect(afkScanUnchanged([], [])).toBe(true);
  });

  it('is false when the worktree presence changes (Pane closed → worktree removed)', () => {
    const a = [branch(3, { hasWorktree: true, committedStatus: 'done' })];
    const b = [branch(3, { hasWorktree: false, committedStatus: 'done' })];
    expect(afkScanUnchanged(a, b)).toBe(false);
  });
});

describe('markBranchCommitted — optimistic commit reflection (issue 30)', () => {
  it('sets committedStatus to done for the given slug so there is no commit-failed flash', () => {
    const before = [branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' })];
    // Before: the branch reads commit-failed (worktree done, tip not).
    expect(deriveWorktreeRunStates(before, [])).toEqual([
      { issueId: 3, slug: '03-x', kind: 'commit-failed' },
    ]);
    const after = markBranchCommitted(before, '03-x');
    // After the optimistic mark it reads finished-unmerged, matching what the next
    // real scan will confirm — no transient commit-failed.
    expect(after[0].committedStatus).toBe('done');
    expect(deriveWorktreeRunStates(after, [])).toEqual([
      { issueId: 3, slug: '03-x', kind: 'finished-unmerged' },
    ]);
  });

  it('returns the input unchanged (same identity) when the slug is absent or already done', () => {
    const facts = [branch(3, { committedStatus: 'done' })];
    expect(markBranchCommitted(facts, '99-nope')).toBe(facts);
    expect(markBranchCommitted(facts, '03-x')).toBe(facts);
  });

  it('does not mutate the input array', () => {
    const facts = [branch(3, { hasWorktree: true, worktreeStatus: 'done', committedStatus: 'wip' })];
    markBranchCommitted(facts, '03-x');
    expect(facts[0].committedStatus).toBe('wip');
  });
});
