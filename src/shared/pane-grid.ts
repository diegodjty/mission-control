/**
 * Pane grid layout — the pure mapping from "how many Run Panes are open" to the
 * tiled grid that shows them all at once (issue 12).
 *
 * Concurrent Runs used to render as a row of tabs (one Pane visible at a time);
 * this decides the adaptive grid that shows every live Run simultaneously:
 *
 *   1 Run        → 1×1 (the Pane fills the area, no wasted split)
 *   2 Runs       → 1×2 (side-by-side)
 *   3–4 Runs     → 2×2
 *   more than 4  → a roughly-square grid with the column count capped, so tiles
 *                  stay readable and the grid scrolls instead of hiding any Run.
 *
 * Pure (no DOM, no React) so the shape logic is unit-testable in isolation; the
 * on-screen rendering that consumes it verifies via type-check + the batch QA
 * walkthrough.
 */

/** Beyond this many columns tiles get too narrow to read a terminal, so the
 * grid caps columns here and grows rows (which scroll) instead. */
export const MAX_GRID_COLS = 3;

export interface GridShape {
  /** Number of rows the tiles occupy. 0 when there are no Runs. */
  rows: number;
  /** Number of columns the tiles occupy. 0 when there are no Runs. */
  cols: number;
  /**
   * Whether the grid should scroll rather than shrink tiles to fit the area.
   * True once there are more Runs than a single non-scrolling screen shows well
   * (>4); false for 1–4 where the tiles divide the area exactly.
   */
  scroll: boolean;
}

/**
 * Map a Run count to its grid shape. `n` is the number of Panes to tile.
 * Non-positive counts yield an empty shape (the grid isn't rendered then).
 */
export function gridShape(n: number): GridShape {
  const count = Math.max(0, Math.floor(n));
  if (count <= 0) return { rows: 0, cols: 0, scroll: false };
  if (count === 1) return { rows: 1, cols: 1, scroll: false };
  if (count === 2) return { rows: 1, cols: 2, scroll: false };
  if (count <= 4) return { rows: 2, cols: 2, scroll: false };

  // >4: roughly square (√n columns) but capped so tiles stay readable; the extra
  // rows overflow the area and scroll so no Run is ever hidden.
  const cols = Math.min(MAX_GRID_COLS, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  return { rows, cols, scroll: true };
}
