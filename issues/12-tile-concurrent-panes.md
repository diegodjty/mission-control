---
status: done
depends_on: []
---

# 12 — Tile concurrent Panes instead of tabbing them

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). Concurrent Runs currently render as a row of tabs (one Pane visible at a time). The intended design is to see live Runs **at once**, tiled in one window. Standalone UI fix.

## What to build

Replace the tabbed Pane area with an adaptive **tiled grid** that shows all live Run Panes simultaneously, sized to how many are running:

- 1 Run → the Pane fills the area.
- 2 Runs → side-by-side (1×2).
- 3–4 Runs → 2×2 grid.
- More than 4 → a scrolling grid (roughly square, e.g. capped columns) so nothing is hidden.

Each tile shows its Run's issue id/title and status badge (running/finished/blocked/stopped), and keeps the existing per-Run xterm Pane fully interactive. Clicking a tile focuses/maximizes it (and back). Terminated Runs (finished/stopped/blocked) stay visible in the grid until dismissed or until the drain clears them, so you can read what happened. The Map/Pane top-level view switch stays; this only changes how multiple Panes lay out within the Pane view.

## Acceptance criteria

- [ ] With 2 live Runs, both Panes are visible side-by-side at once (not one behind a tab).
- [ ] With 3–4 live Runs, they lay out as a 2×2 grid; with >4, a scrolling grid shows all of them.
- [ ] A single Run fills the area (no wasted split).
- [ ] Each tile is independently interactive (typing goes to that tile's session) and shows its status badge.
- [ ] Clicking a tile focuses/maximizes it and clicking again restores the grid.
- [ ] Layout logic that maps "N runs → grid shape" is a pure, unit-tested function; the rendering itself verifies via type-check + the batch QA walkthrough.

## Blocked by

None - can start immediately.
