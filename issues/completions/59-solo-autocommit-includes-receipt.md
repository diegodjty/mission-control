---
issue: 59
slug: solo-autocommit-includes-receipt
outcome: completed
finished: 2026-07-03T21:47:47Z
---
## Completed issue 59 — solo-autocommit-includes-receipt

**What changed.** Mission Control no longer races the Worker's Receipt when it auto-commits a finished solo Run. Before, the moment an issue flipped to done, MC committed everything on main — but the Worker writes its Receipt file *last*, so the Receipt landed a beat after the commit and sat there uncommitted, leaving main permanently dirty and making every later Merge fail with a misleading "conflict" you could approve but never resolve. Now "finished" means "done flip AND Receipt present": MC waits briefly (5 seconds) for the Receipt and makes ONE commit containing the work, the issue flip, and the Receipt. If the Receipt never shows up in time, the work commits anyway (no stall — the existing "finished without a Receipt" note is the signal), and a Receipt that straggles in later is committed by a quiet follow-up. Separately, when a Merge is refused because main has uncommitted changes, the message now tells the truth — it names the actual offending files ("uncommitted changes on main: <paths>") instead of dressing up as a conflict, and the Dispatcher no longer offers an Approve button that could only retry into the same failure; it leaves a plain note in the activity log instead. Real merge conflicts still gate for approval exactly as before.

**Try it yourself.**
1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22 && npm run dev` — Mission Control opens.
2. Open the QA sandbox project (`/Users/devteam/Developer/mc-qa-sandbox/repo-a`, reset it first if it has leftovers) and Run any issue showing as eligible, solo (single Run, no drain).
3. When the Run finishes, wait ~5 s and check the sandbox repo: `git -C /Users/devteam/Developer/mc-qa-sandbox/repo-a status` should be **clean**, and `git -C /Users/devteam/Developer/mc-qa-sandbox/repo-a show --name-only HEAD` should list the deliverable, the issue file, AND `issues/completions/NN-slug.md` in the **same** commit.
4. For the merge-message half: dirty main by hand (`echo x >> README.md` in the sandbox) while a finished-unmerged parallel branch exists, then hit Merge. You should see "Merge preflight failed: uncommitted changes on main: README.md…" — named paths, no Approve/Reject buttons for it in the Dispatcher panel (a passive note in the activity log instead). `git checkout README.md` and Merge again — it goes through.

**Verified.** Exercised against real git and the real `afk-merge.sh` (not mocks) via the integration suites: (a) the exact skill write-order — flip done → beat → Receipt — ends in ONE commit containing deliverable + flip + Receipt with main clean, and re-observation never double-commits; (b) the grace-window path — no Receipt in time → work commits without it, the late Receipt is committed by the next observation, then everything is a no-op; (c) a dirty main checkout makes the real merge script refuse and the surfaced message names `uncommitted changes on main: README.md` and never says "conflict"; (d) a real conflict still classifies as the approvable `merge-conflict` gate (unchanged tests all pass). Not runtime-verified: the live Electron renderer wiring (the React effect's timers and the Dispatcher panel note) — that layer is type-checked and its decisions are the unit-tested pure functions, and it is exactly what walkthrough issue 58 (which depends on this issue) drives live.

**Bookkeeping.**
- `src/shared/run-state.ts` — new pure `decideSoloCommitStep` + `SoloCommitPhase` (the Receipt-aware finished/commit decision).
- `src/shared/merge-output.ts` — new pure `dirtyPathsFromPorcelain` + `dirtyTreeMessage` (the truthful preflight message).
- `src/shared/dispatcher-merge.ts` — `decideDispatcherMerge` now splits: real conflict → `gate` (approvable, unchanged); any other failure → new `halt` kind (passive note, no approval).
- `src/shared/dispatcher-authority.ts` / `dispatcher-proposal.ts` — new `merge-preflight` action, classified **passive** (ADR-0011 three-item blocking list unchanged).
- `src/main/run-merge.ts` — dirty-tree refusals read `git status --porcelain` to name the offending paths (the script's own die line only names the repo directory).
- `src/renderer/src/App.tsx` — solo auto-commit effect rewritten around the pure decision (grace timer per Run, Receipt ingest triggers immediate commit, straggler follow-up; bookkeeping reset on project switch and fresh re-Runs); merge result handling gains the `halt` branch.
- Tests: +23 (decision-table unit tests, porcelain/message unit tests, dispatcher decision split, two real-git integration scenarios, strengthened dirty-tree merge assertion). `npm run test` 685/685, `npm run type-check` clean, `npm run build` clean.
- No deviations from the acceptance criteria.

**Doc drift.** None against the PRD/ADR-0013. One code-level note: the issue implied the offending paths could come from the merge script's output, but `afk-merge.sh`'s dirty-tree die line names only the repo directory — the adapter reads the paths itself from `git status --porcelain`, which satisfies the acceptance criterion as written.
