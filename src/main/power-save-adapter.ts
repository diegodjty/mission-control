/**
 * Power-save-blocker adapter (thin) — issue 193, ADR-0024.
 *
 * The main-process side of "keep the Mac awake for a scheduled drain." A
 * scheduled drain's loop is a renderer effect (ADR-0022), so idle system-sleep
 * and macOS App Nap can throttle it to a halt overnight while nobody watches.
 * While a scheduled drain is pending or running the controller
 * (`power-save-controller`) arms ONE blocker through this adapter and releases
 * it the instant the drain ends.
 *
 * Deliberately dumb: it wraps Electron's `powerSaveBlocker` behind a tiny
 * injectable interface so the controller's arm/release lifecycle is
 * unit-testable with a fake and no real Electron — the same shape as the
 * notification adapter's injected `show`.
 *
 * `prevent-app-suspension`, never `prevent-display-sleep` (ADR-0024): only the
 * loop must stay alive; the screen is free to turn off.
 */
import { powerSaveBlocker } from 'electron';

/**
 * The slice of Electron's `powerSaveBlocker` the controller needs. Injected in
 * tests (a fake); production passes `electronPowerSaveApi`.
 */
export interface PowerSaveApi {
  /** Start a blocker of the given kind; returns its id. */
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  /** Stop the blocker with this id. */
  stop(id: number): void;
  /** Is the blocker with this id currently running? */
  isStarted(id: number): boolean;
}

/** The real Electron `powerSaveBlocker`. Wired in `index.ts`; never in tests. */
export const electronPowerSaveApi: PowerSaveApi = {
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id),
};
