---
status: done
depends_on: []
---

# 69 — Workbench bootstrap: repo, registry, scaffold

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

Create `~/Workbench/` as a fresh git repo per ADR-0015's layout: `registry.md` (documented schema: repo path → project mapping; include the mission-control entry but commented/marked inactive until migration issue 76 activates it), `mission-control/` scaffold (`CONFIG.md` with `repos: {app: ~/Developer/mission-control}` + `default_repo: app` + test commands copied from the current in-repo CONFIG; empty `issues/`, `completions/`; `memory/CORE.md` seeded with 3–5 true facts about the MC project — Node 22 via nvm, test commands, sandbox location; `memory/topics/`, `memory/journal/` with .gitkeep), a root README (what this repo is, the lens-not-dependency Obsidian rule, the privacy requirement), and `.gitignore` covering `.obsidian/workspace.json`. Initial commit. Do NOT touch the mission-control repo's existing backlog (that's issue 76) and do NOT create a git remote (HUMAN-SETUP item).

## Acceptance criteria

- [ ] `~/Workbench/` is a git repo matching ADR-0015's tree, committed, with the registry schema documented by example.
- [ ] `mission-control/CONFIG.md` carries the `repos:` map + `default_repo` + test commands; memory skeleton exists with a truthful seeded CORE.md.
- [ ] Registry's mission-control entry present but explicitly inactive (migration flips it).
- [ ] Nothing in any code repo is modified.

## Blocked by

None - can start immediately.
