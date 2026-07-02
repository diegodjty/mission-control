import { describe, it, expect } from 'vitest';
import { gridShape, MAX_GRID_COLS } from './pane-grid';

describe('gridShape', () => {
  it('is empty when there are no Runs', () => {
    expect(gridShape(0)).toEqual({ rows: 0, cols: 0, scroll: false });
    expect(gridShape(-3)).toEqual({ rows: 0, cols: 0, scroll: false });
  });

  it('gives a single Run the whole area (1×1, no split)', () => {
    expect(gridShape(1)).toEqual({ rows: 1, cols: 1, scroll: false });
  });

  it('puts 2 Runs side-by-side (1×2)', () => {
    expect(gridShape(2)).toEqual({ rows: 1, cols: 2, scroll: false });
  });

  it('lays 3 and 4 Runs out as a 2×2 grid', () => {
    expect(gridShape(3)).toEqual({ rows: 2, cols: 2, scroll: false });
    expect(gridShape(4)).toEqual({ rows: 2, cols: 2, scroll: false });
  });

  it('switches to a scrolling grid past 4 Runs', () => {
    expect(gridShape(5).scroll).toBe(true);
    expect(gridShape(9).scroll).toBe(true);
  });

  it('keeps the grid roughly square but caps the column count', () => {
    // 5–6 Runs fit in 3 columns.
    expect(gridShape(5)).toEqual({ rows: 2, cols: 3, scroll: true });
    expect(gridShape(6)).toEqual({ rows: 2, cols: 3, scroll: true });
    // 7–9 Runs fill a 3×3.
    expect(gridShape(9)).toEqual({ rows: 3, cols: 3, scroll: true });
  });

  it('never exceeds the column cap, growing (scrolling) rows instead', () => {
    for (const n of [5, 8, 12, 20, 50]) {
      const shape = gridShape(n);
      expect(shape.cols).toBeLessThanOrEqual(MAX_GRID_COLS);
      // Every Run gets a cell.
      expect(shape.rows * shape.cols).toBeGreaterThanOrEqual(n);
    }
    expect(gridShape(12)).toEqual({ rows: 4, cols: 3, scroll: true });
  });

  it('rounds a fractional count down before laying out', () => {
    expect(gridShape(2.9)).toEqual(gridShape(2));
  });
});
