---
status: done
depends_on: [7]
---

# 08 — Merge finished parallel Runs

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Close the parallel loop. When parallel Runs finish, a **Merge** action appears on the Map. Triggering it integrates the finished `afk/NN-slug` branches into `main` via `afk-merge.sh` (in the afk-issue-runner skill dir), reports any conflicts clearly, and cleans up the worktrees on success. The Merge is always human-triggered — never automatic (ADR-0002).

This directly retires the "do I need to merge or not?" friction: the merge becomes a labelled button that appears at the right moment.

## Acceptance criteria

- [ ] A Merge action appears on the Map once parallel Runs have finished, and not before.
- [ ] Triggering it runs `afk-merge.sh` and integrates the finished branches into `main`.
- [ ] Conflicts are surfaced clearly to the user rather than silently failing or auto-resolving.
- [ ] Worktrees are cleaned up after a successful merge.
- [ ] The merge never runs automatically.

## Blocked by

- 07
