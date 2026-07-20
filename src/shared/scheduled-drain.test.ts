import { describe, expect, it } from 'vitest';
import {
  IDLE_SCHEDULE,
  cancelSchedule,
  isDueToFire,
  scheduleDrain,
  type ScheduledDrainState,
} from './scheduled-drain';

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
});
