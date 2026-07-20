/**
 * Scheduled-drain timing model (PURE) — issue 190, ADR-0024.
 *
 * A scheduled drain is a deferred press of the existing Drain control: pick a
 * wall-clock time, and an open Window's timer calls the same start path the
 * Drain button does once that time arrives. This module holds just the
 * timing decision — the pending schedule's shape, arming it, cancelling it,
 * and "is it time to fire?" — so the renderer glue (`../renderer/src/app/
 * useScheduledDrain`) that polls `Date.now()` and calls the real start path
 * stays thin and untested-by-necessity (window timers, `window.mc` calls).
 *
 * One-shot and un-persisted BY CONSTRUCTION (ADR-0024): this is in-memory
 * state only, held in a React hook's `useState`. There is no disk write, no
 * CONFIG key, no daemon — quitting MC or closing the Project's Window simply
 * drops this state, so a schedule that hasn't fired yet never fires at all.
 */

/** No drain is armed. */
export interface IdleSchedule {
  kind: 'idle';
}

/** A drain armed to fire at `fireAt` (epoch ms) with the given concurrency cap. */
export interface PendingSchedule {
  kind: 'pending';
  /** Wall-clock fire time, epoch milliseconds. */
  fireAt: number;
  /** The concurrency cap the deferred drain start applies — same meaning as a manual Drain's cap. */
  cap: number;
}

export type ScheduledDrainState = IdleSchedule | PendingSchedule;

/** The state before anything is ever scheduled, or after a cancel/fire/reset. */
export const IDLE_SCHEDULE: ScheduledDrainState = { kind: 'idle' };

/** Arm a schedule for `fireAt`, replacing any existing pending one. */
export function scheduleDrain(fireAt: number, cap: number): ScheduledDrainState {
  return { kind: 'pending', fireAt, cap: Math.max(1, Math.floor(cap) || 1) };
}

/** Disarm a pending schedule before it fires. */
export function cancelSchedule(): ScheduledDrainState {
  return IDLE_SCHEDULE;
}

/** Whether a pending schedule has reached (or passed) its fire time. */
export function isDueToFire(state: ScheduledDrainState, now: number): boolean {
  return state.kind === 'pending' && now >= state.fireAt;
}
