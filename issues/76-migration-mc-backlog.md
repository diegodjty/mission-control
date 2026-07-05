---
status: wip
depends_on: [74, 75]
hitl: true
---

# 76 — Migration: move MC's backlog into the Workbench (HITL, machine-gated)

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

Move-and-delete per ADR-0015, executed by the human because a Worker moving the live backlog it is being dispatched from is self-referential. The Worker preps: a migration script (idempotent, with `--dry-run` default) that copies `issues/`, `issues/completions/`, `docs/PRD*.md`, `HUMAN-SETUP.md` from the mission-control repo into `~/Workbench/mission-control/`, rewrites `## Parent` links to the workbench PRD paths, merges the current CONFIG into the workbench CONFIG (69's scaffold wins on conflicts, report them), activates the mission-control entry in `registry.md`, and emits a verification report (file counts, link-rewrite counts, diff summary). Plus the follow-up steps: `git rm` the originals from the MC repo with a pointer note in README, commit both repos. Dry-run output committed for review; the human runs it for real **only after issue 75's e2e suite is green** (CONFIG's machine-before-human rule applies to the migration itself).

## Acceptance criteria

- [ ] Script + dry-run report prepped and committed; dry-run counts match reality (77 issue files at time of writing, receipts, 2 PRDs).
- [ ] Human executed: workbench holds the backlog, registry active, MC repo cleaned with pointer note, both repos committed.
- [ ] MC opens the mission-control Project via the workbench and shows the full Map (all statuses intact); a bare `claude` session in the MC repo resolves the backlog via the registry (issue 74's skill).

## Human prerequisites

- Run the migration script (after e2e green) and the git cleanup steps per its report.

## Blocked by

- 74, 75
