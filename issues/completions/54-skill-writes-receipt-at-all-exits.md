---
issue: 54
slug: skill-writes-receipt-at-all-exits
outcome: completed
finished: 2026-07-03T21:00:45Z
---
## Completed issue 54 — skill-writes-receipt-at-all-exits

**What changed** — Every AFK Worker now leaves a Receipt: whichever way its session ends — issue completed, parked for manual verification, or blocked — it writes its final report to a file on disk (`issues/completions/`) with the outcome declared in machine-readable form at the top. Tooling reads the Worker's own declaration from that file instead of scraping its terminal screen and guessing. Done interactively by the user's session (the autonomous worker was permission-blocked from editing its own skill file, by design).

**Try it yourself** — Run any single AFK issue in any project (e.g. `claude` in a project with an `issues/` backlog, ask it to "claim the next issue"). When it finishes, `issues/completions/NN-slug.md` exists with `issue`/`slug`/`outcome`/`finished` frontmatter and the same completion block the agent printed. This very file is the first live Receipt.

**Verified** — Diff against the pre-edit snapshot shows 0 deleted lines (additive-only, per acceptance criteria): four insertions — Receipt write at the HITL park (§2), the finish (§5, both modes incl. parallel commit-on-branch), the blocked exit (§6), and a new "Receipts — write one at every exit" section defining the path, frontmatter schema, declare-don't-imply rule, and single-save write discipline. Not runtime-verified with a live Worker yet — that is exactly what the batch QA walkthrough (issue 58) does.

**Bookkeeping** — Files touched: `~/.claude/skills/afk-issue-runner/SKILL.md` (outside this repo, not git-tracked; pre-edit snapshot preserved in session scratchpad), this issue file (`wip` → `done`), and this Receipt. No repo code touched; no tests apply (skill prose).

**Doc drift** — none. One process note: auto-mode AFK workers cannot edit this skill file (self-modification denial) — future issues that require skill edits should be marked HITL from the start.
