---
status: open
depends_on: [6]
---

# 07 — Parallel isolation: a worktree per concurrent Run

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Make concurrent Runs safe. Introduces the **Isolation Policy** — a pure module encoding ADR-0002: given the set of active Runs, decide whether each works on `main` (solo — exactly one Run) or in its own git worktree on an `afk/NN-slug` branch (parallel — two or more), and when parallel mode should be enabled (`issues/.afk-parallel`). The **Git/Worktree Adapter** executes the create/remove/toggle commands the policy emits.

A lone Run still works on `main` with no worktree; the worktree tax is paid only when actually running in parallel.

## Acceptance criteria

- [ ] Starting a second concurrent Run auto-enables parallel mode and gives each active Run its own worktree on an `afk/NN-slug` branch.
- [ ] A single Run continues to work on `main` with no worktree.
- [ ] Dropping back to a single active Run behaves as solo again.
- [ ] The Isolation Policy is a pure module, unit-tested: 1 Run → main/no worktree; 2+ → worktree each + parallel enabled; correct transitions.
- [ ] The Git/Worktree Adapter is exercised by an integration check (worktrees actually created/removed on a scratch repo).

## Blocked by

- 06
