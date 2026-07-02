---
status: done
depends_on: [15]
---

# 16 — Map reflects worktree-Run progress, and Merge survives closing Panes

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). Two robustness/visibility gaps observed alongside the commit bug (issue 15):
1. During a parallel drain, the Map showed issues 02/03/04 as plain `open` the whole time — no indication they were being worked or had finished — because their progress lived in worktrees, not the main checkout the Map watches. The only progress signal was the Pane tiles.
2. Closing the Panes dropped the in-memory Runs, so the Merge button disappeared and the finished-but-unmerged worktrees/branches were orphaned — the work became unreachable from the UI (not lost on disk, but no way to merge it).

## What to build

Two improvements, building on issue 15 (which makes finished worktree Runs carry committed branches):

- **Map reflects worktree-Run progress.** An issue that has an active or finished isolated Run should show that on its Map row — e.g. `running` while its Run is live, and `finished (unmerged)` once its branch is committed but not yet merged — instead of plain `open`. The bird's-eye view should tell you a Run is in flight / awaiting merge, not look untouched.
- **Merge affordance survives closing Panes.** Whether the Merge button appears should be derived from the **on-disk state** (finished/committed `afk/NN-slug` worktrees + branches), not only from in-memory tracked Runs — so closing or dismissing Panes never strands mergeable work; reopening/looking at the Project still offers the merge. Additionally, closing or dismissing a finished-but-unmerged Run should **warn** the user that it has unmerged work.

## Acceptance criteria

- [ ] While an isolated Run is live, its issue's Map row shows a `running` (in-worktree) indicator, not plain `open`.
- [ ] Once an isolated Run is finished/committed but not merged, its Map row shows `finished (unmerged)` (or equivalent), distinct from both `open` and merged-`done`.
- [ ] The Merge button is offered whenever there are finished-unmerged `afk/` branches/worktrees for the Project on disk — including after all Panes have been closed — not only while their Runs are tracked in memory.
- [ ] Closing/dismissing a finished-but-unmerged Run warns the user it has unmerged work before it disappears from the UI.
- [ ] Deriving "which issues have in-flight/finished-unmerged Runs" and "which branches are mergeable on disk" is pure, unit-tested logic; the on-disk scan is exercised against a scratch repo with real `afk/` worktrees.

## Blocked by

- 15
