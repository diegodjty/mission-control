---
status: open
depends_on: [69, 70, 71, 72, 73, 74, 75, 76]
hitl: true
---

# 77 — Workbench batch QA walkthrough (HITL)

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench (batch 69–76).

## What to build

Human walkthrough of the assembled Workbench, after `npm run test:e2e` is green (machine-before-human). The runner preps the sandbox: a workbench fixture for the QA sandbox with a two-repo project (repo-a + repo-b) and seeded cross-repo issues, plus a legacy-layout check. The headline seams: registry resolution end-to-end with a **real** claude Worker (74's skill applied), cross-repo drain, memory warm-start.

## Walkthrough checklist

- [ ] **Open by either handle:** open the sandbox project via its workbench dir and via repo-a's path — same Project, one ownership.
- [ ] **Cross-repo drain:** drain the seeded backlog — the repo-a issue runs in repo-a, the repo-b issue (depends_on the first) runs in repo-b after it; narrative messages arrive in the Dispatcher chat per Run.
- [ ] **Receipts + auto-commit:** receipts appear under the workbench project's completions/; `git log` in ~/Workbench shows one boring commit per Run event; repo-a/repo-b logs contain only code commits.
- [ ] **Memory warm start:** put a distinctive fact in the fixture CORE.md → a Worker's Pane shows it was seeded (ask the Worker what it knows); after the drain, one journal entry exists.
- [ ] **Bare-session resolution:** `cd` into repo-a in a plain terminal, run `claude`, ask it to claim the next issue — it finds the workbench backlog via the registry (skill 74).
- [ ] **Legacy still works:** the old in-repo-layout sandbox drains unchanged.
- [ ] **Real backlog:** after migration (76), MC shows the full mission-control Map from the workbench; issue statuses intact.
- [ ] Sign-off: flip this issue done. The Workbench is the ecosystem's data layer from here on.

## Human prerequisites

- Issues 74 and 76 completed (skill applied, migration run).

## Blocked by

- 69, 70, 71, 72, 73, 74, 75, 76
