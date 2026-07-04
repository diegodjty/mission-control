---
issue: 66
slug: run-narrative-into-dispatcher-conversation
outcome: completed
finished: 2026-07-04T04:29:00Z
---
## Completed issue 66 — run-narrative-into-dispatcher-conversation

1. **What changed** — When you run a drain, the Dispatcher's chat now narrates the work live, the way a terminal drain does: as each Run finishes, its full completion report (what changed, how to try it, what was verified) arrives as a message in the conversation, along with "waiting for you" notices when a HITL issue parks, notices when stray Receipts get adopted or a Run ends without a Receipt, and a closing message saying why the drain ended. Before this, all of that was muted into the side activity strip and the chat session literally didn't know work had finished unless you asked. The strip still records everything as history, approval gates are unchanged, and junk/status-churn still stays out of the chat. If the chat session gets replaced mid-drain (or you open one mid-drain), asking it for a status digest catches it up on exactly the Runs it never saw — without ever repeating ones it was already told about live.

2. **Try it yourself** —
   1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22 && npm run dev`
   2. Open a project with drainable issues (the QA sandbox `/Users/devteam/Developer/mc-qa-sandbox/repo-a` after its usual reset works).
   3. Click Drain (cap 1). Watch the **Dispatcher chat panel** (not the activity strip): as each Run finishes you should see one message per Run submitted into the conversation — "Completion block for issue NN (completed) — … What changed: …" — and when the HITL issue parks, the "HITL gate waiting on you…" message with its steps. When nothing eligible remains, a final "Stopped: no eligible issue remains." message lands in the chat.
   4. Then type a question like "what's left?" into the Dispatcher chat: the injected digest should NOT re-list the Runs it just narrated (only the status snapshot appears, plus any Runs this session never saw live).

3. **Verified** — Machine-verified end-to-end by the extended e2e harness (`npm run test:e2e`, new Scenario 7): a real cap-1 mixed drain (real git sandbox, real Receipt watcher, real pump with real timers, scripted lingering Workers) delivered exactly one submitted conversation message per finished Run (containing the block heading + What-changed), the HITL park notice for 05, and the drain-ended fact — in order, across a mid-drain session replacement (02/03 into the first session, 04/park/06/07/fact into the replacement); a digest ask afterwards listed only the two Runs the replacement session never saw and a second ask returned nothing; no status/junk text reached the conversation; the ADR-0011 blocking list asserted unchanged. Also `npm run test` (765 passed, incl. 7 new routing unit tests) and `npm run type-check` clean. NOT verified in the live Electron shell with a real claude conversation (needs the GUI + authenticated claude CLI) — that is exactly walkthrough issue 58's job, which depends on this issue.

4. **Bookkeeping** —
   - New: `src/shared/dispatcher-narrative.ts` (the pure ADR-0014 routing table — chat vs history — plus the pump-key helpers that let live delivery and the issue-61 digest share one "session has seen it" set) and `src/shared/dispatcher-narrative.test.ts` (7 tests).
   - `src/renderer/src/App.tsx`: completed blocks now enqueue into the chat pump under `narrative:<recordId>` (replacing issue 48's ambient-only `synthesize` routing for narrative) while the strip keeps its history line; drain stopped/halted (all three stop paths), stray-Receipt adoptions (solo + merge paths), and finished-without-receipt notes are chat narrative too; blocked/stranded/needs-attention alerts, doc-drift, overlaps, mismatches and status refreshes stay history-only through the same tested table; `dispatcherDigested` renamed to `dispatcherSessionSeen` and unified as the single live+digest seen-set (marked on enqueue and re-marked on pump `submitted`), with a dispatcher-creation baseline that a replacement session resets to so the digest catches it up.
   - `e2e/drain-harness.e2e.test.ts`: new Scenario 7 (all five acceptance criteria as code); Scenario 5's finished-without-receipt assertion updated to the ADR-0014 routing.
   - No deviations from the acceptance criteria.

5. **Doc drift** — `issues/CONFIG.md`'s "Active PRD" line still says the batch is "issues 54–58", but the batch grew to 59–66 (issue 58's `depends_on` lists them) and issues 65/66 link `docs/adr/0014-…` as their Parent rather than the CONFIG-named ADR-0013 — a strict read of the skill's eligibility rule would classify 66 as out-of-batch. Worth updating CONFIG's Active PRD line (or noting ADR-0014 as a batch refinement) before the next AFK run so pick logic can't skip in-batch work. Affects only issue 58 (the remaining wip walkthrough) among open work.
