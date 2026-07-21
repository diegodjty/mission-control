import { describe, expect, it } from 'vitest';
import {
  IDLE_SCHEDULE,
  cancelSchedule,
  isDueToFire,
  scheduleDrain,
<<<<<<< HEAD
<<<<<<< HEAD
  scheduledDrainSkipMessage,
  scheduledDrainSkipReason,
  type ScheduledDrainGateInput,
  type ScheduledDrainState,
} from './scheduled-drain';
import type { GitBranchStatusResult } from './ipc-contract';
=======
  type ScheduledDrainState,
} from './scheduled-drain';
>>>>>>> afk/192-scope-scheduled-drain-by-selection
=======
  type ScheduledDrainState,
} from './scheduled-drain';
>>>>>>> afk/193-scheduled-drain-power-save-blocker

describe('scheduled-drain', () => {
  it('IDLE_SCHEDULE starts idle and is never due', () => {
    expect(IDLE_SCHEDULE).toEqual({ kind: 'idle' });
    expect(isDueToFire(IDLE_SCHEDULE, Date.now())).toBe(false);
  });

  it('scheduleDrain arms a pending schedule carrying the fire time and cap', () => {
    const state = scheduleDrain(1_000, 3);
    expect(state).toEqual({ kind: 'pending', fireAt: 1_000, cap: 3 });
  });

  it('scheduleDrain floors and clamps a fractional/zero/negative cap to at least 1', () => {
    expect(scheduleDrain(1_000, 2.9)).toEqual({ kind: 'pending', fireAt: 1_000, cap: 2 });
    expect(scheduleDrain(1_000, 0)).toEqual({ kind: 'pending', fireAt: 1_000, cap: 1 });
    expect(scheduleDrain(1_000, -5)).toEqual({ kind: 'pending', fireAt: 1_000, cap: 1 });
  });

  it('cancelSchedule always returns to idle', () => {
    const pending = scheduleDrain(1_000, 2);
    expect(cancelSchedule()).toEqual(IDLE_SCHEDULE);
    // Cancelling is not a function of the current state — idle cancels to idle too.
    void pending;
  });

  it('isDueToFire is false before the fire time and true at/after it', () => {
    const pending: ScheduledDrainState = scheduleDrain(10_000, 2);
    expect(isDueToFire(pending, 9_999)).toBe(false);
    expect(isDueToFire(pending, 10_000)).toBe(true);
    expect(isDueToFire(pending, 10_001)).toBe(true);
  });

  it('isDueToFire is false for an idle state at any time', () => {
    expect(isDueToFire(IDLE_SCHEDULE, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
<<<<<<< HEAD

  it('scheduleDrain carries an optional selection scope through to the pending state (issue 192)', () => {
    const state = scheduleDrain(1_000, 3, [2, 4]);
    expect(state).toEqual({ kind: 'pending', fireAt: 1_000, cap: 3, selectedIds: [2, 4] });
  });

  it('scheduleDrain omits selectedIds when not given — "all eligible" by default', () => {
    const state = scheduleDrain(1_000, 3);
    expect(state).toEqual({ kind: 'pending', fireAt: 1_000, cap: 3 });
    expect('selectedIds' in state).toBe(false);
  });
});
<<<<<<< HEAD

describe('scheduledDrainSkipReason', () => {
  const ready: GitBranchStatusResult = { branch: 'afk/191', detached: false, protectedBranch: false };
  const okAvailability = { available: true, reason: null };

  const baseInput = (overrides: Partial<ScheduledDrainGateInput> = {}): ScheduledDrainGateInput => ({
    branchStatus: ready,
    midMerge: false,
    notUnderGit: false,
    cap: 2,
    availability: okAvailability,
    ...overrides,
  });

  it('proceeds (null) when every gate passes', () => {
    expect(scheduledDrainSkipReason(baseInput())).toBeNull();
  });

  it('skips with branch-status-unknown while branch status is still loading', () => {
    expect(scheduledDrainSkipReason(baseInput({ branchStatus: null }))).toEqual({
      kind: 'branch-status-unknown',
    });
  });

  it('skips with detached-head when HEAD is detached', () => {
    const detached: GitBranchStatusResult = { branch: null, detached: true, protectedBranch: false };
    expect(scheduledDrainSkipReason(baseInput({ branchStatus: detached }))).toEqual({
      kind: 'detached-head',
    });
  });

  it('skips with protected-branch when on a protected branch (issue 167)', () => {
    const protected_: GitBranchStatusResult = { branch: 'main', detached: false, protectedBranch: true };
    expect(scheduledDrainSkipReason(baseInput({ branchStatus: protected_ }))).toEqual({
      kind: 'protected-branch',
      branch: 'main',
    });
  });

  it('skips with mid-merge when main is mid-merge (issue 24)', () => {
    expect(scheduledDrainSkipReason(baseInput({ midMerge: true }))).toEqual({ kind: 'mid-merge' });
  });

  it('skips with nothing-eligible when the backlog has no startable work (issue 90)', () => {
    expect(
      scheduledDrainSkipReason(
        baseInput({ availability: { available: false, reason: 'nothing eligible — all issues done' } }),
      ),
    ).toEqual({ kind: 'nothing-eligible', reason: 'nothing eligible — all issues done' });
  });

  it('skips with non-git-cap for a non-git workspace with cap > 1 (issue 158)', () => {
    expect(scheduledDrainSkipReason(baseInput({ notUnderGit: true, cap: 3 }))).toEqual({
      kind: 'non-git-cap',
      cap: 3,
    });
  });

  it('does not skip for a non-git workspace when cap is 1 (issue 158 only gates cap > 1)', () => {
    expect(scheduledDrainSkipReason(baseInput({ notUnderGit: true, cap: 1 }))).toBeNull();
  });

  it('checks gates in the same order the manual path does: branch guard first', () => {
    const detached: GitBranchStatusResult = { branch: null, detached: true, protectedBranch: false };
    expect(
      scheduledDrainSkipReason(
        baseInput({
          branchStatus: detached,
          midMerge: true,
          notUnderGit: true,
          cap: 3,
          availability: { available: false, reason: 'nothing eligible — all issues done' },
        }),
      ),
    ).toEqual({ kind: 'detached-head' });
  });

  it('checks mid-merge before eligibility and the non-git+cap gate', () => {
    expect(
      scheduledDrainSkipReason(
        baseInput({
          midMerge: true,
          notUnderGit: true,
          cap: 3,
          availability: { available: false, reason: 'nothing eligible — all issues done' },
        }),
      ),
    ).toEqual({ kind: 'mid-merge' });
  });

  it('checks eligibility before the non-git+cap gate', () => {
    expect(
      scheduledDrainSkipReason(
        baseInput({
          notUnderGit: true,
          cap: 3,
          availability: { available: false, reason: 'nothing eligible — all issues done' },
        }),
      ),
    ).toEqual({ kind: 'nothing-eligible', reason: 'nothing eligible — all issues done' });
  });
});

describe('scheduledDrainSkipMessage', () => {
  it('names each gate reason in the "scheduled drain skipped — <reason>" form', () => {
    expect(scheduledDrainSkipMessage({ kind: 'branch-status-unknown' })).toMatch(
      /^scheduled drain skipped —/,
    );
    expect(scheduledDrainSkipMessage({ kind: 'detached-head' })).toBe(
      'scheduled drain skipped — HEAD is detached',
    );
    expect(scheduledDrainSkipMessage({ kind: 'protected-branch', branch: 'main' })).toBe(
      "scheduled drain skipped — you're on a protected branch (main)",
    );
    expect(scheduledDrainSkipMessage({ kind: 'mid-merge' })).toBe(
      'scheduled drain skipped — main is mid-merge',
    );
    expect(scheduledDrainSkipMessage({ kind: 'nothing-eligible', reason: 'nothing eligible — all issues done' })).toBe(
      'scheduled drain skipped — nothing eligible — all issues done',
    );
    expect(scheduledDrainSkipMessage({ kind: 'non-git-cap', cap: 3 })).toBe(
      'scheduled drain skipped — workspace is not a git repository and the cap is above 1',
    );
  });
});
=======
>>>>>>> afk/192-scope-scheduled-drain-by-selection
=======
});
>>>>>>> afk/193-scheduled-drain-power-save-blocker
