# PRD — Mission Control Dispatcher

*Parent for the Dispatcher `/to-issues` batch. Vocabulary per [CONTEXT.md](../CONTEXT.md); decisions per [ADR-0007–0010](./adr/). Builds on the Execution view ([PRD.md](./PRD.md), issues 01–33).*

## Problem Statement

Running a backlog in Mission Control means starting Runs and **watching their Panes**. That works for one Run, but a drain with a concurrency cap spawns several live Claude sessions at once, and a human can't meaningfully read three or four scrolling terminals — nor synthesize *across* them (spot that two Runs found related problems, that a Run's work contradicts the PRD, that the same bug keeps recurring). Today all of that cross-Run judgment, and all the "commit this, log a follow-up, start the next one, stop here" orchestration, falls on the user staring at Panes. The lean, summarizing orchestrator role — hold only each Run's summary, reason over the set, act on the safe stuff, surface the rest — has no home in the app.

## Solution

A **Dispatcher**: a foreground *conversational orchestrator* — a Claude session you talk to in Mission Control, the way you'd talk to it in a terminal — that spawns the worker Panes, ingests each Run's **Completion block** as it finishes, and synthesizes across Runs. You converse with *one* orchestrator instead of watching *N* terminals. It holds **only the summaries** (never a Run's implementation transcript), so it stays lean across a long drain the way a fresh-context-per-issue worker does. It acts on its own for safe, reversible mechanics (commit a checkpoint between issues, start the next queued Run within the cap, relay progress) and **proposes for one-click approval** every scope-changing call (log a new issue, Merge, abort a drain, change course). It delegates the mechanical scheduling to the existing deterministic Run Coordinator, and keeps its own context bounded via rolling synthesis, with the durable history in an on-disk **Run log**. Starting a drain *is* starting a Dispatcher; a single manual Run stays a bare Pane.

## User Stories

**Talking to one orchestrator instead of watching N Panes**
1. As a developer draining a backlog, I want to converse with a single Dispatcher, so that I don't have to read several live terminals at once.
2. As a developer, I want the Dispatcher to tell me, in plain language, what each Run did as it finishes, so that I get the summary without scrolling its Pane.
3. As a developer, I want to still peek at any worker Pane in one click, so that I can drop into the raw session when I actually need to.
4. As a developer, I want to ask the Dispatcher questions about the drain in progress ("what's left?", "why did 05 block?"), so that I can steer without hunting through Panes.

**Completion blocks & the Run log**
5. As a developer, I want each Run's Completion block captured as a structured record, so that its "what changed / try it / verified / doc-drift" survives beyond the Pane scroll.
6. As a developer, I want a Run-log feed of those blocks, one card per Run, so that I have a scannable history of the drain.
7. As a developer, I want the Run log persisted on disk per Project, so that it survives closing Panes, the Dispatcher, or the app.
8. As a developer, I want the Dispatcher to be able to re-read an earlier Completion block on demand, so that a late issue can be related to an early one (e.g. a doc-drift flag from issue 7 mattering at issue 30).

**Cross-Run synthesis**
9. As a developer, I want the Dispatcher to flag when a Run's Completion block reports doc-drift (a PRD/reality contradiction), so that I decide whether to amend the plan.
10. As a developer, I want the Dispatcher to notice cross-Run patterns (several Runs touching the same seam, a recurring class of bug), so that I can consider a consolidated response rather than whack-a-mole.
11. As a developer, I want the Dispatcher to consolidate related findings from multiple Runs into one summary, so that I'm not re-deriving the picture myself.

**Hybrid authority — auto vs approve**
12. As a developer, I want the Dispatcher to commit a clean checkpoint between issues on its own, so that each Run's work is a reviewable commit without me clicking.
13. As a developer, I want the Dispatcher to start the next queued Run within the cap on its own, so that a drain flows without babysitting.
14. As a developer, I want the Dispatcher to relay/synthesize progress on its own, so that I always have a current picture.
15. As a developer, I want the Dispatcher to ask for one-click approval before logging a new issue, so that scope changes are my call.
16. As a developer, I want the Dispatcher to ask before a Merge, so that integration stays human-triggered (consistent with ADR-0002).
17. As a developer, I want the Dispatcher to ask before aborting a drain or changing course, so that I retain control of the big decisions.
18. As a developer, I want to approve or reject a proposed action in one click, so that oversight is cheap.
19. As a developer, I want to see clearly which actions the Dispatcher took autonomously vs which it's proposing, so that I trust what it's doing.

**Reacting to lifecycle events mid-drain**
20. As a developer, I want the Dispatcher to know when a Run blocked/stranded (a lifecycle event), so that it can propose "discard and continue" without waiting for a Completion block that will never come.
21. As a developer, I want the Dispatcher to surface a Run that needs my attention, so that a stuck drain doesn't silently stall.

**Scheduling delegation**
22. As a developer, I want the Dispatcher to use the existing Run Coordinator for "who starts next under the cap," so that scheduling stays deterministic and correct (not an LLM guess).

**Lifecycle & scope**
23. As a developer, I want the Dispatcher spun up when I start a drain, so that it's there exactly when orchestration is needed.
24. As a developer, I want a single manual Run to stay a bare Pane (no Dispatcher), so that trivial one-offs aren't wrapped in ceremony.
25. As a developer, I want the Dispatcher to be dismissable, so that I can end it when the drain is done.
26. As a developer, I want one Dispatcher per Project (not a shared global one), so that multi-window use stays cleanly separated (ADR-0004).

**Staying lean over a long drain**
27. As a developer, I want the Dispatcher's own context to stay bounded across a 50+ issue drain, so that its judgment doesn't degrade late in the run.
28. As a developer, I want finished/merged issues folded into a running summary while open/flagged threads keep full detail, so that the Dispatcher remembers what matters and forgets the churn.

## Implementation Decisions

**Architecture (ADRs 0007–0010):**
- **Hybrid authority** (ADR-0007): auto on reversible mechanics (commit checkpoint, synthesize/relay, start-next-within-cap), human-approved on scope (log issue, Merge, abort, course change).
- **Delegates scheduling to the pure Run Coordinator** (ADR-0008): the LLM never does cap/queue/startable arithmetic.
- **Bounded context via rolling synthesis** (ADR-0009): active context = seed + rolling summary + recent-N blocks + open/flagged threads; the on-disk Run log is the durable record, re-readable on demand.
- **Per-Project, on-demand, is the layer behind Drain** (ADR-0010): starting a drain starts a Dispatcher; single manual Run stays bare; chat panel beside the Map with the Run-log feed.
- **Input contract**: seed (backlog + PRD/CONTEXT) + a stream of {Completion blocks, lifecycle events, doc-drift flags}; **never raw Pane output**.

**Modules — pure/deep (unit-tested):**
- **Completion-block parser** — a Worker's final output → structured `{issue, whatChanged, tryIt, verified, bookkeeping, docDrift, outcome}`.
- **Rolling-synthesis state** — `(situationSummary, event) → bounded nextState`; encodes the ADR-0009 retention rule (keep verbatim for open/flagged, fold the rest).
- **Authority classifier** — a proposed action → `auto | needs-approval` (the ADR-0007 line).
- **Input-contract assembler** — builds the seed + filtered event stream; guarantees raw Pane output is excluded.

**Modules — adapters/shallow (integration or manual):**
- **Run log store** — durable per-Project persistence + retrieval of Completion-block records.
- **Dispatcher↔Coordinator bridge** — "start next" delegates to the pure Run Coordinator.
- **Dispatcher session** — the orchestrator Claude session (LLM): fed the input contract, its tool-calls drive the bridge and emit approval requests; auto vs approve gated by the authority classifier.

**UI (renderer):** **Dispatcher chat panel** + **Run-log feed** (cards) in the Execution view; worker Panes one click away.

## Testing Decisions

- **A good test asserts external behavior, not implementation** — feed inputs, assert outputs; the four pure modules are shaped (data-in, structure-out) precisely so they test without the LLM, Electron, or git.
- **Unit-tested: Completion-block parser, Rolling-synthesis state, Authority classifier, Input-contract assembler** (confirmed with the developer). Behaviors to cover:
  - *Parser:* a real completion block → correct fields; a "Ready for manual verification" / blocked report → correct `outcome`; a malformed block → graceful partial/failure, never a crash.
  - *Rolling-synthesis:* a finished-and-merged issue folds into the summary and drops from verbatim; an open/flagged thread (doc-drift) stays verbatim; bounded size across many events.
  - *Authority classifier:* commit/start-next/synthesize → `auto`; log-issue/merge/abort/scope → `needs-approval`.
  - *Input-contract assembler:* raw Pane output is never included; the seed + event stream is well-formed.
- **Integration-tested: Run log store** — persist/read records against a scratch dir; survives across sessions; per-Project isolation. (Prior art: the real-git integration tests in `src/main/*.test.ts`.)
- **Dispatcher session + bridge + UI** — verified via `type-check` + build + the batch QA walkthrough (no LLM/UI unit harness; matches the project convention in `issues/CONFIG.md`).
- **Do not introduce a new test framework** (vitest as established).

## Out of Scope

- **The Planning-view conversation** (`grill-with-docs` etc.) — the Dispatcher is an *execution* orchestrator; the planning conversation is a separate surface (main PRD).
- **Fully autonomous operation** — the Dispatcher never acts on scope-changing decisions without approval; there is no "run the whole backlog unattended and merge everything" mode.
- **Replacing the Run Coordinator** — scheduling stays in the pure coordinator (ADR-0008).
- **A Dispatcher for single manual Runs** — bare Pane only (ADR-0010).
- **Cross-Project / global Dispatcher** — one per Project (ADR-0010).
- **Multi-turn LLM prompt engineering of the orchestrator persona** — the session's system prompt is a build detail, not specified here beyond the input contract and authority rules.

## Further Notes

- **Prerequisite slice**: **completion-block capture** (parser + Run log store) must land before the Dispatcher — the Dispatcher's entire input is the captured blocks. `/to-issues` sequences it first.
- **This unifies the CLI drain-mode dispatcher with Mission Control**: the `afk-issue-runner` drain-mode (fresh worker per issue, hold only completion blocks, relay) is the same pattern; here the workers' terminals are visible Panes and the dispatcher's synthesis is the chat panel.
- **Tracer-bullet first Dispatcher slice** (after capture): a Dispatcher session that drives a drain of 2 issues end-to-end — spawn via the Coordinator, ingest both Completion blocks, auto-commit between them, and surface a synthesized "both done, here's what changed" — with one approval gate exercised (e.g. proposing a follow-up issue). Everything else (rolling synthesis at scale, doc-drift flagging, lifecycle-event reactions) layers on that spine.
- **Depends on** the Execution view (Map, Run Coordinator, worktree/merge lifecycle, afk-scan) from the main PRD, all of which now exist.
