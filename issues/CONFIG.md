# AFK project config

Per-project specifics for the [AFK Issue Runner skill](~/.claude/skills/afk-issue-runner/SKILL.md).

## Active PRD

`docs/adr/0015-the-workbench.md` — the Workbench batch (issues 69–77). An issue is **in the active batch** when its `## Parent` links to it.

## Repo

Single Electron + React + TypeScript repo (this directory). Main process = Node/TS coordinator; renderer = React UI. Domain vocabulary in `CONTEXT.md`; architecture in `docs/adr/`.

## Test commands

Established by issue 01 (walking skeleton). Once scaffolded: `npm run test` (unit) and `npm run type-check`, run after every change. The four pure modules (Backlog Model, Run Coordinator, Project Registry, Isolation Policy) are unit-tested; adapters and UI verify via type-check + the batch QA walkthrough.

`npm run test:e2e` (issue 63) drives the assembled drain end-to-end — real git sandbox, real Receipt watcher, real worktrees + `afk-merge.sh`, scripted (no-LLM) Workers with misbehavior modes — covering walkthrough 58's checklist as code (`e2e/drain-harness.e2e.test.ts`; live-shell-only items are declared `manual-only` in its output, never silently skipped).

**Rule: the machine passes before any human walkthrough** — run `npm run test:e2e` and get it green before handing a QA walkthrough (issues 10/40/51/58-style) to the human.

## Parallel mode

`afk-merge.sh` lives in the afk-issue-runner skill dir. Parallel mode + worktrees only kick in once Mission Control itself (issues 07–08) exists to drive them; while building Mission Control, run issues **solo** (one at a time on `main`) unless you deliberately set up `issues/.afk-parallel`.
