---
status: open
depends_on: []
---

# 34 — Completion-block capture + Run-log feed

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

Capture each Run's **Completion block** (the structured summary a Worker emits when its Run ends) into a durable, per-Project **Run log**, and show it in the Execution view as a scannable feed of cards. End-to-end: a Run finishes → its final output is parsed into a structured record → persisted on disk → rendered as a card (what changed / try-it / verified / bookkeeping / doc-drift / outcome). This is the prerequisite for the Dispatcher — its entire input is these captured blocks.

Two deep pieces:
- **Completion-block parser** (pure): a Worker's final output text → structured `{issue, whatChanged, tryIt, verified, bookkeeping, docDrift, outcome}`. Handles the normal completion block, the "Ready for manual verification" (HITL) block, and the "blocked" report → correct `outcome`; a malformed/partial block degrades gracefully (never crashes).
- **Run log store** (adapter): persist and retrieve completion-block records durably on disk, scoped per Project, surviving closing Panes / the app.

## Acceptance criteria

- [ ] When a Run ends, its Completion block is parsed into a structured record and persisted to the per-Project Run log on disk.
- [ ] The Execution view shows a Run-log feed: one card per Run with its parsed fields; it survives closing the Run's Pane.
- [ ] The Run log persists across app restarts and is isolated per Project.
- [ ] Parser is a pure module, unit-tested: normal / HITL / blocked / malformed inputs → correct structure and `outcome`.
- [ ] Run log store is integration-tested against a scratch dir (persist/read, per-Project isolation, survives a simulated restart).

## Blocked by

None - can start immediately.
