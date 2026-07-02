---
status: done
depends_on: [7, 8, 13]
---

# 15 — Commit finished worktree Runs to their afk branch so Merge can integrate them

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). A parallel drain (issues 02/03/04) created each file and flipped each issue to `done` **inside its worktree**, but the work was left **uncommitted** — the `afk/NN` branches had zero commits — so the Merge button had nothing to integrate and the Map never showed the issues done. Confirmed root cause: Mission Control isolates each parallel Run in a worktree (issue 07) but spawns the agent with a prompt telling it to run in *normal single-issue / solo* mode (issue 03's `buildRunPrompt`), and solo mode does **not** commit. Meanwhile Merge (issue 08, `afk-merge.sh`) integrates *committed* branches. Nobody commits → the parallel→merge pipeline is broken end-to-end, and completion detection (issue 13, which reads the worktree *working tree*) reports "finished" while the branch is actually empty — detection and merge disagree about what "done" means.

## What to build

**Option A (decided): Mission Control auto-commits the finished worktree.** When an isolated Run (working in a worktree on an `afk/NN-slug` branch) reaches `done` — its worktree working-tree issue file is flipped to `done` — Mission Control commits that worktree's changes (the created/edited files **and** the `done` flip) onto its `afk/NN-slug` branch. This is consistent with ADR-0002 (Mission Control owns the worktree + merge lifecycle) and keeps the spawned agent in simple single-issue mode.

Align "finished" with the committed state so detection and Merge agree: a Run is **finished** once its work is committed on the branch (observe the committed `issues/NN.md` on the branch, e.g. `git show afk/NN-slug:issues/NN.md`, rather than the uncommitted working tree). After that, the existing Merge affordance (issue 08) integrates the committed branch into `main` — bringing the files and the `done` flip to the main checkout, so the Map then shows the issue `done`.

Solo Runs (single Run on `main`) are unchanged: no worktree, no auto-commit — they leave work on `main` for review as today.

Edge cases: only commit on the finished (done) transition — a blocked/stopped Run is left uncommitted (nothing to merge). The commit message should identify the issue (e.g. `afk: complete issue NN — <slug>`). Committing must be idempotent (don't double-commit a Run already committed).

## Acceptance criteria

- [ ] When an isolated Run reaches `done` in its worktree, Mission Control commits that worktree's changes onto its `afk/NN-slug` branch (files + `done` flip), so `git log afk/NN-slug` shows the work.
- [ ] "finished" reflects the **committed** branch state, so a Run only shows finished once its work is committed (detection and Merge agree).
- [ ] Clicking Merge then integrates those commits into `main`: the created files and the `done` flip land on the main checkout, and the Map shows the issue `done` after merge.
- [ ] A blocked/stopped Run is not committed. Solo Runs on `main` are unchanged.
- [ ] Auto-commit is idempotent (a Run already committed is not committed again).
- [ ] Integration test on the real seam: a scratch git repo + worktree on an `afk/` branch, simulate the agent (create a file + flip the issue to `done`, uncommitted), then assert Mission Control commits it to the branch, "finished" is observed from the committed state, and a subsequent merge lands the file + `done` flip on `main`. Pure decision logic (when to commit, when finished) unit-tested.

## Blocked by

- 7
- 8
- 13
