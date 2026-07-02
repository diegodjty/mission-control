import { describe, it, expect } from 'vitest';
import {
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
  mergedIntoMain: false,
  ...overrides,
});

describe('issueIdFromSlug', () => {
  it('parses the leading issue number from a NN-slug stem', () => {
    expect(issueIdFromSlug('04-tracer-bullet')).toBe(4);
    expect(issueIdFromSlug('16-map-progress')).toBe(16);
  });
});

describe('deriveWorktreeRunStates', () => {
  it('marks a live worktree with no committed done as running (in-worktree)', () => {
    const states = deriveWorktreeRunStates([
      branch(3, { hasWorktree: true, committedStatus: 'wip' }),
    ]);
    expect(states).toEqual([{ issueId: 3, slug: '03-x', kind: 'running' }]);
  });

  it('marks a committed-done, unmerged branch as finished-unmerged', () => {
    const states = deriveWorktreeRunStates([
      branch(4, { hasWorktree: true, committedStatus: 'done', mergedIntoMain: false }),
    ]);
    expect(states).toEqual([{ issueId: 4, slug: '04-x', kind: 'finished-unmerged' }]);
  });

  it('reports finished-unmerged even after the worktree is gone (survives Pane close)', () => {
    // Panes closed / worktree removed, but the committed branch is still on disk.
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
    const states = deriveWorktreeRunStates([
      branch(5, { hasWorktree: true, committedStatus: 'done' }),
      branch(2, { hasWorktree: true, committedStatus: 'wip' }),
      branch(9, { hasWorktree: false, committedStatus: 'done', mergedIntoMain: true }),
    ]);
    expect(states).toEqual([
      { issueId: 2, slug: '02-x', kind: 'running' },
      { issueId: 5, slug: '05-x', kind: 'finished-unmerged' },
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
      branch(4, { hasWorktree: true, committedStatus: 'done' }),
      branch(3, { hasWorktree: false, committedStatus: 'done' }),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable).toEqual([
      { issueId: 3, slug: '03-x' },
      { issueId: 4, slug: '04-x' },
    ]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('withholds the Merge while a sibling Run is still in flight', () => {
    const plan = mergeReadinessOnDisk([
      branch(3, { hasWorktree: true, committedStatus: 'done' }),
      branch(4, { hasWorktree: true, committedStatus: 'wip' }),
    ]);
    expect(plan.ready).toBe(false);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([4]);
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
