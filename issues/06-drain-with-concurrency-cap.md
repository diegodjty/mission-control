---
status: done
depends_on: [3]
---

# 06 — Drain the backlog with a concurrency cap

## Parent

`docs/PRD.md` — Mission Control.

## What to build

A "drain" action that works eligible issues without you firing each one, bounded by a **max-concurrent** cap. Introduces the **Run Coordinator** — a pure module that, given the backlog state + the cap + the currently active Runs, decides which issues are startable now, which queue, and when the drain stops (no eligible issue remains, or a Run reports a blocker). Each started Run opens its own fresh Pane (per issue 03); Runs beyond the cap queue and start as slots free.

The Run Coordinator is pure (no spawning inside it) so it is unit-testable; the actual spawning is done by the PTY Session Manager it drives.

## Acceptance criteria

- [ ] A "drain" action starts eligible Runs up to the max-concurrent cap, each in its own Pane.
- [ ] Runs beyond the cap queue and auto-start as running Runs finish.
- [ ] The drain stops when no eligible issue remains or a Run reports blocked, and says why it stopped.
- [ ] The cap is user-configurable.
- [ ] Run Coordinator is a pure module, unit-tested: correct startable/queued sets for a given backlog + cap, and correct drain-stop conditions.

## Blocked by

- 03
