---
status: done
depends_on: [9]
---

# 31 — [MED] Multi-window IPC handlers must verify repo ownership

## Source

Hardening review (2026-07-03), finding state-M5. The `IssueStatusObserve`, `AfkScan`, `IsolationApply`, and `MergeRuns` handlers in `main/index.ts` act on `req.projectPath` with no check that the calling Window owns that repo in the Project Registry. Normally only the owner polls a path, but a Window mid-release (registry-changed in flight, `activeRepoPath` not yet cleared) or a renderer bug with a stale `projectPath` can drive worktree creation, auto-commits, or a Merge on a repo it no longer owns — concurrently with the real owner. No serialization exists between Windows for git-worktree mutations.

## What to build

Have the mutating/observing handlers verify the calling Window (webContents id) currently owns `req.projectPath` in the registry before acting; reject otherwise. Consider a lightweight per-repo serialization so two Windows can't drive concurrent git-worktree mutations on the same repo even transiently.

## Acceptance criteria

- [ ] Isolation/merge/observe/scan handlers reject requests from a Window that does not own the target repo.
- [ ] A Window mid-release cannot drive a worktree mutation / merge on the repo it's releasing.
- [ ] Concurrent git-worktree mutations on one repo from two Windows are prevented (rejected or serialized).
- [ ] Tests cover the ownership rejection.

## Blocked by

- 9
