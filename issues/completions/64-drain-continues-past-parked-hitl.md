---
issue: 64
slug: 64-drain-continues-past-parked-hitl
outcome: completed
finished: 2026-07-04T00:26:43Z
---
## Completed issue 64 — drain-continues-past-parked-hitl

**What changed** — Until now, when a drain hit a HITL issue and the Worker parked it for you to verify, Mission Control treated that exactly like a crash: the whole drain stopped, and every remaining issue just sat there until you noticed. Now the drain can tell the difference between "the Worker parked this for the human — that's success" and "the Worker genuinely got stuck." A park no longer halts anything: the drain notifies you once (the existing HITL notification), skips that issue, and keeps working through everything else. Only issues that actually depend on the parked one wait for it. A Worker that truly reports itself blocked — or one that dies leaving no Receipt behind — still stops the drain conservatively, exactly as before. The park/blocked call is made purely from declared facts (the Receipt's stated outcome and the issue's HITL marker), never from guessing at prose.

**Try it yourself**
1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22`
2. `npm run test:e2e` — expect all green (~6s). Look for "Scenario 3: a cap-1 mixed drain continues past the HITL park", plus the new 3b (declared-blocked still halts) and 3c (die-mid-exit still halts).
3. For a live look: reset the QA sandbox (`/Users/devteam/Developer/mc-qa-sandbox/repo-a`) to its clean state, run `npm run dev`, open repo-a, and start a Drain with cap 1. When the drain reaches the HITL issue (the one flagged `hitl: true`) and its Worker parks it, you should see the "HITL gate waiting" notification — and the drain should carry on starting the remaining eligible issues instead of stopping. At the end, everything runnable is done, the HITL issue shows `wip` awaiting you, and any issue depending on it is still open.

**Verified** — Machine-verified end-to-end via the e2e harness (real git sandbox, real Receipt watcher, real coordinator re-planning, real pump into a scripted chat PTY): the cap-1 mixed drain started `[2,3,4,5,6,7]`, parked 05 `wip`, left the new dep-on-05 issue 08 unstarted, delivered exactly one hitl-waiting notification, and stopped with `no-eligible` (never `run-blocked`); a Worker declaring `outcome: blocked` and a Worker dying with no Receipt and no flip both still halted the drain. Not driven in the live Electron shell with real `claude` Panes — that is the batch QA walkthrough's territory (issue 58, per CONFIG's machine-before-human rule), and the harness's manual-only specs declare that gap explicitly.

**Bookkeeping** — Files touched: `src/shared/run-coordinator.ts` (new pure `isParkedHitl` decision; `ActiveRun.receiptOutcome`; the halt rule now ignores parked Runs), `src/shared/receipt-audit.ts` (new `latestReceiptOutcomeFor`, shared latest-Receipt-per-issue helper), `src/renderer/src/App.tsx` (drain re-plan feeds each Run's latest declared Receipt outcome; `runLog` added to the drain effect deps so a Receipt landing a beat after session exit re-plans), `e2e/sandbox.ts` (seeded issue `08-blocked-on-hitl`, `depends_on: [5]`), `e2e/drain-harness.e2e.test.ts` (Scenario 3 rewritten to assert park continuation + one hitl-waiting delivery; new Scenarios 3b/3c for the conservative halts). Tests added: 16 unit (run-coordinator), 4 unit (receipt-audit), 2 e2e + Scenario 3 rewrite. Suite: 746 unit tests, type-check, and 11 e2e all green. No deviations from the acceptance criteria.

**Doc drift** — none. The issue's description of the failure (coordinator derives a park as `blocked`, a blocked Run halts the drain) matched the code exactly, and issue 58's parked walkthrough text contains no "stop the drain to preserve 06/07" step that would now be stale.
