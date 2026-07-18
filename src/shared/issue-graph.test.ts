import { describe, it, expect } from 'vitest';
import {
  dependencyEdges,
  dependents,
  unmetDetails,
  deriveIssueState,
} from './issue-graph';
import type { BacklogIssue, IssueStatus } from './backlog-model';

/** Minimal issue factory — only the fields the graph logic reads. */
function mk(id: number, status: IssueStatus, dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue ${id}`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

describe('dependencyEdges', () => {
  it('produces one edge per dependency, directed blocker → dependent', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(dependencyEdges([one, two])).toEqual([{ from: 1, to: 2, unmet: false }]);
  });

  it('marks an edge unmet while its blocker is not done', () => {
    const one = mk(1, 'wip');
    const two = mk(2, 'open', [1]);
    expect(dependencyEdges([one, two])).toEqual([{ from: 1, to: 2, unmet: true }]);
  });

  it('omits edges to a dependency id that is not in the backlog', () => {
    const two = mk(2, 'open', [99]);
    expect(dependencyEdges([two])).toEqual([]);
  });

  it('returns edges sorted by (to, from)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'done');
    const three = mk(3, 'open', [2, 1]);
    const four = mk(4, 'open', [1]);
    expect(dependencyEdges([four, three, one, two])).toEqual([
      { from: 1, to: 3, unmet: false },
      { from: 2, to: 3, unmet: false },
      { from: 1, to: 4, unmet: false },
    ]);
  });
});

describe('dependents', () => {
  it('lists the issues that depend on the given issue, ascending', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    const three = mk(3, 'open', [1]);
    expect(dependents(one, [three, two, one])).toEqual([2, 3]);
  });

  it('is empty when nothing depends on the issue', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(dependents(two, [one, two])).toEqual([]);
  });
});

describe('unmetDetails', () => {
  it('enriches each unmet dependency with its title and status', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'wip');
    const three = mk(3, 'open', [1, 2]);
    expect(unmetDetails(three, [one, two, three])).toEqual([
      { id: 2, title: '2 — issue 2', status: 'wip' },
    ]);
  });

  it('reports a missing dependency id with status "missing" and null title', () => {
    const three = mk(3, 'open', [99]);
    expect(unmetDetails(three, [three])).toEqual([
      { id: 99, title: null, status: 'missing' },
    ]);
  });

  it('is empty when all dependencies are done', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(unmetDetails(two, [one, two])).toEqual([]);
  });
});

describe('deriveIssueState', () => {
  it('reports done directly', () => {
    expect(deriveIssueState(mk(1, 'done'), [mk(1, 'done')])).toEqual({ kind: 'done' });
  });

  it('reports wip directly', () => {
    expect(deriveIssueState(mk(1, 'wip'), [mk(1, 'wip')])).toEqual({ kind: 'wip' });
  });

  it('is eligible when open with all dependencies done', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(deriveIssueState(two, [one, two])).toEqual({ kind: 'eligible' });
  });

  it('is eligible when open with no dependencies', () => {
    const one = mk(1, 'open');
    expect(deriveIssueState(one, [one])).toEqual({ kind: 'eligible' });
  });

  it('is blocked with the offending dependencies named when a dep is unmet', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'wip');
    const three = mk(3, 'open', [1, 2]);
    expect(deriveIssueState(three, [one, two, three])).toEqual({
      kind: 'blocked',
      unmet: [{ id: 2, title: '2 — issue 2', status: 'wip' }],
    });
  });

  it('is waiting-on-merge when every dependency is done but one is still finished-unmerged (issue 147)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(deriveIssueState(two, [one, two], [1])).toEqual({
      kind: 'waiting-on-merge',
      mergeIssueId: 1,
    });
  });

  it('is eligible again once the dependency lands (drops out of finishedUnmergedIds)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    expect(deriveIssueState(two, [one, two], [])).toEqual({ kind: 'eligible' });
  });

  it('prefers blocked over waiting-on-merge — a genuinely not-done dependency is a real block', () => {
    const one = mk(1, 'open');
    const two = mk(2, 'open', [1]);
    expect(deriveIssueState(two, [one, two], [1]).kind).toBe('blocked');
  });
});
