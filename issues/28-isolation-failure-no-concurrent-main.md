---
status: open
depends_on: [7]
---

# 28 — [MED] Isolation failure must not silently run multiple agents on main

## Source

Hardening review (2026-07-03), findings corr-7 + corr-6. On any `applyIsolation` rejection (worktree error, partial reconcile, disk error), `App.tsx`'s catch falls back to `addRuns(() => projectPath)` — spawning ALL startable Runs on the shared `main` checkout. With 2+ Runs that is exactly the concurrent-main collision isolation exists to prevent. Separately, `reconcile` diffs the desired set against ALL on-disk worktrees, so a fresh solo drain can emit `remove-worktree` for leftover worktrees from a previous batch (not in the tracked set) and `disable-parallel` while unmerged branches are pending; if a leftover has uncommitted work the non-force remove throws mid-apply, leaving a partial application that triggers the concurrent-main fallback.

## What to build

- On isolation failure with 2+ startable Runs, do NOT silently degrade to concurrent Runs on `main`: stop and report (surface the error, let the user retry/resolve) rather than running unsafe. A single Run may still proceed solo.
- Don't let `reconcile` tear down worktrees it never surfaced as part of this batch: scope removals to the batch's own runs, or leave leftover/unmerged worktrees intact (they belong to pending Merges) instead of removing them + disabling parallel mode as a side effect of starting an unrelated solo Run.

## Acceptance criteria

- [ ] An `applyIsolation` failure with 2+ startable Runs surfaces an error and does not spawn multiple agents on `main`.
- [ ] Starting a new solo drain does not remove leftover finished-unmerged worktrees from a previous batch or disable parallel mode out from under pending Merges.
- [ ] A partial reconcile failure does not cascade into the concurrent-main fallback.
- [ ] Tests cover the failure-path (no concurrent main) and the leftover-worktree preservation.

## Blocked by

- 7
