/**
 * Interrupt guard (issue 114) — the pure rule for whether changing THIS
 * Window's active Project would interrupt a runner that is mid-issue, and so
 * should first offer "open the other Project in a new Window instead".
 *
 * Changing a Window's Project tears its in-flight Runs down: `resetForProjectSwitch`
 * in the renderer drops the tracked Runs, which unmounts their Panes and kills
 * their PTY sessions (issue 26/112). When a runner is actively fixing an issue
 * in the current Project, doing that silently loses the live work — the exact
 * "I switched Projects / clicked a different Project from Home and it killed my
 * running Run" surprise this issue is about.
 *
 * So the Window pauses for the human, but ONLY when it would actually interrupt
 * something: a runner must be LIVE and the change must move to a genuinely
 * DIFFERENT Project. Re-selecting the current Project, or opening the first
 * Project into an empty Window, interrupts nothing and proceeds untouched.
 *
 * Pure (no React, no Electron) so the decision is unit-testable in isolation;
 * the renderer just interposes a confirmation when this returns true and hands
 * the target to `openWindow` if the human picks "new Window".
 */
import { isProjectSwitch } from './project-switch';

/** The facts a project-change attempt carries for the interrupt decision. */
export interface InterruptGuardInput {
  /**
   * Whether this Window currently has at least one Run still `running` (a live
   * Worker fixing an issue). Derived from the tracked Runs' status, not the
   * on-disk scan — a finished/parked/blocked/stopped Run has no live session to
   * interrupt, so it never triggers the guard.
   */
  hasLiveRunner: boolean;
  /** The Project key this Window currently shows, or null when none is open. */
  currentKey: string | null;
  /** The Project key/path the user is trying to change this Window to. */
  targetKey: string | null;
}

/**
 * Whether to interpose the "open in a new Window instead?" confirmation before
 * changing the Window's Project. True only when a runner is live AND the target
 * is a genuinely different Project (`isProjectSwitch`); otherwise the caller
 * proceeds with the change exactly as it did before this guard existed.
 */
export function shouldConfirmInterrupt(input: InterruptGuardInput): boolean {
  if (!input.hasLiveRunner) return false;
  return isProjectSwitch(input.currentKey, input.targetKey);
}
