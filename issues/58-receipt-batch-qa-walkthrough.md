---
status: wip
depends_on: [54, 55, 56, 57, 59, 60, 61, 62, 63, 64, 65, 66]
hitl: true
---

# 58 — Receipt batch QA walkthrough (HITL)

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (batch 54–57).

## What to build

Human walkthrough of the assembled Receipt pipeline in the QA sandbox (`/Users/devteam/Developer/mc-qa-sandbox/repo-a`, reset first per the standard procedure: remove worktrees/prune, delete `afk/*`, `git reset --hard <root>`, `git clean -fdx`, `rm -rf ../.afk-worktrees`). The runner preps everything it can — reset the sandbox, exact start commands, which issues to drain — and hands the human this checklist. The per-issue criteria of 54–57 all passing while the assembled chain is broken is exactly what this issue exists to catch; the headline seam is Worker-writes-Receipt (54) → edge ingests it (56) → HITL notice fires (the issue-53 gap this whole batch exists to close).

## Walkthrough checklist

- [ ] **Solo Receipt:** start MC, drain repo-a with cap 1 → as the first issue finishes, `issues/completions/NN-slug.md` exists with `outcome: completed` frontmatter, and one Run-log card shows the block's sections.
- [ ] **HITL notice (the issue-53 fix):** let the drain reach the parked HITL issue (05) → the Dispatcher **chat** shows one prominent "waiting for you" notification naming issue 05 with its manual-verification steps, sourced from a Receipt with `outcome: needs-verification`. Not in the ambient log, not silent.
- [ ] **Zero ghosts:** across the whole drain, status and the Run log contain no unclassifiable/boot-screen entries.
- [ ] **Parallel mode:** drain with cap 2 → each worktree Run's Receipt surfaces live (card appears while the Run's branch is unmerged); after a clean auto-Merge, the Receipt files are present on `main`.
- [ ] **Missing receipt:** delete a Receipt mid-drain after its issue flipped done (or hand-flip an issue to done with no Receipt) → exactly one "finished without receipt" passive note in the ambient log; no scrape, no junk entry.
- [ ] **Blocked exit:** with only the dep-blocked issue eligible (03 depends on 02), a Worker's blocked report also lands as a Receipt (`outcome: blocked`) and one card.

## Acceptance criteria

- [ ] Every checklist item above verified by the human in a live MC session.
- [ ] Sign-off recorded; on pass, the parked walkthroughs 40/51/10 are unblocked for re-run under the new capture pipeline.

## Blocked by

- 54, 55, 56, 57
