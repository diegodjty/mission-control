---
status: done
depends_on: [66]
---

# 68 — The defer-while-typing gate can stick "composing" and dam the narrative queue

## Parent

`docs/adr/0014-run-narrative-lands-in-the-dispatcher-conversation.md` — "the chat" is the claude conversation (walkthrough-58 fourth-attempt finding, 2026-07-04).

## What to build

Live finding: the drain's narrative messages all arrived in one burst right after the user sent their first chat message, instead of live as each Run finished. Root cause in `dispatcher-channel.ts`: `reduceTyping` sets `composing: true` on **any** input chunk and only a submit or line-clear ever resets it — so `composing` never decays — and non-typing terminal input counts as composing: clicking the chat pane emits a focus-report escape (`\x1b[I`/`\x1b[O`), scrolling emits mouse-report sequences, and either one arms the gate. `canFlushChat` then holds every queued message until the user's next Enter releases the dam all at once.

Two fixes, both in the pure layer:

1. **Non-compose input must not arm the gate.** Classify input chunks: focus in/out reports, mouse-report sequences, bracketed-paste guards, and other bare non-printing escape sequences fold into `lastInputAt` at most — they never set `composing`. Printable characters and editing keys still do.
2. **Composing decays.** A compose state older than a generous idle window (e.g. ~15s without further input) no longer blocks the flush — the user has abandoned the line; the claude TUI safely queues typed-ahead text anyway, so the interleave risk `canFlushChat` protects against is gone by then. A submit/line-clear still clears it immediately.

E2E-first: extend the harness's Scenario 7 chat PTY with a focus-report chunk injected mid-drain — on current code the narrative dams behind it (failing first); after the fix, messages keep flowing live. Unit-test the classifier and the decay in the decision table.

## Acceptance criteria

- [ ] Failing-first e2e: a focus/mouse escape chunk mid-drain does not stop narrative delivery; on current code it does.
- [ ] A genuinely mid-compose line (printable chars, no submit) still holds the queue; the held messages flush after the compose decays (~15s idle) or the line is submitted/cleared.
- [ ] Focus in/out, mouse-report, and bracketed-paste sequences never set `composing` (unit decision table).
- [ ] Delivery order preserved when a held queue flushes.
- [ ] Full suite + type-check + `npm run test:e2e` pass.

## Blocked by

- 66
