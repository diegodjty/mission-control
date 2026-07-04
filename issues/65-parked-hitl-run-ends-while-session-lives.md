---
status: done
depends_on: []
---

# 65 — A parked HITL Run must end (and free its slot) while its Pane still lives

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 third-attempt finding, 2026-07-03).

## What to build

Live cap-1 drains still stall at the HITL issue despite issue 64, and the root cause is one line of truth the e2e never modeled: `deriveRunStatus` (run-state) only ends a Run on a `done` flip, a user stop, or the **session dying** — and a real claude Pane never exits; it finishes its final message and sits at its prompt. So a parked HITL Run reads `running` forever, its slot never frees, and at cap 1 the coordinator (correctly, per issue 64) waits for a slot that never comes. Fake e2e workers exit, which is why the harness stayed green.

Fix at the source of truth: a Run whose latest Receipt declares `outcome: needs-verification` is **over** — introduce a terminal `parked` status in `deriveRunStatus`'s facts (receipt outcome joins issue status / stopped / session-alive), freeing the slot and feeding issue 64's continue-past-park logic, while the Pane stays open for the human to peek. Same treatment for a declared `outcome: blocked` with the session still alive (a blocked Worker also lingers at its prompt): the Run ends `blocked` — today's conservative drain halt then applies. The park/blocked call reads declared Receipt state only.

Close the harness gap that hid this: the fake-worker driver gains a **linger mode** (write everything, then keep the session alive), and the cap-1 HITL scenario runs with lingering workers — it must fail against current code before the fix.

## Acceptance criteria

- [ ] Failing-first e2e: cap-1 mixed drain with *lingering* fake workers stalls at the HITL park on current code; after the fix it parks 05, frees the slot, and completes the remaining eligible issues.
- [ ] A `needs-verification` Receipt transitions the Run to a terminal `parked` status while `sessionAlive` is true; the Pane is not killed.
- [ ] A `blocked` Receipt with a live session ends the Run `blocked` (drain halts conservatively, as today).
- [ ] No Receipt + live session + no done flip stays `running` (an actively working Worker is untouched).
- [ ] Unit tests on the extended `deriveRunStatus` decision table; full suite + type-check + `npm run test:e2e` pass.

## Blocked by

None - can start immediately.
