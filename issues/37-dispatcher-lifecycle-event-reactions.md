---
status: open
depends_on: [35]
---

# 37 — Dispatcher reacts to lifecycle events mid-drain

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

Extend the Dispatcher's input contract with lightweight **terminal lifecycle events** — started / finished / blocked / stranded / needs-attention / **hitl-waiting** — so it can react mid-drain without ingesting any raw Pane transcript (ADR-0007 input contract). When a Run blocks or strands (issue 22's states), the Dispatcher surfaces it and proposes a next step (e.g. "05 stranded — discard its worktree and continue?") as an approval-gated action (per issue 36's gates), rather than the drain silently stalling.

**HITL-waiting notification (explicit):** when the drain reaches a HITL issue that is now parked awaiting the human (a `hitl: true` / `(HITL)` issue left `wip` with a "Ready for manual verification" block — the `05 manual-check` case in testing), the Dispatcher must **proactively notify the user** — name the issue and relay its manual-verification steps (from the captured block `detail`, issue 42) — so the user knows a HITL gate is waiting on them and what to do, rather than having to notice the drain paused.

## Acceptance criteria

- [ ] The Dispatcher receives lifecycle events (started/finished/blocked/stranded/needs-attention) as structured signals, never raw Pane output.
- [ ] When a Run blocks/strands, the Dispatcher surfaces it in chat and proposes an action (e.g. discard-and-continue) as an approval-gated prompt.
- [ ] A stuck drain doesn't silently stall — a needs-attention Run is surfaced.
- [ ] When the drain reaches a HITL issue waiting on the human, the Dispatcher proactively notifies the user, names the issue, and relays its manual-verification steps (from the captured block detail) — the user is not left to notice the pause themselves.
- [ ] The event-handling decision logic (event → surfaced proposal) is pure and unit-tested; raw Pane output is still excluded (assert).

## Blocked by

- 35
