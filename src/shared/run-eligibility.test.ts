import { describe, it, expect } from 'vitest';
import {
  eligibleForRun,
  unmetDependencies,
  hasInFlightRun,
  runnableNow,
} from './run-eligibility';
import type { BacklogIssue, IssueStatus } from './backlog-model';

/** Minimal issue factory — only the fields the eligibility logic reads. */
function mk(id: number, status: IssueStatus, dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

describe('unmetDependencies', () => {
  it('is empty when every dependency is done', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'done');
    const three = mk(3, 'open', [1, 2]);
    expect(unmetDependencies(three, [one, two, three])).toEqual([]);
  });

  it('lists dependencies that are not done', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'wip');
    const three = mk(3, 'open', [1, 2]);
    expect(unmetDependencies(three, [one, two, three])).toEqual([2]);
  });

  it('treats a missing dependency id as unmet', () => {
    const three = mk(3, 'open', [1, 99]);
    expect(unmetDependencies(three, [mk(1, 'done'), three])).toEqual([99]);
  });

  it('is empty for an issue with no dependencies', () => {
    const one = mk(1, 'open');
    expect(unmetDependencies(one, [one])).toEqual([]);
  });
});

describe('eligibleForRun', () => {
  it('is runnable when open with all dependencies done', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(eligibleForRun(two, [one, two])).toBe(true);
  });

  it('is runnable when open with no dependencies', () => {
    const one = mk(1, 'open');
    expect(eligibleForRun(one, [one])).toBe(true);
  });

  it('is not runnable when a dependency is still open or wip', () => {
    const one = mk(1, 'wip');
    const two = mk(2, 'open', [1]);
    expect(eligibleForRun(two, [one, two])).toBe(false);
  });

  it('is not runnable when the issue itself is already wip (claimed)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'wip', [1]);
    expect(eligibleForRun(two, [one, two])).toBe(false);
  });

  it('is not runnable when the issue is already done', () => {
    const one = mk(1, 'done');
    expect(eligibleForRun(one, [one])).toBe(false);
  });
});

describe('hasInFlightRun', () => {
  it('is false with no scan / empty sets', () => {
    expect(hasInFlightRun(1)).toBe(false);
    expect(hasInFlightRun(1, {})).toBe(false);
    expect(hasInFlightRun(1, { worktreeRunningIds: [], finishedUnmergedIds: [] })).toBe(false);
  });

  it('is true when the id is running in a worktree', () => {
    expect(hasInFlightRun(4, { worktreeRunningIds: [4, 5] })).toBe(true);
  });

  it('is true when the id is finished-but-unmerged on its afk/ branch', () => {
    expect(hasInFlightRun(7, { finishedUnmergedIds: [7] })).toBe(true);
  });

  it('is true when the id is stranded or commit-failed on disk (issue 22)', () => {
    // A stranded/commit-failed Run still has a worktree + branch on disk, so a
    // fresh Run would collide — it must block a new Run just like a live one.
    expect(hasInFlightRun(8, { strandedIds: [8] })).toBe(true);
    expect(hasInFlightRun(9, { commitFailedIds: [9] })).toBe(true);
  });

  it('is false for an id not in any on-disk set', () => {
    expect(
      hasInFlightRun(3, {
        worktreeRunningIds: [4],
        finishedUnmergedIds: [7],
        strandedIds: [8],
        commitFailedIds: [9],
      }),
    ).toBe(false);
  });
});

describe('runnableNow', () => {
  it('is runnable when eligible and not in flight on disk', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(runnableNow(two, [one, two])).toBe(true);
    expect(runnableNow(two, [one, two], { worktreeRunningIds: [], finishedUnmergedIds: [] })).toBe(
      true,
    );
  });

  it('is NOT runnable when a Run is already live in its worktree, even though main reads open', () => {
    // main-checkout status is still `open` (the work lives on the afk/ branch),
    // so eligibleForRun alone would wrongly say yes — the on-disk scan overrides.
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(eligibleForRun(two, [one, two])).toBe(true);
    expect(runnableNow(two, [one, two], { worktreeRunningIds: [2] })).toBe(false);
  });

  it('is NOT runnable when finished-but-unmerged (its done flip is on the afk/ branch)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(runnableNow(two, [one, two], { finishedUnmergedIds: [2] })).toBe(false);
  });

  it('stays not-runnable when it was never eligible, regardless of the scan', () => {
    const one = mk(1, 'wip');
    const two = mk(2, 'open', [1]); // blocked on 1
    expect(runnableNow(two, [one, two], { worktreeRunningIds: [], finishedUnmergedIds: [] })).toBe(
      false,
    );
  });
});
