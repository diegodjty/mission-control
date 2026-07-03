---
status: open
depends_on: [13, 15]
---

# 30 — [MED] Decouple status-read polling from the git-write auto-commit; cut churn/flicker

## Source

Hardening review (2026-07-03), findings state-H4 + M2 + corr-11. `observeIssueStatus` (polled every ~1.5s per isolated Run) calls `readIsolatedIssueStatus`, which performs a git WRITE (`commitFinishedWorktree` = `git add -A` + commit) on every tick — a "read" that mutates. Combined with the separate afk-scan poll (worktree list + for-each-ref + merge-base + `git show` per branch, also 1.5s) this is heavy concurrent git churn during a drain, and a commit landing between the observe tick and the scan tick makes rows/Merge flicker running↔finished. The drain re-plan effect also re-fires `applyIsolation` every tick because `runStatusOf` (dep: `worktreeStatuses`) is in its dependency array.

## What to build

Separate the concerns: perform the auto-commit once on the actual finished transition (event-driven), not on every status-read tick; make status reads pure reads. Reduce/consolidate the two poll loops (share one scan, back off cadence, or drive from the file watcher) so a drain isn't spawning many git subprocesses every 1.5s. Stabilize the drain effect so it doesn't re-run `applyIsolation` on every poll tick. Eliminate the running↔finished flicker.

## Acceptance criteria

- [ ] The status-read path no longer performs a git commit on every tick; commit happens once on the finished transition.
- [ ] Git subprocess volume during a drain is materially reduced (single scan cadence, no per-tick writes).
- [ ] The drain re-plan effect does not re-issue `applyIsolation` on every poll tick.
- [ ] No running↔finished flicker across ticks in the derived states.
- [ ] Tests cover the once-only commit and the reduced re-plan triggering.

## Blocked by

- 13
- 15
