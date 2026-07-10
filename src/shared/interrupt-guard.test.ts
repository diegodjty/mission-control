import { describe, expect, it } from 'vitest';
import { shouldConfirmInterrupt } from './interrupt-guard';

describe('shouldConfirmInterrupt', () => {
  it('confirms before switching to a different Project while a runner is live', () => {
    // The core case: a Worker is fixing an issue in /repo/a and the user picks
    // /repo/b — switching would kill the live Run, so pause for the human.
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: true, currentKey: '/repo/a', targetKey: '/repo/b' }),
    ).toBe(true);
  });

  it('does NOT confirm when no runner is live (nothing to interrupt)', () => {
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: false, currentKey: '/repo/a', targetKey: '/repo/b' }),
    ).toBe(false);
  });

  it('does NOT confirm when re-selecting the current Project (not a switch)', () => {
    // Clicking Continue on the Project you already have open, or re-picking it
    // in the switcher, interrupts nothing — proceed straight through.
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: true, currentKey: '/repo/a', targetKey: '/repo/a' }),
    ).toBe(false);
  });

  it('does NOT confirm when opening the first Project into an empty Window', () => {
    // No current Project means no runner could belong to it; hasLiveRunner is
    // false here anyway, but the not-a-switch rule also holds it back.
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: false, currentKey: null, targetKey: '/repo/a' }),
    ).toBe(false);
  });

  it('does NOT confirm a null target (no Project to change to)', () => {
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: true, currentKey: '/repo/a', targetKey: null }),
    ).toBe(false);
  });

  it('confirms when the live-runner Window opens its first different Project', () => {
    // Defensive: even if a live runner somehow exists with a null current key,
    // moving to a real, different Project is still a switch worth confirming.
    expect(
      shouldConfirmInterrupt({ hasLiveRunner: true, currentKey: null, targetKey: '/repo/b' }),
    ).toBe(true);
  });
});
