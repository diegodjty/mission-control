---
issue: 68
slug: defer-gate-stuck-composing
outcome: completed
finished: 2026-07-04T04:17:32Z
---
## Completed issue 68 — defer-gate-stuck-composing

**What changed** — During a drain, the Dispatcher chat is supposed to receive each finished Run's report live, as it happens. Before this fix, merely clicking on the chat pane or scrolling it made the app believe you were in the middle of typing a message — so it politely held back every report, forever, and then dumped them all in one burst the next time you pressed Enter. Now the app can tell the difference between real typing and a click/scroll/paste-marker (those never pause delivery), and even a genuinely half-typed line you walk away from only pauses delivery for about 15 seconds before messages flow again. Pressing Enter or clearing the line still releases held messages immediately, and messages are never interleaved with a line you are actively typing.

**Try it yourself**
1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22`
2. `npm run test:e2e` — expect all scenarios green; Scenario 7 now drives the real defer-while-typing gate and injects the exact focus/mouse escape bytes a terminal emits on click/scroll mid-drain.
3. Live (optional, the walkthrough-58 way): reset the QA sandbox (`/Users/devteam/Developer/mc-qa-sandbox/repo-a`, standard reset procedure), `npm run dev`, open the project, start a drain — then click into the Dispatcher chat pane and scroll it while Runs are finishing. You should see each Run's narrative message keep arriving live (previously: silence until your next Enter, then a burst).
4. Also live: type a few characters into the chat without pressing Enter, then stop. Any pending narrative should appear after roughly 15 seconds; typing again re-holds it, Enter releases it immediately.

**Verified** — Failing-first at both levels, then green: (a) e2e Scenario 7 wired through the real `reduceTyping`/`canFlushChat` gate dammed at "narrative for issue 3 delivered" on pre-fix code once a focus-report chunk (`\x1b[I`) and SGR mouse-wheel burst were injected mid-drain — after the fix all narrative (03, 04, park notice, 06, 07, drain fact) flows live past the click/scroll; the same scenario also proves a genuinely composed line ("status?") holds the drain-fact message (still pending after 700ms) and the submit releases it. (b) New unit decision table (11 non-compose sequences, 6 compose inputs) and decay tests were red on pre-fix code, green after. Full runs: `npm run test` 808 passed, `npm run type-check` clean, `npm run test:e2e` 12 passed / 4 declared manual-only. Not exercised in the live Electron shell with a real claude session — that is exactly walkthrough 58's job (issue 58, parked HITL, depends on this issue).

**Bookkeeping**
- `src/shared/dispatcher-channel.ts` — new `isNonComposeInput` classifier (focus in/out reports, SGR + legacy mouse reports, bracketed-paste guards, cursor-position/device-attributes replies; arrow/Home/End/Delete deliberately still count as typing), `COMPOSE_DECAY_MS = 15_000`, `reduceTyping` no-ops on non-compose chunks, `canFlushChat` gains the compose-decay rule (extra optional `decayMs` param — all existing callers unchanged).
- `src/shared/dispatcher-channel.test.ts` — decision-table + decay + re-arm tests (34 new); one existing test retitled ("holds however long" → "holds until the compose decays") since decay bounds the old claim.
- `src/shared/dispatcher-pump.test.ts` — held-queue flush-order test (three items held, released, delivered in enqueue order).
- `e2e/drain-harness.e2e.test.ts` — Scenario 7 pump now consults the real gate (was `canFlush: () => true`); mid-drain focus/mouse injection after issue 02; compose-hold + submit-release around the drain fact.
- No renderer changes: `App.tsx` already folds chat input through `reduceTyping` and gates the pump with `canFlushChat`, so the pure-layer fix lands automatically.
- One deviation of interpretation, not behavior: the issue said non-compose escapes "fold into `lastInputAt` at most" — I made them a full no-op (they don't bump `lastInputAt` either), because counting a scroll as input would let continuous scrolling postpone flushes and the decay indefinitely; rationale documented at the classifier. All acceptance criteria met.

**Doc drift** — none. (ADR-0014 and CONTEXT.md describe the channel model at a level this fix doesn't contradict.)
