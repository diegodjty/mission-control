/**
 * Dispatcher panel width model (PURE) — issue 44.
 *
 * The Dispatcher chat sits in a fixed rail beside the Map. Issue 44 makes that
 * rail user-resizable by dragging the divider between the Map and the panel,
 * and persists the chosen width. The *math* of that resize — clamping to a
 * sensible min/max, and turning a pointer position into a new width — lives here
 * as pure functions so it can be unit-tested in isolation; the on-screen drag,
 * the ResizeObserver-driven terminal reflow, and localStorage persistence are
 * the renderer's job.
 *
 * The divider sits on the panel's LEFT edge (its `border-left`), and the panel
 * is pinned to the window's right edge, so dragging the pointer LEFT widens the
 * panel and dragging RIGHT narrows it. `dispatcherWidthFromPointer` captures
 * that: width grows as the pointer moves left of where the drag started.
 */

/** The adjustable range for the Dispatcher rail, in CSS pixels. */
export interface WidthBounds {
  min: number;
  max: number;
}

/**
 * Sensible min/max for the rail. The min keeps the chat readable (a cramped
 * sub-300px rail is the very defect issue 44 fixes); the max keeps the Map from
 * being squeezed out entirely on a normal window.
 */
export const DISPATCHER_WIDTH_BOUNDS: WidthBounds = { min: 320, max: 760 };

/** The width a first-time (or reset) panel opens at, within the bounds. */
export const DEFAULT_DISPATCHER_WIDTH = 380;

/**
 * Clamp a requested width to the bounds, rounded to a whole pixel. A non-finite
 * or missing width (a corrupt/empty persisted value) falls back to the default,
 * so a bad stored value can never render a zero-width or NaN rail.
 */
export function clampDispatcherWidth(
  width: number,
  bounds: WidthBounds = DISPATCHER_WIDTH_BOUNDS,
): number {
  if (!Number.isFinite(width)) return DEFAULT_DISPATCHER_WIDTH;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

/**
 * The new panel width for a drag in progress: `startWidth` is the width when the
 * drag began, `startClientX` the pointer x then, `clientX` the pointer x now.
 * Because the drag handle is on the panel's left edge, moving left (a smaller
 * `clientX`) widens the panel — hence `startClientX - clientX`. The result is
 * clamped to the bounds.
 */
export function dispatcherWidthFromPointer(args: {
  startWidth: number;
  startClientX: number;
  clientX: number;
  bounds?: WidthBounds;
}): number {
  const { startWidth, startClientX, clientX, bounds = DISPATCHER_WIDTH_BOUNDS } = args;
  return clampDispatcherWidth(startWidth + (startClientX - clientX), bounds);
}
