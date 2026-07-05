---
issue: 76
slug: migration-mc-backlog
outcome: needs-verification
finished: 2026-07-05T15:02:00Z
---
## Ready for manual verification — issue 76 — migration-mc-backlog (HITL)

**What I prepped.** The Workbench migration is scripted and rehearsed, but deliberately not executed — a Worker moving the live backlog it is dispatched from is self-referential, so the real run is yours. The script (`scripts/migrate-backlog-to-workbench.ts`) is idempotent and dry-run by default: it copies all 77 issue files, the Receipts, both PRDs, and HUMAN-SETUP.md into `~/Workbench/mission-control/`, rewrites the 49 `## Parent` links (PRDs point at the workbench root; ADR parents point back into the code repo at `~/Developer/mission-control/docs/adr/`, since ADRs stay with the code per ADR-0015), merges the in-repo CONFIG into the issue-69 scaffold (scaffold wins the one conflict, `## Test commands`; it appends `## Active PRD`, `## Repo`, `## Parallel mode`), activates the mission-control registry entry, and prints a verification report. It never deletes anything — the `git rm` cleanup and README pointer note are your steps, printed at the end of its report. The dry-run report is committed at `scripts/migration-dry-run.md` (commit `4ae8d62`).

**What I verified.** `npm run test:e2e` green before the report was written (Test Files 2 passed, Tests 20 passed | 8 skipped — the skips are the declared `manual-only` items). Full unit suite green (957 tests, including 20 new ones for the rewrite/merge/registry logic and a temp-dir integration run proving idempotency), `npm run type-check` clean. The real dry-run's counts match reality: 77 issue files, 18 receipts, 2 PRDs, 1 HUMAN-SETUP, 49 link rewrites across 49 files (the other 28 issues are standalone with no `## Parent`). I also printed the planned merged CONFIG, registry, and a rewritten issue to confirm content, without writing anything.

**What I did NOT do (yours by design).** No `--execute`, no `git rm`, registry still `status: inactive`, issue 76 left `wip`.

**Your steps (run in `~/Developer/mission-control`, after the dispatcher's park commit lands):**

1. Review the committed dry-run report: `cat scripts/migration-dry-run.md` — sanity-check the counts and the follow-up steps.
2. `source ~/.nvm/nvm.sh && nvm use 22 && npm run test:e2e` — must be green again at execute time (machine-before-human). Expect: `Test Files 2 passed (2)`, `Tests 20 passed | 8 skipped (28)`.
3. `node scripts/migrate-backlog-to-workbench.ts --execute` — expect the same report in **execute** mode with `Create: 99, update: 2` (99, not the dry-run's 98: this Receipt for issue 76 was written after the dry-run, so receipts read 19 at execute time). The 2 updates are the merged `~/Workbench/mission-control/CONFIG.md` and the activated `~/Workbench/registry.md`.
4. Spot-check `~/Workbench/mission-control/` — issues all present with statuses intact, `registry.md` shows `status: active` for mission-control.
5. `git -C ~/Developer/mission-control rm -r issues docs/PRD.md docs/PRD-dispatcher.md` — if git complains about local modifications, the park commit hasn't landed yet; commit `issues/` first.
6. Add the pointer note to `README.md` (suggested text is in the report), then `git -C ~/Developer/mission-control add README.md && git -C ~/Developer/mission-control commit -m "chore: backlog moved to ~/Workbench/mission-control (issue 76, ADR-0015)"`.
7. `git -C ~/Workbench add -A && git -C ~/Workbench commit -m "migrate mission-control backlog from in-repo (issue 76)"`.
8. Verify acceptance: open MC and confirm the mission-control Project resolves via the workbench and shows the full Map; start a bare `claude` session in the MC repo and confirm it resolves the backlog via the registry (issue 74's skill).
9. When satisfied, flip `~/Workbench/mission-control/issues/76-migration-mc-backlog.md` to `status: done` (the workbench copy — the in-repo one is gone after step 5).

**Bookkeeping.** New: `scripts/migrate-backlog-to-workbench.ts`, `scripts/migration-dry-run.md`, `src/main/migrate-backlog-to-workbench.test.ts` (20 tests). Modified: `tsconfig.node.json` (type-check now covers `scripts/`). Committed as `4ae8d62`; the issue-76 `wip` flip and this Receipt are left uncommitted per solo mode.

**Doc drift.** None — reality matched the issue (77 issue files, 2 PRDs, receipts present; HUMAN-SETUP.md lives at `issues/HUMAN-SETUP.md` and is handled from there).
