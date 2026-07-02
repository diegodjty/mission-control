---
status: open
depends_on: [1, 2, 3, 4, 5, 6, 7, 8, 9]
hitl: true
---

# 10 — Batch QA walkthrough (HITL)

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Not a build slice — the manual walk-through of the assembled Execution view, done as a human, against the PRD's user stories. Per-issue acceptance criteria all passing while the whole feature is broken at the seams is exactly what this catches. The runner preps what it can (a scratch repo with a small seeded `issues/` backlog, exact `npm run dev` start command, any test Project paths) and hands over this checklist.

Work through each item as a real user and confirm the expected outcome:

## Acceptance criteria

- [ ] **Launch:** `npm run dev` opens Mission Control as a desktop app with a Window. (stories 29, 30)
- [ ] **See the backlog:** point it at the seeded Project → the Map lists every issue with correct status, in-batch/standalone, and HITL badges. (1, 6, 8)
- [ ] **Graph & blocks:** the dependency graph renders; a blocked issue names its unmet dependency; an unblocked one shows eligible. (2, 3, 4)
- [ ] **Run one issue (the core seam — 02→03):** start a Run on an eligible issue → a fresh interactive Pane opens running `/afk-issue-runner` → type into it, answer a prompt → issue reaches `done` → the Map updates on its own. (5, 7, 9, 11, 12, 13, 15, 22)
- [ ] **Stop:** start a Run, stop it → the session terminates cleanly and the Map shows it not-done. (14)
- [ ] **Drain + concurrency (seam 03→06):** hit drain with several eligible issues and a cap of 2 → exactly 2 Panes run, the rest queue and start as slots free, drain stops with a stated reason. (17, 18, 19, 20, 21)
- [ ] **Parallel isolation (seam 06→07):** during a 2-up drain, confirm each Run is in its own worktree/branch and a single Run works on `main`. (22, 23)
- [ ] **Merge (seam 07→08):** when the parallel Runs finish, a Merge button appears → trigger it → branches integrate into `main`, conflicts (if any) are surfaced, worktrees cleaned up. Confirm it never merged on its own. (24, 25, 26, 27)
- [ ] **Multiple projects/windows (seam 03→09):** register a second Project, open it in a second Window → both live against one backend, no port error; try to open the same repo twice → blocked with a message; switch active Project in a Window. (28, 29, 30, 31, 32)
- [ ] **Permissions:** during a Run, trigger something that would prompt for permission → the prompt appears in the Pane and approving/denying there works. (13)

## Blocked by

- 01, 02, 03, 04, 05, 06, 07, 08, 09

## Human prerequisites

- The **`claude` CLI** must be installed and authenticated on this machine (Mission Control spawns it) — see `HUMAN-SETUP.md`.
- **Node 22** and **git** available on PATH — see `HUMAN-SETUP.md`.
