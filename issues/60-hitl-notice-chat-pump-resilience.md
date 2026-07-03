---
status: done
depends_on: []
---

# 60 — Blocking chat notifications can be silently swallowed: make the Dispatcher submit-pump unstallable

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 finding, 2026-07-03).

## What to build

Live failure with the ingest side proven healthy: issue 05's Receipt (declared `needs-verification`, `issueId: 5`) was ingested and persisted at 21:12:29, the backlog marks 05 `hitl: true`, and the pure derivation (`lifecycleKindForOutcome` → `hitl-waiting` → blocking chat) is unit-green — yet no notification ever appeared in the Dispatcher chat. The loss is between enqueue and the chat PTY. Prime suspect from the code: `pumpDispatcherQueue` sets `dispatcherPumping` and only clears it when the queue drains; its step chain (`writePty` + `setTimeout`) has no error path — if a write targets a dead/replaced Dispatcher session (this drain had heavy gate churn), the chain dies with the flag stuck `true`, and every later notification queues forever, silently. Secondary suspect: the defer-while-typing recheck loop under a stuck compose state.

Build the fix on three rules:

1. **The pump can't stay stuck.** Any step failure (or a session change mid-pump) resets the pumping state; a fresh pump is attempted against the current session. A watchdog re-kicks a queue that is non-empty but not pumping.
2. **Blocking notifications are never droppable.** `hitl-waiting` and other chat-tier items stay queued across Dispatcher session replacement and are (re)delivered when a session is attached — the queue is per-Project state, not per-session state.
3. **Delivery is observable.** The activities log records queued → typed → submitted per chat item (with the event key), so the next walkthrough can *see* where a notification died instead of inferring it.

Reproduce first (diagnose discipline): a test that enqueues a blocking notification, kills/replaces the session mid-pump, and asserts delivery to the replacement session — it must fail against current code before the fix.

## Acceptance criteria

- [ ] Failing-first test: blocking notification enqueued → session dies/replaced mid-pump → notification is typed + submitted into the new session; passes after the fix.
- [ ] A `writePty` failure mid-chain resets pump state and does not strand the queue; watchdog re-pumps a stalled non-empty queue.
- [ ] `needs-verification` Receipt for a `hitl: true` issue reliably yields exactly one chat notification (id + verification steps), across a simulated gate-churn sequence.
- [ ] Queued/typed/submitted delivery states visible in the ambient activities log.
- [ ] Full suite + type-check pass.

## Blocked by

None - can start immediately.
