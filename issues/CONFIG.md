# AFK project config

Per-project specifics for the [AFK Issue Runner skill](~/.claude/skills/afk-issue-runner/SKILL.md).

## Active PRD

`docs/adr/0013-receipt-files-replace-tui-capture.md` — the Receipt pipeline batch (issues 54–58). An issue is **in the active batch** when its `## Parent` links to it.

## Repo

Single Electron + React + TypeScript repo (this directory). Main process = Node/TS coordinator; renderer = React UI. Domain vocabulary in `CONTEXT.md`; architecture in `docs/adr/`.

## Test commands

Established by issue 01 (walking skeleton). Once scaffolded: `npm run test` (unit) and `npm run type-check`, run after every change. The four pure modules (Backlog Model, Run Coordinator, Project Registry, Isolation Policy) are unit-tested; adapters and UI verify via type-check + the batch QA walkthrough.

## Parallel mode

`afk-merge.sh` lives in the afk-issue-runner skill dir. Parallel mode + worktrees only kick in once Mission Control itself (issues 07–08) exists to drive them; while building Mission Control, run issues **solo** (one at a time on `main`) unless you deliberately set up `issues/.afk-parallel`.
