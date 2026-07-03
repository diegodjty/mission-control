---
status: done
depends_on: [34]
---

# 35 — Dispatcher spine: drive a 2-issue drain end-to-end (tracer bullet)

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

The end-to-end spine of the **Dispatcher** (ADR-0007–0010): a conversational orchestrator Claude session, spun up **when a drain starts**, that drives a small drain to completion and lets you talk to it instead of watching Panes. For a 2-issue drain it must: delegate "who starts next under the cap" to the deterministic **Run Coordinator** (bridge, ADR-0008); spawn the worker Panes; ingest each **Completion block** as Runs finish (from issue 34); **auto-commit a clean checkpoint between issues** (an `auto` action, ADR-0007); and surface a synthesized plain-language "both done — here's what changed" in a **chat panel** beside the Map. A **single manual Run stays bare** (no Dispatcher). One Dispatcher **per Project** (ADR-0010), dismissable.

Includes minimal versions of the pure modules that later slices thicken: **input-contract assembler** (seed = backlog + PRD/CONTEXT; stream = Completion blocks; **never raw Pane output**) and **authority classifier** (enough to treat commit/start-next/synthesize as `auto`). The Dispatcher session itself is an LLM integration — its behavior is verified via type-check + build + the batch QA walkthrough; the pure modules it uses are unit-tested.

## Acceptance criteria

- [ ] Starting a drain spins up a Dispatcher session (per Project); a single manual Run does not (stays a bare Pane).
- [ ] The Dispatcher drives a 2-issue drain: scheduling comes from the Run Coordinator (not the LLM), worker Panes spawn, both Completion blocks are ingested.
- [ ] The Dispatcher auto-commits a clean checkpoint between issues without asking.
- [ ] A chat panel shows a synthesized summary of the drain; you can ask it "what's left?" and get a coherent answer from the Run log / blocks (not raw Pane scroll).
- [ ] The input-contract assembler never includes raw Pane output (unit-tested); the minimal authority classifier marks commit/start-next/synthesize `auto` (unit-tested).
- [ ] The Dispatcher is dismissable and scoped to its Project.

## Blocked by

- 34
