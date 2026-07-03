---
status: wip
depends_on: [43, 48]
---

# 52 — Dispatcher answers "what's left?" from current ground truth (on-demand status), not the seed

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## Source / root cause

Issue-51 verification (2026-07-03): a cap-2 drain completed everything except the HITL 05, but asking the Dispatcher "what's left?" returned the **drain-start seed** ("Nothing has reported in yet… this is the starting state straight from the backlog"). Confirmed: after issue 48 routed all passive facts (synthesis, status refresh, completion notes) to the ambient **log** instead of the chat session, the Dispatcher LLM session receives **nothing after its seed prompt** except blocking items — so it has no idea what actually happened. Issue 43's ground-truth status is computed but never reaches the session.

## What to build

Give the Dispatcher **current ground-truth status on demand**, without returning to the noisy streaming that ADR-0012 removed. When the user sends a message to the Dispatcher, the app first injects the **current reconciled + debounced status snapshot** (issues 43/49 — done/wip/open/finished-unmerged per issue, from backlog + afk-scan + Run-log) as quiet context, so the answer reflects reality. (Equivalently: maintain a single low-frequency evolving status line the session can see — but on-query injection is preferred, it's truly on-demand.) The chat stays quiet otherwise (no per-fact streaming). Result: "what's left?" / "status?" answers match the Map.

## Acceptance criteria

- [ ] After a drain has completed several issues, asking the Dispatcher "what's left?" reflects the actual current status (matches the Map/Run-log), not the drain-start seed.
- [ ] This does NOT reintroduce per-fact chat streaming (ADR-0012) — status reaches the session on-demand (at query time) or as a single evolving line, not as a message per event.
- [ ] The status snapshot is the reconciled + debounced ground truth (issues 43/49).
- [ ] The snapshot-building / injection-trigger logic is pure and unit-tested; live accuracy via the batch QA walkthrough.
- [ ] type-check + build pass.

## Blocked by

- 43
- 48
