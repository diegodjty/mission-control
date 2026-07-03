---
status: open
depends_on: [35]
---

# 36 — Hybrid authority gates: approve/reject scope-changing actions

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

The full hybrid-authority behavior (ADR-0007): the **authority classifier** (pure) maps every proposed Dispatcher action to `auto | needs-approval` — auto = commit checkpoint, synthesize/relay, start-next-within-cap; needs-approval = log a new issue, Merge, abort a drain, any course change. Scope-changing proposals surface in the chat panel as a **one-click approve/reject** prompt, and the UI clearly distinguishes actions the Dispatcher **took autonomously** from ones it's **proposing**.

## Acceptance criteria

- [ ] The authority classifier is a pure module, unit-tested: commit/start-next/synthesize → `auto`; log-issue/merge/abort/course-change → `needs-approval`.
- [ ] A `needs-approval` action is presented as a one-click approve/reject in the chat panel and does not execute until approved.
- [ ] Approving executes the action; rejecting drops it and the Dispatcher continues.
- [ ] The UI visibly distinguishes autonomous actions from proposed ones.
- [ ] Merge is always approval-gated (consistent with ADR-0002).

## Blocked by

- 35
