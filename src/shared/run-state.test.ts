import { describe, it, expect } from 'vitest';
import { deriveRunStatus, isTerminal } from './run-state';

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

describe('isTerminal', () => {
  it('is false only while running', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
  });
});
