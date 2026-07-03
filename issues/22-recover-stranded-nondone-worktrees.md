---
status: open
depends_on: [15, 16]
---

# 22 — [HIGH] Blocked/stopped/commit-failed Runs must not strand worktrees or block the batch Merge

## Source

Hardening review (2026-07-03), findings corr-1 + corr-5 + state-M3. `isRunning = hasWorktree && committedStatus !== 'done'`, so a Run that blocked/stopped (never commits `done`) is classified `running` **forever**, keeps its worktree, and — via `mergeReadinessOnDisk`'s `pendingRunning` gate — **suppresses Merge for its finished siblings** indefinitely, with no in-app way to clear it. Commit failures in `commitFinishedWorktree` are swallowed (returns false silently), producing the identical stuck-"running" state for a Run that actually finished. Dismissing a blocked/stopped isolated Run drops it with no warning and never removes its worktree (orphaned).

## What to build

- Distinguish a truly-in-flight Run from a stranded one: a worktree whose Run has ended (blocked/stopped/exited) without a `done` commit must NOT read as `running` forever nor block the batch Merge. Provide an in-app action to resolve it — discard (force-remove the worktree + delete its branch) or keep — so finished siblings can merge.
- Warn before dismissing an isolated Run that has a worktree with uncommitted work (currently only `finished` triggers the warning).
- Surface auto-commit failures instead of swallowing them: a finished Run whose commit failed should show a distinct "commit failed" state (with the error), not look like it's still running.

## Acceptance criteria

- [ ] A blocked/stopped isolated Run does not read as `running` forever and does not indefinitely suppress Merge for finished siblings.
- [ ] There is an in-app way to discard/clean a stranded worktree+branch (force remove) so the batch can proceed.
- [ ] Dismissing any isolated Run with uncommitted worktree work warns first.
- [ ] A swallowed commit failure surfaces as a distinct, visible "commit failed" state rather than perpetual "running".
- [ ] Pure classification (in-flight vs stranded vs commit-failed) unit-tested; the discard path exercised against a scratch repo.

## Blocked by

- 15
- 16
