import { describe, it, expect } from 'vitest';
import { deriveRunStatus, isTerminal, observedIssueStatus } from './run-state';

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

describe('isTerminal', () => {
  it('is false only while running', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
  });
});
