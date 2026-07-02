---
status: done
depends_on: [7, 8]
---

# 13 — Detect parallel-Run completion from the worktree, not main

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). During a parallel drain (cap 2, issues 04 & 05), the agents completed and flipped their issues to `done` **in their worktrees**, but Mission Control never showed them finished and the Merge button never appeared. Confirmed root cause: Run status is derived from the backlog watched on the **main checkout** (`run-state.ts` + the main-path backlog in `App.tsx`), while parallel Runs work in their **own git worktree** on an `afk/NN-slug` branch (issue 07). The `done` flip lands on the branch, invisible to the main-checkout watcher, so `deriveRunStatus` never returns `finished` and `mergeReadiness` never offers the merge. Per-issue tests (06/07/08) all pass in isolation — the defect is only at the assembled seam.

## What to build

Make completion detection correct for **isolated** Runs (those working in a worktree on an `afk/` branch). For an isolated Run, observe its issue's status on its **own worktree/branch** — read `<worktree>/issues/NN.md` (or `git show afk/NN-slug:issues/NN.md`) — rather than the main-checkout backlog. When that reads `done`, the Run shows **finished**, which makes the existing Merge affordance appear; triggering the merge then brings the `done` flip (and the code) back to `main` as designed (issue 08). Solo Runs (on `main`) keep observing the main backlog exactly as today.

Keep `run-state.ts` pure — it already takes an `issueStatus` input; the change is that the *caller* feeds it the worktree-observed status for isolated Runs and the main-backlog status for solo Runs. The main-checkout watcher continues to drive the Map's overall bird's-eye view; only per-isolated-Run status changes source.

## Acceptance criteria

- [ ] An isolated (worktree) Run whose agent flips its issue to `done` on the `afk/` branch is shown as **finished** in Mission Control.
- [ ] Once isolated Runs are finished, the Merge button appears (unchanged behavior downstream), and merging integrates their branches into `main`.
- [ ] A solo Run (single Run on `main`) still detects `done` from the main backlog exactly as before — no regression.
- [ ] The worktree/branch status-observation logic is covered by an **integration test** that spans the real seam: a scratch git repo, a worktree on an `afk/` branch, a `done` flip on that branch, and assertion that the Run is observed finished (and thus mergeable).
- [ ] `run-state.ts` remains pure and unit-tested; new decision logic (which source to observe for a given Run) is pure and unit-tested.

## Blocked by

- 7
- 8
