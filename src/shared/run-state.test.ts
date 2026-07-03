import { describe, it, expect } from 'vitest';
import {
  deriveRunStatus,
  isTerminal,
  observedIssueStatus,
  runningIssueIds,
  shouldCommitWorktree,
  shouldCommitMain,
  type RunStatus,
} from './run-state';

describe('deriveRunStatus', () => {
  it('is running while the session is alive and the issue is not done', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: 'wip' }),
    ).toBe('running');
  });

  it('is finished once the issue flips to done, even if the session still lingers', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: 'done' }),
    ).toBe('finished');
  });

  it('is blocked when the session ends before the issue reaches done', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: 'wip' }),
    ).toBe('blocked');
  });

  it('is stopped when the user stopped it and the issue is not done', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: true, issueStatus: 'wip' }),
    ).toBe('stopped');
  });

  it('prefers finished over stopped when done was reached', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: true, issueStatus: 'done' }),
    ).toBe('finished');
  });

  it('treats an unobserved (null) issue status as not-done', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: null }),
    ).toBe('running');
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: null }),
    ).toBe('blocked');
  });
});

describe('observedIssueStatus (issue 13 — which source to trust)', () => {
  it('an isolated Run reads its status from the worktree, ignoring main', () => {
    // The worktree flipped to done on the afk/ branch; main still says wip.
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'wip', worktreeStatus: 'done' }),
    ).toBe('done');
  });

  it('an isolated Run is not-done while its worktree still says wip', () => {
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'done', worktreeStatus: 'wip' }),
    ).toBe('wip');
  });

  it('an isolated Run whose worktree is not yet observed is null (not-done)', () => {
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'wip', worktreeStatus: null }),
    ).toBeNull();
  });

  it('a solo Run reads its status from the main backlog, ignoring any worktree value', () => {
    expect(
      observedIssueStatus({ isolated: false, mainStatus: 'done', worktreeStatus: null }),
    ).toBe('done');
    expect(
      observedIssueStatus({ isolated: false, mainStatus: 'wip', worktreeStatus: 'done' }),
    ).toBe('wip');
  });

  it('feeds deriveRunStatus so an isolated done-on-branch Run shows finished', () => {
    const isolatedFacts = {
      sessionAlive: true,
      stoppedByUser: false,
      issueStatus: observedIssueStatus({
        isolated: true,
        mainStatus: 'wip', // main-checkout watcher never saw the flip
        worktreeStatus: 'done', // but the worktree/branch did
      }),
    };
    expect(deriveRunStatus(isolatedFacts)).toBe('finished');
  });
});

describe('shouldCommitWorktree (issue 15 — when to auto-commit)', () => {
  it('commits an isolated Run once its worktree reaches done', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: 'done' })).toBe(true);
  });

  it('does not commit an isolated Run still wip (not finished yet)', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: 'wip' })).toBe(false);
  });

  it('does not commit an isolated Run whose worktree is not yet observed', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: null })).toBe(false);
  });

  it('never auto-commits a solo Run — it works on main and is left for review', () => {
    expect(shouldCommitWorktree({ isolated: false, worktreeStatus: 'done' })).toBe(false);
  });
});

describe('shouldCommitMain (issue 25 — when to commit a solo Run on main)', () => {
  it('commits a solo Run once its issue reaches done on main', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: 'done' })).toBe(true);
  });

  it('does not commit a solo Run still wip (blocked/stopped — left for the user)', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: 'wip' })).toBe(false);
  });

  it('does not commit a solo Run whose status is not yet observed', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: null })).toBe(false);
  });

  it('never commits an isolated Run here — it commits on its own afk branch', () => {
    expect(shouldCommitMain({ isolated: true, mainStatus: 'done' })).toBe(false);
  });
});

describe('runningIssueIds (issue 33 — the Map "running" / "Run in progress" set is status-filtered)', () => {
  interface FakeRun {
    issueId: number;
    status: RunStatus;
  }
  const statusOf = (r: FakeRun): RunStatus => r.status;
  const idOf = (r: FakeRun): number => r.issueId;

  it('excludes a finished tracked Run whose Pane is still on screen', () => {
    // This is the issue-33 bug: a solo Run reached `done` (finished) but its
    // Pane/tile has not been dismissed yet, so it is still a tracked Run.
    const runs: FakeRun[] = [
      { issueId: 2, status: 'finished' },
      { issueId: 5, status: 'running' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([5]);
  });

  it('excludes stopped and blocked Runs too — only `running` is live', () => {
    const runs: FakeRun[] = [
      { issueId: 1, status: 'stopped' },
      { issueId: 2, status: 'blocked' },
      { issueId: 3, status: 'finished' },
      { issueId: 4, status: 'running' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([4]);
  });

  it('is empty when every tracked Run has reached a terminal status', () => {
    const runs: FakeRun[] = [
      { issueId: 7, status: 'finished' },
      { issueId: 8, status: 'stopped' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([]);
  });

  it('does NOT return every tracked Run id (the pre-fix bug used runs.map(...) unfiltered)', () => {
    const runs: FakeRun[] = [
      { issueId: 2, status: 'finished' },
      { issueId: 5, status: 'running' },
    ];
    // The old `runs.map((r) => r.target.issueId)` returned [2, 5], marking the
    // finished issue 2 as still running. The filtered set must not.
    expect(runningIssueIds(runs, statusOf, idOf)).not.toContain(2);
  });
});

describe('isTerminal', () => {
  it('is false only while running', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
  });
});
