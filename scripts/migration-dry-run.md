# Migration dry-run report — MC backlog -> ~/Workbench/mission-control (issue 76)

Generated: 2026-07-05T14:56:13.579Z by `scripts/migrate-backlog-to-workbench.ts` (mode: **dry-run**).

## File counts

- Issue files: **77**
- Receipts (completions): **18**
- PRDs: **2**
- HUMAN-SETUP.md: **1**

## Parent-link rewrites

- **49** link rewrites across **49** issue files (`docs/PRD*.md` -> workbench-root `PRD*.md`; `docs/adr/...` -> `~/Developer/mission-control/docs/adr/...` — ADRs stay with the code per ADR-0015).

## CONFIG merge (issue 69 scaffold wins on conflicts)

- Sections appended from in-repo CONFIG: **Active PRD**, **Repo**, **Parallel mode**
- Conflicts (scaffold's body kept): **Test commands**
- The issue-69 scaffold note is replaced by a migration note.

## Registry

- `~/Workbench/registry.md`: mission-control entry would be flipped to `status: active` and the INACTIVE comment removed.

## Diff summary

- Create: **98**, update: **2**, unchanged: **0**.
  - update: `/Users/devteam/Workbench/mission-control/CONFIG.md`
  - update: `/Users/devteam/Workbench/registry.md`
- Dry-run: **nothing was written**. Re-run with `--execute` to apply.

## Human follow-up steps (after --execute)

Machine-before-human gate: run these only after `npm run test:e2e` is green.

1. `source ~/.nvm/nvm.sh && nvm use 22 && npm run test:e2e`  # must be green first
2. `node scripts/migrate-backlog-to-workbench.ts --execute`
3. Spot-check `~/Workbench/mission-control/` (Map opens in MC; statuses intact).
4. Remove the originals so exactly one source of truth remains:
   `git -C ~/Developer/mission-control rm -r issues docs/PRD.md docs/PRD-dispatcher.md`
5. Add a pointer note to `README.md`, e.g.:
   > The backlog (issues, Receipts, PRDs, HUMAN-SETUP) moved to `~/Workbench/mission-control/`
   > per ADR-0015 (migration issue 76). Git history preserves the originals.
6. `git -C ~/Developer/mission-control add README.md && git -C ~/Developer/mission-control commit -m "chore: backlog moved to ~/Workbench/mission-control (issue 76, ADR-0015)"`
7. `git -C ~/Workbench add -A && git -C ~/Workbench commit -m "migrate mission-control backlog from in-repo (issue 76)"`
8. Verify: a bare `claude` session in the MC repo resolves the backlog via the registry (issue 74), and MC shows the full Map via the workbench.
