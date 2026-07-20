import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IDLE_SCHEDULE,
  cancelSchedule,
  isDueToFire,
  scheduleDrain,
  type ScheduledDrainState,
} from '../../../shared/scheduled-drain';

/** How often the pending schedule is checked against wall-clock time. */
const POLL_MS = 1_000;

export interface ScheduledDrainHook {
  /** The current pending schedule, or idle. */
  schedule: ScheduledDrainState;
  /**
   * Arm a drain to fire at `fireAt` (epoch ms) with the given cap and,
   * optionally, an in-scope issue selection (issue 192) — omitted/undefined
   * means every eligible issue is in scope at fire time, same as today.
   */
  scheduleDrainAt: (fireAt: number, cap: number, selectedIds?: readonly number[]) => void;
  /** Disarm the pending schedule before it fires. */
  cancelScheduledDrain: () => void;
  /** Clears any pending schedule on a Project switch — never carries across Projects. */
  reset: () => void;
}

/**
 * The scheduled-drain window-coupled glue (issue 190, ADR-0024): the pending-
 * schedule state and "is it time?" decision are pure (`../../../shared/
 * scheduled-drain`); this hook is the thin timer that polls `Date.now()`
 * against it and, once due, calls `onFire` — the SAME start path a manual
 * press of the Drain button uses (`drain.guardedStartDrain`) — with the
 * schedule's cap, then disarms. One-shot and un-persisted BY CONSTRUCTION: the
 * schedule lives only in this `useState`, so quitting MC or closing this
 * Project's Window (which unmounts this hook, or drops the whole renderer)
 * drops it with nothing left behind — no re-arm-on-relaunch, no disk trace.
 */
export function useScheduledDrain(
  onFire: (cap: number, selectedIds?: readonly number[]) => void,
): ScheduledDrainHook {
  const [schedule, setSchedule] = useState<ScheduledDrainState>(IDLE_SCHEDULE);

  // Read through refs inside the timer so its identity doesn't need to depend
  // on `onFire` (recreated most renders) or be re-armed every schedule change.
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const scheduleDrainAt = useCallback(
    (fireAt: number, cap: number, selectedIds?: readonly number[]): void => {
      setSchedule(scheduleDrain(fireAt, cap, selectedIds));
    },
    [],
  );

  const cancelScheduledDrain = useCallback((): void => {
    setSchedule(cancelSchedule());
  }, []);

  const reset = useCallback((): void => {
    setSchedule(IDLE_SCHEDULE);
  }, []);

  useEffect(() => {
    if (schedule.kind !== 'pending') return;
    const timer = setInterval(() => {
      const current = scheduleRef.current;
      if (current.kind !== 'pending' || !isDueToFire(current, Date.now())) return;
      // Disarm BEFORE firing — a one-shot schedule must never re-fire on the
      // next poll tick while the drain it just started is still spinning up.
      setSchedule(IDLE_SCHEDULE);
      // Only pass a second argument when a scope was actually set — an
      // explicit `undefined` still shows up as an extra call argument to a
      // mock/spy, which would read as a changed call shape to a caller
      // asserting `toHaveBeenCalledWith(cap)`.
      if (current.selectedIds === undefined) {
        onFireRef.current(current.cap);
      } else {
        onFireRef.current(current.cap, current.selectedIds);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [schedule]);

  return { schedule, scheduleDrainAt, cancelScheduledDrain, reset };
}
