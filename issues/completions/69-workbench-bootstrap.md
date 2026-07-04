---
issue: 69
slug: workbench-bootstrap
outcome: completed
finished: 2026-07-04T00:00:00Z
---
## Completed issue 69 — workbench-bootstrap

**What changed** — Your machine now has the Workbench: a brand-new private git repo at `~/Workbench/` that will become the single home for every project's pipeline paperwork (backlogs, PRDs, Receipts, memory) so none of it has to ride inside shared code repos anymore. Right now it's the empty shell, correctly shaped: a registry file that maps code repos to their Workbench project (with mission-control listed but deliberately switched off until the migration issue flips it), a scaffolded `mission-control/` project folder with its config and empty issue/completion folders, and a seeded memory file holding a handful of true facts about the MC project that future agent sessions will be warm-started with. Nothing moved yet — the live backlog still lives in the mission-control repo, untouched, until issue 76.

**Try it yourself**
1. `ls ~/Workbench` — you should see `README.md`, `registry.md`, and `mission-control/`.
2. `git -C ~/Workbench log --oneline` — exactly one commit: `Workbench bootstrap: registry, mission-control scaffold, README (issue 69)`.
3. `cat ~/Workbench/registry.md` — the schema documented by example, with the mission-control entry marked `status: inactive` and a comment saying issue 76 activates it.
4. `cat ~/Workbench/mission-control/memory/CORE.md` — the seeded facts (Node 22 via nvm, test commands, machine-before-human rule, QA sandbox path + reset). Check they read true to you — this file gets injected into future Worker prompts.
5. `git -C ~/Workbench remote -v` — empty: no remote was created (creating the **private** remote is your HUMAN-SETUP item).

**Verified** — No app runtime surface; the deliverable is the repo itself, verified by direct inspection: `git log` shows the single root commit, `git status` clean, full tree matches ADR-0015's layout (registry, project CONFIG with `repos:`/`default_repo`/test commands, empty `issues/`+`completions/`, `memory/CORE.md` + `topics/` + `journal/`, README, `.gitignore` covering `.obsidian/workspace.json`). Confirmed `git status` in the mission-control repo shows no code-repo modification beyond this issue's status flip and this Receipt. No MC code touched, so `npm run test`/`type-check`/`test:e2e` were not required.

**Bookkeeping** — Files created (all in the new `~/Workbench` repo, committed there as `ce7a4ab`): `README.md`, `registry.md`, `.gitignore`, `mission-control/CONFIG.md`, `mission-control/memory/CORE.md`, plus `.gitkeep`s in `mission-control/issues/`, `completions/`, `memory/topics/`, `memory/journal/`. In this repo: `issues/69-workbench-bootstrap.md` (status → done) and this Receipt. No tests added (no code). One judgement call: the ADR tree shows `meetings/ todos/` as RESERVED with "shapes undesigned (own grills)" — I documented them in the README instead of creating empty placeholder dirs, since git wouldn't track them empty and their shapes are explicitly not designed yet. The `.obsidian/` dir likewise isn't pre-created — Obsidian makes it when you first open the vault; the gitignore rule is already in place for `workspace.json`.

**Doc drift** — none. One observation, not drift: an old untracked `SESSION-HANDOFF.md` sits in the mission-control repo root describing the pre-Receipts scroll-scraping era — stale residue, safe to delete, not blocking anything.
