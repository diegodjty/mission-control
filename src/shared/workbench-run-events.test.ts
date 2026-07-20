import { describe, it, expect } from 'vitest';
import type { Backlog, BacklogIssue, IssueStatus } from './backlog-model';
import {
  claimEventsBetween,
  receiptRunEvent,
  statusSnapshot,
  workbenchCommitMessage,
} from './workbench-run-events';

function mk(id: number, status: IssueStatus): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status,
    dependsOn: [],
    parent: null,
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    runTimeoutMinutes: null,
    touches: [],
    inBatch: false,
    standalone: true,
    body: '',
  };
}

function backlog(...issues: BacklogIssue[]): Backlog {
  return { activePrd: null, workerModel: 'sonnet', escalationCeiling: 'opus', workerEffort: null, runTimeoutMinutes: 30, hotFiles: [], issues };
}

function snap(entries: Array<[number, IssueStatus]>): Map<number, IssueStatus> {
  return new Map(entries);
}

describe('statusSnapshot', () => {
  it('maps issue ids to statuses; null backlog yields an empty snapshot', () => {
    expect(statusSnapshot(backlog(mk(1, 'open'), mk(2, 'wip')))).toEqual(
      snap([
        [1, 'open'],
        [2, 'wip'],
      ]),
    );
    expect(statusSnapshot(null).size).toBe(0);
  });
});

describe('claimEventsBetween (issue 72 — claim observed, once)', () => {
  it('reports an open → wip flip as a claim', () => {
    const events = claimEventsBetween(snap([[4, 'open']]), snap([[4, 'wip']]));
    expect(events).toEqual([{ issueId: 4, event: 'claim' }]);
  });

  it('reports a freshly-appearing wip issue as a claim', () => {
    expect(claimEventsBetween(snap([]), snap([[7, 'wip']]))).toEqual([
      { issueId: 7, event: 'claim' },
    ]);
  });

  it('is idempotent on re-observation: unchanged statuses yield no events', () => {
    const same = snap([
      [1, 'wip'],
      [2, 'done'],
    ]);
    expect(claimEventsBetween(same, new Map(same))).toEqual([]);
  });

  it('treats the seed observation (prev null) as no events', () => {
    expect(claimEventsBetween(null, snap([[1, 'wip']]))).toEqual([]);
  });

  it('does NOT report done flips (done + Receipt is the Receipt-driven event)', () => {
    expect(claimEventsBetween(snap([[1, 'wip']]), snap([[1, 'done']]))).toEqual([]);
  });

  it('reports multiple claims ascending by issue id', () => {
    const events = claimEventsBetween(
      snap([
        [9, 'open'],
        [3, 'open'],
      ]),
      snap([
        [9, 'wip'],
        [3, 'wip'],
      ]),
    );
    expect(events.map((e) => e.issueId)).toEqual([3, 9]);
  });
});

describe('receiptRunEvent (declared state only, ADR-0013)', () => {
  it('maps declared outcomes to Run events', () => {
    expect(receiptRunEvent(5, 'completed')).toEqual({ issueId: 5, event: 'done' });
    expect(receiptRunEvent(5, 'needs-verification')).toEqual({ issueId: 5, event: 'park' });
    expect(receiptRunEvent(5, 'blocked')).toEqual({ issueId: 5, event: 'blocked' });
  });

  it('yields no event for unknown/absent outcomes or an unreadable issue id', () => {
    expect(receiptRunEvent(5, 'unknown')).toBeNull();
    expect(receiptRunEvent(5, null)).toBeNull();
    expect(receiptRunEvent(null, 'completed')).toBeNull();
    expect(receiptRunEvent(Number.NaN, 'completed')).toBeNull();
  });
});

describe('workbenchCommitMessage', () => {
  it('formats exactly `<project>: issue NN <event>`', () => {
    expect(workbenchCommitMessage('mission-control', { issueId: 5, event: 'claim' })).toBe(
      'mission-control: issue 05 claim',
    );
    expect(workbenchCommitMessage('billing', { issueId: 72, event: 'done' })).toBe(
      'billing: issue 72 done',
    );
    expect(workbenchCommitMessage('x', { issueId: 3, event: 'park' })).toBe(
      'x: issue 03 park',
    );
  });
});
