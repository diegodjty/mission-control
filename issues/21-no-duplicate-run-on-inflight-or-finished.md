---
status: open
depends_on: [15, 16]
---

# 21 — [CRITICAL] No Run on an issue already in-flight or finished-unmerged

## Source

Hardening review (2026-07-03), findings state-C2 + C3 + M1. Runnability is judged from main-checkout status only, so an issue running in a worktree or finished-unmerged (its `done` flip is on the `afk/` branch, main still reads `open`) is offered as runnable by the guidance banner AND the detail-panel Run button. Starting it re-attaches a worktree to the already-committed branch / clobbers finished work, and can push commits onto a branch a pending Merge is about to integrate. `startRun` only dedupes against in-memory `runs`, so after Panes close it admits a duplicate. `worktreeStatuses` is also never cleared, so a re-used issue-id shows a stale `finished`.

## What to build

Make "can this issue be Run?" consult **on-disk truth**, not just main-checkout status. The guidance banner (`run-guidance`), the detail-panel Run button, and `startRun` must all exclude issues that are `worktreeRunning` or `finishedUnmerged` (from the afk-scan). `startRun` must refuse an issue that already has a live/finished `afk/` branch or worktree, regardless of in-memory tracked runs. Clear `worktreeStatuses[id]` when a Run is dismissed/merged/exits so a later run of the same id doesn't inherit a stale status.

## Acceptance criteria

- [ ] An issue that is running-in-worktree or finished-unmerged is NOT listed by the guidance banner and shows no Run button (row + banner agree).
- [ ] `startRun` refuses (or the UI prevents) starting a Run on an issue with a live/finished `afk/` branch or worktree, even after Panes are closed.
- [ ] Dismissing/merging/exiting a Run clears its stale `worktreeStatuses` entry; a re-run of that id does not show `finished` until its new work actually reaches done.
- [ ] Pure runnability logic composed with worktree-running / finished-unmerged sets is unit-tested (banner + button suppression, duplicate-run refusal).

## Blocked by

- 15
- 16
