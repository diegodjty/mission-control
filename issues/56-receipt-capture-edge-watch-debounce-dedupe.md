---
status: open
depends_on: [55]
---

# 56 — Receipt capture edge: watch, debounce, dedupe, feed

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (see also the **Receipt** entry in `CONTEXT.md`).

## What to build

The I/O edge that makes Receipts the Dispatcher's live input. Extend the existing `issues/` watch (ADR-0006: watch, don't poll) to cover `issues/completions/` in the project checkout for solo Runs, and each Run's worktree copy of `issues/completions/` in parallel mode (Mission Control owns the worktrees, so it knows the paths). A Receipt appearing or changing is the "Worker's final message is complete" signal — parse it (issue 55) and emit the capture event into the existing Dispatcher feed / Run-log pipeline, exactly where scroll-captured records enter today.

Two robustness requirements from the ADR: **debounce** half-written files (a watch event may fire before the Worker finishes writing — re-read until the parse is stable rather than ingesting a truncated Receipt), and **dedupe re-ingestion** (an MC restart or watcher re-scan must not double-feed the Dispatcher — key on `issue` + `finished`). A re-run of the same issue (same path, new `finished` stamp) is a *new* event by that key, which is the wanted semantics.

Demoable on its own: with a drain running in the sandbox, hand-writing a Receipt file into `issues/completions/` produces one Run-log card; writing it again unchanged produces nothing.

## Acceptance criteria

- [ ] A Receipt written to the project checkout's `issues/completions/` during a solo Run surfaces as one capture event / Run-log card.
- [ ] A Receipt written inside a parallel Run's worktree `issues/completions/` surfaces the same way, live, before any Merge.
- [ ] A half-written file does not ingest truncated content (debounce/re-read until stable).
- [ ] Restarting the watcher (or MC) over existing Receipts does not re-feed the Dispatcher; a re-run with a new `finished` stamp does.
- [ ] The event enters the existing Dispatcher feed pipeline (noise floor, lifecycle derivation, Run-log card) — no parallel bespoke path.
- [ ] Covered by tests at the edge (watcher → parsed event) plus the dedupe/debounce cases; type-check and full suite pass.

## Blocked by

- 55
