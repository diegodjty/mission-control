---
issue: 60
slug: hitl-notice-chat-pump-resilience
outcome: completed
finished: 2026-07-03T22:51:39Z
---
## Completed issue 60 — hitl-notice-chat-pump-resilience

**What changed** — The Dispatcher's chat delivery queue can no longer silently swallow a notification. The old pump (inlined in the UI) had four ways to lose a message: it kept typing into a chat session that had been replaced (the session id was frozen in a closure), it removed a message from the queue before delivery was assured, a single write error left the pump stuck "busy" forever, and nothing ever restarted a stalled queue. All four are fixed in a new standalone pump: messages stay queued until their submit actually lands in the *current* session, session replacement re-delivers them in full to the new session, any failure resets the pump, and a watchdog re-kicks a stalled queue. Every message's journey (queued → typed → submitted, or requeued/write-failed) is now visible in the ambient activity log, so a lost notification can be *seen* dying instead of inferred.

**Try it yourself** — This is the delivery layer under the HITL notice, so the real proof is walkthrough 58: drain the QA sandbox to the parked HITL issue and the "waiting for you" notice must appear in the Dispatcher chat — including if you close/reopen the Dispatcher panel mid-drain. The delivery phases are visible in the ambient activity log as the notice moves queued → typed → submitted.

**Verified** — Note: the Worker hit its session limit at the very end of this Run; the dispatcher (main session) verified and authored this Receipt from the finished work. Verified: full suite 697/697 (12 new tests incl. session-replacement redelivery, write-failure recovery, watchdog re-kick, delivery-phase observability, and extended hitl-chain coverage) and type-check clean. Not runtime-verified in the live app — that is exactly what walkthrough 58 (which depends on this issue) drives.

**Bookkeeping** — New: `src/shared/dispatcher-pump.ts` (pure, injectable timers/clock) + `src/shared/dispatcher-pump.test.ts`. Modified: `src/renderer/src/App.tsx` (pump usage replaces the inlined chain; delivery events recorded to activities), `src/renderer/src/DispatcherPanel.tsx` (delivery-phase rendering), `src/shared/dispatcher-hitl-chain.test.ts` (+106 lines end-to-end chain cases). Issue flipped `done` by the Worker.

**Doc drift** — none reported; the Worker's final narrative was lost to the session limit, so drift, if any, would surface in walkthrough 58.
