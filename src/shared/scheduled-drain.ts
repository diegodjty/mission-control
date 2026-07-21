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
<<<<<<< HEAD
<<<<<<< HEAD
import type { GitBranchStatusResult } from './ipc-contract';
=======
>>>>>>> afk/192-scope-scheduled-drain-by-selection
=======
>>>>>>> afk/193-scheduled-drain-power-save-blocker

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
<<<<<<< HEAD
  /**
   * The in-scope issue ids chosen at schedule time (issue 192, ADR-0024), or
   * `undefined` for "all eligible" — the same "absent ⇒ no filter" convention
   * `run-coordinator`'s `DrainInput.selectedIds` uses, so this rides straight
   * through to `planDrain` at fire time with no translation. Orthogonal to
   * `cap`: selection is which issues at all, cap is how many at once.
   */
  selectedIds?: readonly number[];
=======
>>>>>>> afk/193-scheduled-drain-power-save-blocker
}

export type ScheduledDrainState = IdleSchedule | PendingSchedule;

/** The state before anything is ever scheduled, or after a cancel/fire/reset. */
export const IDLE_SCHEDULE: ScheduledDrainState = { kind: 'idle' };

<<<<<<< HEAD
/**
 * Arm a schedule for `fireAt`, replacing any existing pending one.
 * `selectedIds` omitted/undefined ⇒ every eligible issue is in scope at fire
 * time (identical to today's whole-backlog drain and to 190's behavior).
 */
export function scheduleDrain(
  fireAt: number,
  cap: number,
  selectedIds?: readonly number[],
): ScheduledDrainState {
  return {
    kind: 'pending',
    fireAt,
    cap: Math.max(1, Math.floor(cap) || 1),
    ...(selectedIds === undefined ? {} : { selectedIds }),
  };
=======
/** Arm a schedule for `fireAt`, replacing any existing pending one. */
export function scheduleDrain(fireAt: number, cap: number): ScheduledDrainState {
  return { kind: 'pending', fireAt, cap: Math.max(1, Math.floor(cap) || 1) };
>>>>>>> afk/193-scheduled-drain-power-save-blocker
}

/** Disarm a pending schedule before it fires. */
export function cancelSchedule(): ScheduledDrainState {
  return IDLE_SCHEDULE;
}

/** Whether a pending schedule has reached (or passed) its fire time. */
export function isDueToFire(state: ScheduledDrainState, now: number): boolean {
  return state.kind === 'pending' && now >= state.fireAt;
}
<<<<<<< HEAD
<<<<<<< HEAD

/**
 * Scheduled-drain skip decision (PURE) — issue 191, ADR-0024.
 *
 * A scheduled drain fires with nobody watching, so it must never pop the
 * dialogs the manual Drain control shows for the same gates (protected
 * branch / detached HEAD — issue 167; non-git workspace + cap>1 — issue 158;
 * `main` mid-merge — issue 24; nothing eligible — issue 90). Instead it
 * SKIPS — does not start the drain at all — and names the reason for a
 * notification. This is the "which gate → skip with which reason" mapping,
 * kept here (beside the timing decision) so it is unit-testable without
 * Electron or the interactive dialog components.
 *
 * Checked in the SAME order the manual path's gates run
 * (`useDrain.guardedStartDrain` → `startDrain`): branch guard first, then
 * mid-merge, then eligibility, then the non-git + cap gate. Only the FIRST
 * matching gate's reason is returned — exactly one skip notification per
 * fire, like the manual path shows exactly one dialog/message per click.
 * `null` means every gate passed: the scheduled fire proceeds exactly like a
 * press of Drain now.
 */
export type ScheduledDrainSkipReason =
  | { kind: 'branch-status-unknown' }
  | { kind: 'detached-head' }
  | { kind: 'protected-branch'; branch: string }
  | { kind: 'mid-merge' }
  | { kind: 'nothing-eligible'; reason: string }
  | { kind: 'non-git-cap'; cap: number };

/** The gate inputs a scheduled fire evaluates, mirroring the manual path's own state. */
export interface ScheduledDrainGateInput {
  /** Current branch status; null while still loading (issue 167's "never fail open" window). */
  branchStatus: GitBranchStatusResult | null;
  /** Is `main` mid-merge right now (issue 24)? */
  midMerge: boolean;
  /** Is the workspace root not a git repository (issue 158)? */
  notUnderGit: boolean;
  /** The concurrency cap the fire would apply. */
  cap: number;
  /** Whether the backlog has any startable/unblockable work right now (issue 90). */
  availability: { available: boolean; reason: string | null };
}

/**
 * Would a scheduled fire refuse right now, and why? Returns the first
 * matching gate's reason, or `null` when every gate passes and the fire may
 * proceed exactly like a manual Drain press.
 */
export function scheduledDrainSkipReason(
  input: ScheduledDrainGateInput,
): ScheduledDrainSkipReason | null {
  const { branchStatus, midMerge, notUnderGit, cap, availability } = input;

  // Branch guard (issue 167) — checked first, same as `guardedStartDrain`.
  if (branchStatus === null) return { kind: 'branch-status-unknown' };
  if (branchStatus.detached) return { kind: 'detached-head' };
  if (branchStatus.protectedBranch) {
    return { kind: 'protected-branch', branch: branchStatus.branch ?? '' };
  }

  // `main` mid-merge (issue 24) — checked next, same as `startDrain`.
  if (midMerge) return { kind: 'mid-merge' };

  // Nothing eligible to start/unblock (issue 90) — same as `startDrain`.
  if (!availability.available) {
    return { kind: 'nothing-eligible', reason: availability.reason ?? 'nothing eligible' };
  }

  // Non-git workspace + a concurrency ask above 1 (issue 158) — checked last,
  // same as `startDrain`.
  if (notUnderGit && Math.max(1, Math.floor(cap) || 1) > 1) {
    return { kind: 'non-git-cap', cap: Math.max(1, Math.floor(cap) || 1) };
  }

  return null;
}

/** The human-readable "scheduled drain skipped — <reason>" line for the OS notification. */
export function scheduledDrainSkipMessage(reason: ScheduledDrainSkipReason): string {
  switch (reason.kind) {
    case 'branch-status-unknown':
      return "scheduled drain skipped — couldn't confirm the branch you're on";
    case 'detached-head':
      return 'scheduled drain skipped — HEAD is detached';
    case 'protected-branch':
      return `scheduled drain skipped — you're on a protected branch (${reason.branch || 'unknown'})`;
    case 'mid-merge':
      return 'scheduled drain skipped — main is mid-merge';
    case 'nothing-eligible':
      return `scheduled drain skipped — ${reason.reason}`;
    case 'non-git-cap':
      return 'scheduled drain skipped — workspace is not a git repository and the cap is above 1';
    default:
      return 'scheduled drain skipped';
  }
}
=======
>>>>>>> afk/192-scope-scheduled-drain-by-selection
=======
>>>>>>> afk/193-scheduled-drain-power-save-blocker
