---
status: open
depends_on: []
---

# 59 — Solo auto-commit races the Receipt write; merge gate mislabels a dirty preflight as a conflict

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 finding, 2026-07-03).

## What to build

Root cause (proven in the QA sandbox): the skill's Receipt discipline is *write it last* — flip the issue `done`, emit the block, then write `issues/completions/NN-slug.md`. MC's solo auto-commit (`commitFinishedMain`) fires on the `done`-flip observation and `git add -A`s — so it commits the deliverable + flip and the Receipt lands a beat later, left **untracked** on `main` (sandbox evidence: commit `15ffd29` contains `deliverables/02.md` + the flip but no Receipt; `issues/completions/02-run-me.md` untracked). From then on `main` is dirty, every parallel Merge fails its clean-tree preflight, and the failure surfaces as an approvable "conflict-ish" gate — approving retries into the same dirty tree and fails again, even though `git merge-tree` shows the branches merge clean.

Two halves, both required:

1. **The solo finished-commit must capture the Receipt.** "Finished" for a solo Run should mean *done flip AND its Receipt present* (per ADR-0013 every exit writes one), so the auto-commit runs once, after both, and includes the Receipt. Handle the Receipt-never-arrives case with the same grace-window honesty as the finished-without-receipt audit (commit without it after the window rather than stalling forever — the note already covers the anomaly). Stay idempotent: re-observation never double-commits.
2. **The Merge gate must tell the truth.** A preflight failure ("uncommitted changes on main") is not a merge conflict: surface it as its own message naming the offending paths, and don't present an approval that cannot succeed. A retry after the user cleans up (or after MC commits a straggler Receipt) should then pass.

## Acceptance criteria

- [ ] Simulated solo Run with skill write-order (flip `done` → beat → Receipt file) ends with ONE commit containing deliverable, issue flip, and Receipt; main clean afterwards.
- [ ] Receipt arriving after the grace window: work commits without it, no stall, the missing-receipt note remains the only signal; a late Receipt is then committed by the next observation (idempotent).
- [ ] Merge preflight failure surfaces as "uncommitted changes on main: <paths>" — distinct from a real conflict gate — and never as an approval that re-fails identically.
- [ ] A real conflict still gates as before (ADR-0011 blocking list unchanged).
- [ ] Unit tests for the new finished/commit decision and the preflight/conflict message split; full suite + type-check pass.

## Blocked by

None - can start immediately.
