import { describe, it, expect } from 'vitest';
import {
  classifyBranch,
  deriveWorktreeRunStates,
  mergeReadinessOnDisk,
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
