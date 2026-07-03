import { describe, expect, it } from 'vitest';
import {
  clampDispatcherWidth,
  dispatcherWidthFromPointer,
  DEFAULT_DISPATCHER_WIDTH,
  DISPATCHER_WIDTH_BOUNDS,
} from './dispatcher-width';

describe('clampDispatcherWidth', () => {
  it('passes an in-range width through, rounded to a whole pixel', () => {
    expect(clampDispatcherWidth(500)).toBe(500);
    expect(clampDispatcherWidth(499.6)).toBe(500);
  });

  it('clamps below the min up to the min', () => {
    expect(clampDispatcherWidth(100)).toBe(DISPATCHER_WIDTH_BOUNDS.min);
    expect(clampDispatcherWidth(0)).toBe(DISPATCHER_WIDTH_BOUNDS.min);
  });

  it('clamps above the max down to the max', () => {
    expect(clampDispatcherWidth(9999)).toBe(DISPATCHER_WIDTH_BOUNDS.max);
  });

  it('falls back to the default for a non-finite width (NaN or Infinity)', () => {
    expect(clampDispatcherWidth(NaN)).toBe(DEFAULT_DISPATCHER_WIDTH);
    expect(clampDispatcherWidth(Infinity)).toBe(DEFAULT_DISPATCHER_WIDTH);
    expect(clampDispatcherWidth(-Infinity)).toBe(DEFAULT_DISPATCHER_WIDTH);
    expect(clampDispatcherWidth(Number.parseFloat('nope'))).toBe(DEFAULT_DISPATCHER_WIDTH);
  });

  it('honors custom bounds', () => {
    expect(clampDispatcherWidth(50, { min: 100, max: 200 })).toBe(100);
    expect(clampDispatcherWidth(300, { min: 100, max: 200 })).toBe(200);
  });

  it('keeps the default within the bounds', () => {
    expect(DEFAULT_DISPATCHER_WIDTH).toBeGreaterThanOrEqual(DISPATCHER_WIDTH_BOUNDS.min);
    expect(DEFAULT_DISPATCHER_WIDTH).toBeLessThanOrEqual(DISPATCHER_WIDTH_BOUNDS.max);
  });
});

describe('dispatcherWidthFromPointer', () => {
  it('widens the panel as the pointer moves left of the drag start', () => {
    // Handle is on the panel's left edge: moving left (clientX < startClientX) widens.
    expect(
      dispatcherWidthFromPointer({ startWidth: 400, startClientX: 800, clientX: 700 }),
    ).toBe(500);
  });

  it('narrows the panel as the pointer moves right of the drag start', () => {
    expect(
      dispatcherWidthFromPointer({ startWidth: 400, startClientX: 800, clientX: 850 }),
    ).toBe(350);
  });

  it('is a no-op when the pointer has not moved', () => {
    expect(
      dispatcherWidthFromPointer({ startWidth: 420, startClientX: 800, clientX: 800 }),
    ).toBe(420);
  });

  it('clamps a big drag to the bounds', () => {
    expect(
      dispatcherWidthFromPointer({ startWidth: 400, startClientX: 800, clientX: 0 }),
    ).toBe(DISPATCHER_WIDTH_BOUNDS.max);
    expect(
      dispatcherWidthFromPointer({ startWidth: 400, startClientX: 800, clientX: 5000 }),
    ).toBe(DISPATCHER_WIDTH_BOUNDS.min);
  });
});
