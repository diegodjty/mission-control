/**
 * Unit tests for the Dispatcher status model (PURE) — issue 43.
 *
 * Pins the reconciliation the acceptance criteria call for:
 *   - the done-set matches the backlog, NOT the fed block stream;
 *   - a finished-unmerged `afk/` branch (cap≥2) is reflected as finished-unmerged;
 *   - an unknown-outcome capture is conveyed (with its detail), not dropped;
 *   - status comes from ground truth even when a block says otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileStatusModel,
  renderStatusModel,
  type StatusModelInput,
} from './dispatcher-status-model';
import type { Backlog, BacklogIssue, IssueStatus } from './backlog-model';
import type { WorktreeRunState } from './worktree-scan';
import type { RunLogRecord } from './ipc-contract';
import type { RunOutcome } from './completion-parser';

function issue(id: number, status: IssueStatus): BacklogIssue {
  return {
    id,
    slug: `${String(id).padStart(2, '0')}-thing`,
    fileName: `${String(id).padStart(2, '0')}-thing.md`,
    title: `Issue ${id}`,
    status,
    dependsOn: [],
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

function backlog(issues: BacklogIssue[]): Backlog {
  return { activePrd: 'docs/PRD.md', issues };
}

function record(over: Partial<RunLogRecord> & { id: string; outcome: RunOutcome }): RunLogRecord {
  return {
    issue: null,
    issueId: null,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    capturedAt: '2026-07-03T00:00:00.000Z',
    slug: null,
    title: null,
    ...over,
  };
}

function input(over: Partial<StatusModelInput> = {}): StatusModelInput {
  return { backlog: null, worktreeStates: [], runLog: [], ...over };
}

describe('reconcileStatusModel — done-set from the backlog, not the blocks', () => {
  it('takes done/wip/open straight from the backlog', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(3, 'done'), issue(4, 'done'), issue(5, 'wip'), issue(6, 'open')]),
      }),
    );
    expect(model.doneIds).toEqual([1, 2, 3, 4]);
    expect(model.wipIds).toEqual([5]);
    expect(model.openIds).toEqual([6]);
  });

  it("reflects issues the backlog marks done even when NO completion block was seen for them (the issue-35 drift)", () => {
    // The exact bug: 03/04 are done on disk, but the Dispatcher never got their
    // blocks. With the reconcile, the run log is irrelevant to done-ness.
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(3, 'done'), issue(4, 'done'), issue(5, 'open')]),
        runLog: [
          // Only 01/02 ever produced a parsed block; 03/04 did not.
          record({ id: 's1', issueId: 1, outcome: 'completed' }),
          record({ id: 's2', issueId: 2, outcome: 'completed' }),
        ],
      }),
    );
    expect(model.doneIds).toEqual([1, 2, 3, 4]);
    expect(model.openIds).toEqual([5]);
  });

  it("does NOT infer done from a completion block when the backlog disagrees", () => {
    // A block claiming 'completed' must not upgrade a status the backlog still
    // reads as open — status is grounded in the backlog/scan, blocks are qualitative.
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'open')]),
        runLog: [record({ id: 's1', issueId: 1, outcome: 'completed' })],
      }),
    );
    expect(model.doneIds).toEqual([]);
    expect(model.openIds).toEqual([1]);
  });
});

describe('reconcileStatusModel — finished-unmerged overlay (cap≥2 route)', () => {
  const wt = (issueId: number, kind: WorktreeRunState['kind']): WorktreeRunState => ({
    issueId,
    slug: `${String(issueId).padStart(2, '0')}-thing`,
    kind,
  });

  it('reflects a finished-unmerged branch whose done flip the backlog cannot see', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(7, 'open')]), // main still reads open — flip is on afk/07-thing
        worktreeStates: [wt(7, 'finished-unmerged')],
      }),
    );
    expect(model.finishedUnmergedIds).toEqual([7]);
    expect(model.openIds).toEqual([]);
    expect(model.issues.find((i) => i.issueId === 7)?.status).toBe('finished-unmerged');
  });

  it('keeps a merged issue as done (backlog done wins over a stale finished-unmerged)', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(7, 'done')]),
        worktreeStates: [wt(7, 'finished-unmerged')],
      }),
    );
    expect(model.doneIds).toEqual([7]);
    expect(model.finishedUnmergedIds).toEqual([]);
  });

  it('does not let running/stranded/commit-failed branches change a status', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(8, 'open'), issue(9, 'open'), issue(10, 'open')]),
        worktreeStates: [wt(8, 'running'), wt(9, 'stranded'), wt(10, 'commit-failed')],
      }),
    );
    expect(model.openIds).toEqual([8, 9, 10]);
    expect(model.finishedUnmergedIds).toEqual([]);
  });

  it('adds a finished-unmerged issue the backlog does not list', () => {
    const model = reconcileStatusModel(
      input({ backlog: backlog([]), worktreeStates: [wt(12, 'finished-unmerged')] }),
    );
    expect(model.finishedUnmergedIds).toEqual([12]);
    expect(model.issues[0]).toMatchObject({ issueId: 12, status: 'finished-unmerged' });
  });
});

describe('reconcileStatusModel — unknown captures conveyed, not dropped', () => {
  it('surfaces unknown-outcome captures as needs-look with their detail', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(3, 'open'), issue(4, 'open')]),
        runLog: [
          record({ id: 's3', issueId: 3, slug: '03-thing', title: 'Issue 3', outcome: 'unknown', detail: 'streamed but never resolved' }),
          record({ id: 's4', issueId: 4, outcome: 'completed' }),
        ],
      }),
    );
    expect(model.needsLook).toHaveLength(1);
    expect(model.needsLook[0]).toMatchObject({
      runId: 's3',
      issueId: 3,
      slug: '03-thing',
      detail: 'streamed but never resolved',
    });
    // And it is NOT counted as done anywhere.
    expect(model.doneIds).toEqual([]);
  });

  it('conveys an unknown capture even when it carries no issue id', () => {
    const model = reconcileStatusModel(
      input({ runLog: [record({ id: 'sX', outcome: 'unknown', detail: 'garbled' })] }),
    );
    expect(model.needsLook).toEqual([
      { runId: 'sX', issueId: null, slug: null, title: null, detail: 'garbled' },
    ]);
  });
});

describe('renderStatusModel', () => {
  it('lists each grounded bucket and the needs-look items', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(5, 'wip'), issue(6, 'open'), issue(7, 'open')]),
        worktreeStates: [{ issueId: 7, slug: '07-thing', kind: 'finished-unmerged' }],
        runLog: [record({ id: 's9', issueId: 9, slug: '09-thing', outcome: 'unknown', detail: 'could not parse' })],
      }),
    );
    const text = renderStatusModel(model);
    expect(text).toContain('Done (merged): 01, 02');
    expect(text).toContain('Finished, not yet merged: 07');
    expect(text).toContain('In progress (wip): 05');
    expect(text).toContain('Open: 06');
    expect(text).toContain('Needs a look');
    expect(text).toContain('issue 09 — 09-thing: could not parse');
  });

  it('is a stable signature for an unchanged model (re-feed guard)', () => {
    const build = (): StatusModelInput =>
      input({ backlog: backlog([issue(1, 'done'), issue(2, 'open')]) });
    expect(renderStatusModel(reconcileStatusModel(build()))).toBe(
      renderStatusModel(reconcileStatusModel(build())),
    );
  });

  it('says nothing to report before the backlog loads', () => {
    expect(renderStatusModel(reconcileStatusModel(input()))).toContain('has not loaded yet');
  });

  it('truncates a very long detail body so the refresh stays bounded', () => {
    const long = 'x'.repeat(500);
    const text = renderStatusModel(
      reconcileStatusModel(input({ runLog: [record({ id: 's1', outcome: 'unknown', detail: long })] })),
    );
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });
});
