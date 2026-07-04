---
issue: 65
slug: parked-hitl-run-ends-while-session-lives
outcome: completed
finished: 2026-07-04T04:09:00Z
---
## Completed issue 65 — parked-hitl-run-ends-while-session-lives

**What changed** — A drain no longer gets stuck when it reaches a human-verification (HITL) issue. Previously, when a Worker parked an HITL issue and its terminal window just sat there at the prompt (which is what real Claude sessions always do — they never exit), Mission Control kept reading that Run as "running" forever, so with one concurrency slot the drain waited on a slot that never freed and everything after the HITL issue stalled. Now the Worker's own Receipt file is treated as the word of truth: a Receipt declaring "needs verification" ends the Run in a new terminal **parked** state (the window stays open so you can peek at it), freeing the slot so the drain moves on to the remaining issues; a Receipt declaring "blocked" ends the Run as blocked even while its window lingers, so the drain still halts conservatively exactly as before. A Worker that's still actually working (no Receipt yet) is untouched.

**Try it yourself**
1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22`
2. `npm run test:e2e` — expect all scenarios green; Scenario 3 is now "a cap-1 mixed drain with lingering Workers parks the HITL issue, frees its slot, and completes the rest" (this exact test stalls red if you revert the run-state change).
3. For the live app: reset the QA sandbox (`/Users/devteam/Developer/mc-qa-sandbox/repo-a`, your usual reset pattern), then `npm run dev`, open the sandbox project, and Drain with max-concurrent 1. When the drain reaches the HITL issue and its Worker parks (Receipt written, issue stays wip), the tile badge should flip to a blue "parked", the Pane should stay open at its prompt, and the drain should start the next eligible issue instead of stalling. To stop the dev server: Ctrl-C in its terminal.

**Verified** — Machine-verified end-to-end via the drain harness (`npm run test:e2e`), which drives the real Run Coordinator, real Receipt watcher, real git sandbox: I first made the cap-1 scenario use lingering fake Workers and ran it against the unfixed code — it stalled at the HITL park exactly as walkthrough 58's third attempt did (2 tests red); after the fix the same scenario parks 05, frees the slot, and completes 06/07 (green). Unit decision-table tests, full suite (758 tests), and type-check all pass. Not verified in the live Electron app with real `claude` Panes — that needs interactive LLM sessions, and it's precisely what gate issue 58 (the batch QA walkthrough, parked HITL) will confirm by hand.

**Bookkeeping**
- `src/shared/run-state.ts` — `RunStatus` gains terminal `parked`; `RunFacts` gains optional `receiptOutcome` (declared Receipt outcome); `deriveRunStatus` precedence is now done-flip → user-stop → declared needs-verification (parked) → declared blocked (blocked) → session-death (blocked) → running.
- `src/shared/run-coordinator.ts` — `isParkedHitl` treats a `parked`-status Run as a park directly (a parked Run already frees its slot and never halts the drain, since only `running` occupies a slot and only `blocked` halts).
- `src/renderer/src/App.tsx` — `runStatusOf` feeds `deriveRunStatus` the latest Receipt's declared outcome from the Run log (deps updated).
- `src/renderer/src/index.css` — `.run-status--parked` badge (calm blue — success-waiting, not an error).
- `e2e/fake-worker.ts` — new **linger mode** (`linger: true`): the scripted Worker writes everything, then keeps its session alive; `WorkerTrace.sessionAlive` reports it.
- `e2e/drain-harness.e2e.test.ts` — Scenario 3 (cap-1 mixed drain) now runs with lingering Workers and asserts no full-cap stall plus a `parked` status for 05; Scenario 3b's declared-blocked Worker now lingers too.
- Tests added: 10 unit tests on the extended `deriveRunStatus` decision table + `isTerminal`/`runningIssueIds` (`src/shared/run-state.test.ts`), 3 on `isParkedHitl`/`planDrain` with `parked` status (`src/shared/run-coordinator.test.ts`).
- No deviations from the acceptance criteria.

**Doc drift** — none. The code matched the issue's diagnosis exactly: `deriveRunStatus` only ended a Run on a done flip, a user stop, or session death, and the fake e2e Workers exited (hardcoded `sessionAlive: false`), which is precisely why the harness stayed green through walkthrough 58's stall.
