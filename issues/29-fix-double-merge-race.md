---
status: done
depends_on: [16]
---

# 29 — [MED] Fix the double-merge race after a successful merge

## Source

Hardening review (2026-07-03), finding state-H3. After a successful merge, `runMerge` sets a success message and filters in-memory `runs` but does NOT refresh `afkScan`. `mergePlan = mergeReadinessOnDisk(afkScan)` stays `ready` with a stale `mergeable` list until the next ~1.5s poll tick, and `merging` is reset in `.finally`, so the Merge button re-enables pointing at now-deleted branches. A second click within the window calls `mergeRuns` on branches that no longer exist → error panel contradicting the success shown a moment earlier.

## What to build

Close the window: after a merge completes, immediately refresh the afk-scan (or optimistically clear the merged slugs from `afkScan`) before re-enabling the Merge button, so the button reflects post-merge disk truth without waiting for the poll tick. Alternatively keep Merge disabled until the next successful scan. Either way, a second Merge click must never target already-merged/deleted branches.

## Acceptance criteria

- [ ] Immediately after a successful merge, the Merge button reflects the post-merge state (gone if nothing left) without a ~1.5s stale window.
- [ ] A rapid second click cannot trigger a merge on already-merged/deleted branches.
- [ ] Test asserts merge readiness is refreshed/cleared synchronously with merge success (not left to the poll).

## Blocked by

- 16
