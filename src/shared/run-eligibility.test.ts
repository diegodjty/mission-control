import { describe, it, expect } from 'vitest';
import { eligibleForRun, unmetDependencies } from './run-eligibility';
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
