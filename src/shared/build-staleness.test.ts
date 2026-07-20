import { describe, it, expect } from 'vitest';
import { evaluateBuildStaleness, REBUILD_COMMAND } from './build-staleness';

describe('evaluateBuildStaleness (issue 173)', () => {
  it('is not stale when the running commit IS the target tip', () => {
    expect(
      evaluateBuildStaleness({
        runningCommit: 'abc123',
        targetTipCommit: 'abc123',
        commitsBehind: 0,
      }),
    ).toEqual({ stale: false, commitsBehind: 0, message: null });
  });

  it('is stale when behind, naming the count and the rebuild command', () => {
    const decision = evaluateBuildStaleness({
      runningCommit: 'old111',
      targetTipCommit: 'new999',
      commitsBehind: 9,
    });
    expect(decision.stale).toBe(true);
    expect(decision.commitsBehind).toBe(9);
    expect(decision.message).toContain('9 commits behind');
    expect(decision.message).toContain(REBUILD_COMMAND);
  });

  it('singularizes "1 commit behind"', () => {
    const decision = evaluateBuildStaleness({
      runningCommit: 'old111',
      targetTipCommit: 'new999',
      commitsBehind: 1,
    });
    expect(decision.message).toContain('1 commit behind');
    expect(decision.message).not.toContain('1 commits behind');
  });

  it('is not stale when commits differ but the count is non-positive (defensive)', () => {
    expect(
      evaluateBuildStaleness({
        runningCommit: 'old111',
        targetTipCommit: 'new999',
        commitsBehind: 0,
      }),
    ).toEqual({ stale: false, commitsBehind: 0, message: null });
  });

  it('never blocks — the decision carries no gate, only a message', () => {
    const decision = evaluateBuildStaleness({
      runningCommit: 'old111',
      targetTipCommit: 'new999',
      commitsBehind: 3,
    });
    expect(Object.keys(decision).sort()).toEqual(['commitsBehind', 'message', 'stale']);
  });
});
