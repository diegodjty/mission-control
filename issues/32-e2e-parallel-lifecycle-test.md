---
status: done
depends_on: [20, 21, 22, 23, 24, 25, 26]
---

# 32 — [TEST] End-to-end parallel-lifecycle integration test + coverage gaps

## Source

Hardening review (2026-07-03). Both reviewers independently concluded the same thing: the pure modules are well covered, but every shipped bug and every finding lives at the **integration/composition layer**, which has no coverage. Add the end-to-end harness they converged on, plus the targeted gap tests. Runs last, after the Wave-1 fixes (20–26), so it encodes the corrected invariants.

## What to build

`src/main/parallel-lifecycle.e2e.test.ts` driving the real adapters + real `afk-merge.sh` against a scratch git repo, asserting reported state matches ground truth at each hop:
1. `git init -b main` scratch repo; `issues/03-a.md`, `04-b.md`, `05-c.md` (`wip`) + initial commit.
2. `applyIsolation(repo,[3,4,5])` → assert `.afk-parallel` written+ignored, three worktrees on `afk/*`.
3. Finish 03 & 04 (edit a file + flip `done`) via `readIsolatedIssueStatus` (drives commit); leave 05 `wip`/uncommitted (blocked).
4. **(findings 22/corr-1,5)** `deriveWorktreeRunStates` → 03/04 finished-unmerged, 05 running; `mergeReadinessOnDisk.ready===false` while 05 lingers; discard 05's worktree → `ready===true`, `mergeable===[03,04]`.
5. **(findings 23/corr-2,9)** `mergeRuns(repo,['03-a','04-b','99-ghost'])` → `merged` excludes the ghost; both files on `main`; 03/04 worktrees+branches gone; message count matches reality.
6. **(finding 24/corr-3)** partial-conflict variant: 03/04 edit the same file; `mergeRuns([3,4])` → first committed on main, report doesn't claim both, `conflicted===true`, and an in-app abort restores a clean `main`.
7. **(finding 25/corr-4)** solo-dirties-main variant: solo Run done → assert MC committed it and `main` is clean so a later parallel merge preflight passes.

Also add the unit-level gap tests the reviews listed: banner/detail-button suppression composed with worktree sets (21), duplicate-run refusal (21), project-switch reset + id-scoping (26), non-`main` default branch (27), double-merge race guard (29), stale-`worktreeStatuses` clear (21), auto-commit-failure surfaced (22).

## Acceptance criteria

- [ ] The e2e harness exists and drives isolate→commit→status→merge→cleanup against real git + real `afk-merge.sh`, asserting report-vs-truth at each hop.
- [ ] The partial-conflict and solo-dirties-main variants are covered.
- [ ] The listed composition-layer unit gaps have tests.
- [ ] Full suite + type-check + build green.

## Blocked by

- 20
- 21
- 22
- 23
- 24
- 25
- 26
