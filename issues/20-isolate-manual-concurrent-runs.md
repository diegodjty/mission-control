---
status: done
depends_on: [7]
---

# 20 — [CRITICAL] Manual concurrent Runs must isolate, like drains do

## Source

Hardening review (2026-07-03), finding state-C1. `applyIsolation` is called only inside the drain effect (`App.tsx`, gated by `if (!draining) return`). The manual "▶ Run" path (`startRun`) appends a Run whose cwd is the main checkout and never reconciles isolation. Two manual Runs → two agents editing the same working tree / same `issues/*.md` concurrently → clobbered files and racing `wip`/`done` flips directly on `main`. The whole worktree isolation design (ADR-0002) is bypassed for manually-started concurrent Runs, which the UI fully supports (adaptive grid tiling).

## What to build

Route the manual `startRun` path through the same isolation reconcile the drain uses: whenever 2+ Runs are concurrently active (started manually OR via drain), each must get its own worktree on an `afk/NN-slug` branch; a lone Run stays solo on `main`. Isolation must be a function of concurrency, not of which button started the Run. Consolidate so there is one path that decides+applies isolation before a Pane spawns, used by both entry points.

## Acceptance criteria

- [ ] Starting a second manual Run while one is active isolates BOTH into worktrees (neither runs on the shared `main` checkout).
- [ ] A single manual Run still runs solo on `main` (no worktree).
- [ ] Drain behavior is unchanged.
- [ ] A test asserts two concurrent manual Runs each get a worktree (the isolation decision is exercised via the manual path, not only the drain path).

## Blocked by

- 7
