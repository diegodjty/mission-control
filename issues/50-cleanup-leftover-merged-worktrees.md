---
status: done
depends_on: []
---

# 50 — Clean up leftover worktrees after a merged drain

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration; refines issues 08/23).

## What to build

After the dogfood drain merged all 7 issues, two worktrees (`.afk-worktrees/02-run-me`, `.afk-worktrees/05-manual-check`) and their `afk/` branches were left on disk though their work was merged into `main`. The merge cleanup (`src/main/run-merge.ts`, issue 23 — removes worktree + deletes branch for each *actually-merged* slug) is missing some cases — likely the solo-committed-then-merged path, or worktrees created for Runs that later merged via a different route. Ensure that once a slug's work is confirmed merged into the default branch, its worktree and `afk/` branch are removed, so a completed drain leaves no `.afk-worktrees` residue. Do not remove a worktree/branch whose work is NOT yet merged (that's still finished-unmerged and mergeable).

## Acceptance criteria

- [ ] After a drain where all issues merge, no `.afk-worktrees/*` directories and no merged `afk/*` branches remain.
- [ ] A finished-unmerged (not-yet-merged) worktree/branch is NOT removed.
- [ ] The "is this slug merged into the default branch → safe to remove" check reuses the existing merged-detection (issue 27's default-branch-aware `isMergedIntoDefaultBranch`).
- [ ] Verified against a real scratch repo (merge, then assert worktrees/branches gone; an unmerged one survives).
- [ ] type-check + build pass.

## Blocked by

None - can start immediately.
