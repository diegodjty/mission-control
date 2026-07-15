import { describe, it, expect } from 'vitest';
import { decideCardOpen } from './open-card-decision';

describe('decideCardOpen', () => {
  it('opens in place when this Window has no Project open yet', () => {
    // An empty Window has nothing to preserve — clicking a card just opens it,
    // no prompt (issue 121 only asks when a Project is already open here).
    expect(
      decideCardOpen({ currentKey: null, cardKey: '/wb/proj-b', hasLiveRunner: false }),
    ).toEqual({ kind: 'open-here' });
  });

  it('opens in place when the clicked card IS the already-open Project', () => {
    // Re-selecting the open Project is a no-op switch — return to its Map, never
    // ask "here or new Window" for the project you are already on.
    expect(
      decideCardOpen({ currentKey: '/wb/proj-a', cardKey: '/wb/proj-a', hasLiveRunner: false }),
    ).toEqual({ kind: 'open-here' });
  });

  it('asks here-or-new-Window when a DIFFERENT Project is picked and nothing is running', () => {
    // The issue 121 case: a Project is open, the user picks another from Home,
    // and no runner is live — offer the choice instead of switching in place.
    expect(
      decideCardOpen({ currentKey: '/wb/proj-a', cardKey: '/wb/proj-b', hasLiveRunner: false }),
    ).toEqual({ kind: 'choose-window' });
  });

  it('defers to the interrupt guard when a runner is live in this Window', () => {
    // A live runner here means switching would tear the Run down — the stronger
    // interrupt overlay (issue 114) owns the ask, not the plain choice.
    expect(
      decideCardOpen({ currentKey: '/wb/proj-a', cardKey: '/wb/proj-b', hasLiveRunner: true }),
    ).toEqual({ kind: 'confirm-interrupt' });
  });

  it('opens the same Project in place even with a live runner (no interrupt)', () => {
    // Re-selecting the current Project interrupts nothing, so the live runner is
    // irrelevant — still a plain in-place open, never a confirm.
    expect(
      decideCardOpen({ currentKey: '/wb/proj-a', cardKey: '/wb/proj-a', hasLiveRunner: true }),
    ).toEqual({ kind: 'open-here' });
  });
});
