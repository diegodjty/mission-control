// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScheduledDrain } from './useScheduledDrain';

/**
 * The timing decision itself (pending-schedule state, "is it time?", cancel)
 * is pure and unit-tested in `../../../shared/scheduled-drain.test.ts`; this
 * covers the hook's window-coupled glue — arming/cancelling, polling
 * `Date.now()`, firing the start path exactly once and disarming, and never
 * carrying a schedule across a `reset()` (the Project-switch teardown).
 */

describe('useScheduledDrain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useScheduledDrain(vi.fn()));
    expect(result.current.schedule).toEqual({ kind: 'idle' });
  });

  it('scheduleDrainAt arms a pending schedule; cancelScheduledDrain disarms it without firing', () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useScheduledDrain(onFire));

    act(() => {
      result.current.scheduleDrainAt(Date.now() + 60_000, 2);
    });
    expect(result.current.schedule).toEqual(
      expect.objectContaining({ kind: 'pending', cap: 2 }),
    );

    act(() => {
      result.current.cancelScheduledDrain();
    });
    expect(result.current.schedule).toEqual({ kind: 'idle' });

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires onFire with the scheduled cap once wall-clock time reaches fireAt, then disarms', async () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useScheduledDrain(onFire));

    act(() => {
      result.current.scheduleDrainAt(Date.now() + 5_000, 3);
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(3);
    expect(result.current.schedule).toEqual({ kind: 'idle' });

    // No re-fire on later ticks — it's a one-shot.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('fires onFire with the scheduled selection scope (issue 192) when one was armed', () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useScheduledDrain(onFire));

    act(() => {
      result.current.scheduleDrainAt(Date.now() + 5_000, 2, [1, 3]);
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(2, [1, 3]);
  });

  it('reset() clears a pending schedule (the Project-switch teardown) and it never fires', () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useScheduledDrain(onFire));

    act(() => {
      result.current.scheduleDrainAt(Date.now() + 5_000, 1);
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.schedule).toEqual({ kind: 'idle' });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onFire).not.toHaveBeenCalled();
  });
});
