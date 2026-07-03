---
status: done
depends_on: [7, 8]
---

# 18 — The `.afk-parallel` marker dirties main and blocks Merge

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). Merge refused with "app has uncommitted changes in <repo>. Commit or stash them first" (surfaced thanks to issue 17). Cause: Mission Control writes `issues/.afk-parallel` (the parallel-mode marker, from issue 07's isolation) into the project, but — unlike `issues/afk-merge.conf`, which MC adds to `.git/info/exclude` — it never git-ignores `.afk-parallel`. So it shows as an untracked change, dirties the working tree, and trips `afk-merge.sh`'s clean-tree preflight, blocking every parallel merge.

## What to build

Ensure the `issues/.afk-parallel` marker never dirties the repo: locally git-ignore it the same way `issues/afk-merge.conf` is handled (add it to `.git/info/exclude` via the existing `ensureLocallyIgnored` helper in `src/main/run-merge.ts`, or wherever the marker is created in the isolation flow). Applying the ignore should be idempotent and must work from a linked worktree (use `git rev-parse --git-path info/exclude`, as the existing helper does). Existing repos that already have an un-ignored `.afk-parallel` should also get it ignored (apply on the merge preflight / when the marker is written), so a repo that already hit this unblocks without manual `git` surgery.

## Acceptance criteria

- [ ] After Mission Control enables parallel mode (writes `issues/.afk-parallel`), the repo's working tree is NOT dirtied by that marker (it is locally ignored).
- [ ] A parallel Merge is not blocked by the `.afk-parallel` marker's presence.
- [ ] The ignore is idempotent and works when invoked from the main checkout (and does not double-append to `.git/info/exclude`).
- [ ] A repo that already has an un-ignored `.afk-parallel` gets it ignored by the fix (no manual cleanup needed to merge).
- [ ] Logic covered by a test against a scratch git repo (marker present → repo reports clean; exclude entry added once).

## Blocked by

- 7
- 8
