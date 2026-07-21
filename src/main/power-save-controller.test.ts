import { describe, expect, it } from 'vitest';
import { PowerSaveController } from './power-save-controller';
import type { PowerSaveApi } from './power-save-adapter';

/**
 * A fake power API (no Electron) — records the types started and which ids are
 * currently running, exactly like the notification-adapter tests inject a fake
 * `show`. Lets the arm/release lifecycle be asserted without real Electron.
 */
function fakePowerApi(): {
  api: PowerSaveApi;
  startedTypes: string[];
  running: Set<number>;
  startCount: () => number;
  stopCount: () => number;
} {
  const running = new Set<number>();
  const startedTypes: string[] = [];
  let nextId = 1;
  let stops = 0;
  const api: PowerSaveApi = {
    start(type) {
      const id = nextId++;
      running.add(id);
      startedTypes.push(type);
      return id;
    },
    stop(id) {
      stops += 1;
      running.delete(id);
    },
    isStarted(id) {
      return running.has(id);
    },
  };
  return { api, startedTypes, running, startCount: () => startedTypes.length, stopCount: () => stops };
}

describe('PowerSaveController — arm/release lifecycle (issue 193)', () => {
  it('arms a prevent-app-suspension blocker while a scheduled drain is active', () => {
    const { api, startedTypes, running } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(true);
    expect(ctrl.armed).toBe(true);
    expect(running.size).toBe(1);
    expect(startedTypes).toEqual(['prevent-app-suspension']);
  });

  it('releases the blocker on a terminal outcome — nothing lingers', () => {
    const { api, running } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(true);
    ctrl.setActive(false);
    expect(ctrl.armed).toBe(false);
    expect(running.size).toBe(0);
  });

  it('never arms the display-sleep level — the screen is free to sleep', () => {
    const { api, startedTypes } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(true);
    expect(startedTypes).not.toContain('prevent-display-sleep');
    expect(startedTypes.every((t) => t === 'prevent-app-suspension')).toBe(true);
  });

  it('is idempotent while active — the pending→running handoff never double-arms', () => {
    const { api, startCount, running } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(true); // armed at schedule time (pending)
    ctrl.setActive(true); // fires → running: same continuous block, not a second one
    expect(startCount()).toBe(1);
    expect(running.size).toBe(1);
  });

  it('a release with nothing armed is a quiet no-op', () => {
    const { api, stopCount } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(false);
    expect(ctrl.armed).toBe(false);
    expect(stopCount()).toBe(0);
  });

  it('covers the full pending→running→ended cycle exactly once, and re-arms after', () => {
    const { api, startCount, stopCount, running } = fakePowerApi();
    const ctrl = new PowerSaveController({ api });
    ctrl.setActive(true); // pending
    ctrl.setActive(true); // running
    expect(ctrl.armed).toBe(true);
    ctrl.setActive(false); // ended (completed / skipped / user-stopped)
    expect(ctrl.armed).toBe(false);
    expect(startCount()).toBe(1);
    expect(stopCount()).toBe(1);
    expect(running.size).toBe(0);
    // A later, separate scheduled drain arms a fresh blocker.
    ctrl.setActive(true);
    expect(ctrl.armed).toBe(true);
    expect(startCount()).toBe(2);
  });
});
