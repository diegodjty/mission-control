---
status: open
depends_on: [9, 16]
---

# 26 — [HIGH] Reset run/scan/status/merge state on Project switch

## Source

Hardening review (2026-07-03), findings state-H1 + M4 + M6. Switching the active Project changes only `activeRepoPath`; `runs`, `afkScan`, `worktreeStatuses`, and `mergeDisplay` persist. Worktree indicators are keyed by bare issue-id, so Project A's "issue 05 finished-unmerged" marks Project B's issue 05 and offers a **bogus Merge against Project B** (running afk-merge.sh on a branch that doesn't exist there). Project A's in-memory Runs stay tracked and their `isIsolated` flips relative to B. On a transient scan error the code "keeps the last scan" — the previous Project's branches.

## What to build

On a Project switch, reset all per-Project run/merge state: clear `runs` (and unmount their Panes) or scope them to the owning Project, clear `afkScan`, `worktreeStatuses`, and `mergeDisplay`, and don't show any worktree/merge indicator until a fresh scan of the new Project completes. Ensure issue-id-keyed indicators can never bleed across Projects (scope them to the active repo). On a transient scan error after a switch, do not display the previous Project's branches.

## Acceptance criteria

- [ ] After switching Projects, no run/scan/merge state from the previous Project is shown (no bogus "finished-unmerged", no stale Merge button, no stale merge message).
- [ ] Worktree/finished-unmerged indicators are scoped to the active Project — a shared issue-id across two Projects never cross-contaminates.
- [ ] In-memory Runs/Panes from the previous Project don't count toward the new Project's drain/merge planning.
- [ ] A transient scan error right after a switch shows no indicators rather than the previous Project's.
- [ ] Tests cover the reset and the id-scoping.

## Blocked by

- 9
- 16
