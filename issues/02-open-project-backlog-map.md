---
status: done
depends_on: [1]
---

# 02 — Open a Project and see its backlog on the Map

## Parent

`docs/PRD.md` — Mission Control.

## What to build

Point the app at a Project (a repo path with an `issues/` backlog) and render a basic **Map**: the list of issues with their status (open/wip/done), whether each is in-batch (matches the active PRD in `CONFIG.md`) or standalone, and HITL flags.

Introduces the **Backlog Model** — a pure module that takes the raw `issues/*.md` + `CONFIG.md` contents and returns a structured backlog (per-issue status, `depends_on`, Parent/Source, in-batch vs. standalone, HITL). It is the source of truth for the Map and mirrors the afk-issue-runner's own pick logic. It touches no Electron/git/PTY APIs so it is unit-testable in isolation.

A single Project (repo path) is enough here — the multi-Project registry arrives in issue 09.

## Acceptance criteria

- [ ] Given a repo path, the Map lists every issue in its `issues/` with the correct status.
- [ ] Each issue shows in-batch vs. standalone (per the active PRD in `CONFIG.md`) and an HITL badge where applicable.
- [ ] Clicking an issue shows its full body.
- [ ] The Backlog Model is a pure function of the file contents (no I/O inside it); the file reading happens in an adapter that calls it.
- [ ] Backlog Model is unit-tested against fixture backlogs (see Testing Decisions in the PRD).

## Blocked by

- 01
