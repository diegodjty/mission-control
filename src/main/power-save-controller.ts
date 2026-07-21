/**
 * Power-save-blocker controller — issue 193, ADR-0024.
 *
 * The stateful glue that arms a single `prevent-app-suspension` power-save
 * blocker while a scheduled drain is pending or running, and releases it the
 * instant the drain ends — success, skip, or user-stop. The renderer owns the
 * "pending or running" truth (the schedule lives in a React hook, ADR-0022) and
 * reports it here as one boolean via IPC; this class only mirrors that flag
 * onto the injected power API, idempotently:
 *
 *   - `setActive(true)`  — ensure exactly one blocker is armed (a no-op if one
 *     already is, so the pending→running handoff never double-arms).
 *   - `setActive(false)` — release the armed blocker if any (a no-op otherwise,
 *     so a drain's end — or a redundant release — never throws).
 *
 * Electron-free on purpose (the real `powerSaveBlocker` lives behind the
 * injected `PowerSaveApi`), so the arm/release lifecycle is unit-testable with
 * a fake — the same shape as `NotificationController`.
 */
import type { PowerSaveApi } from './power-save-adapter';

/** `prevent-app-suspension`, not display: the screen may sleep (ADR-0024). */
const BLOCKER_TYPE = 'prevent-app-suspension' as const;

export interface PowerSaveControllerOptions {
  /** The power-save primitive (the electron adapter's api, injected). */
  api: PowerSaveApi;
}

export class PowerSaveController {
  private blockerId: number | null = null;
  private readonly api: PowerSaveApi;

  constructor(opts: PowerSaveControllerOptions) {
    this.api = opts.api;
  }

  /**
   * Reflect the renderer's "a scheduled drain is pending or running" flag onto
   * the blocker. Idempotent in both directions.
   */
  setActive(active: boolean): void {
    if (active) this.arm();
    else this.release();
  }

  /** Is a blocker currently armed? (Inspection / tests.) */
  get armed(): boolean {
    return this.blockerId !== null && this.api.isStarted(this.blockerId);
  }

  private arm(): void {
    if (this.armed) return;
    this.blockerId = this.api.start(BLOCKER_TYPE);
  }

  private release(): void {
    if (this.blockerId === null) return;
    if (this.api.isStarted(this.blockerId)) this.api.stop(this.blockerId);
    this.blockerId = null;
  }
}
