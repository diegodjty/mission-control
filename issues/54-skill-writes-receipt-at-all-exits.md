---
status: open
depends_on: []
---

# 54 — afk-issue-runner skill writes a Receipt at all three exit points

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (see also the **Receipt** entry in `CONTEXT.md`).

## What to build

Edit the global `~/.claude/skills/afk-issue-runner/SKILL.md` so that every Worker exit leaves a **Receipt**: `issues/completions/NN-slug.md`, YAML frontmatter (`issue`, `slug`, `outcome: completed | needs-verification | blocked`, `finished` ISO-8601 timestamp) followed by the verbatim block the Worker already emits as its final message. The instruction must land at **all three** exit points — finish (§5), HITL park (§2), and blocked (§6) — the HITL exit is the one this redesign exists for. One file per issue; a re-run overwrites (latest Run wins). In parallel mode the Worker commits the Receipt on its `afk/NN-slug` branch with the rest of its work; in solo mode it stays uncommitted on `main` like everything else. The blocked exit may have no single issue in scope — in that case the Receipt is named for the issue the Worker attempted to claim, or skipped with the reason stated in the final message if no issue was ever in scope.

This edits the Worker's own operating manual outside this repo, so the change must be **additive-only**: no existing skill behavior reworded or removed, only the Receipt-write steps inserted. The final-message contract (emit the block verbatim) is unchanged — the Receipt is a copy on disk, not a replacement.

## Acceptance criteria

- [ ] SKILL.md instructs the Receipt write at the finish (§5), HITL park (§2), and blocked (§6) exits, with the exact path and frontmatter schema above.
- [ ] Parallel-mode instructions include committing the Receipt on the `afk/NN-slug` branch; solo-mode leaves it uncommitted.
- [ ] The edit is additive-only — a diff against the prior SKILL.md shows insertions, no deletions or rewording of existing steps.
- [ ] The completion block for THIS issue includes the full SKILL.md diff so the user can review the operating-manual change before any real drain relies on it.

## Blocked by

None - can start immediately.
