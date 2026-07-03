---
status: open
depends_on: [34, 35, 36, 37, 38, 39, 41, 42, 43]
hitl: true
---

# 40 — Dispatcher batch QA walkthrough (HITL)

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

Not a build slice — the human walk-through of the assembled Dispatcher, done as a user, against the PRD's user stories. The Dispatcher is an LLM orchestrator, so its real behavior can only be judged by driving it; per-slice pure tests all passing while the assembled orchestrator is confusing/broken is exactly what this catches. The runner preps what it can (a scratch git repo with a seeded multi-issue backlog, exact start commands) and hands over this checklist.

Work each as a real user and confirm the expected outcome:

## Acceptance criteria

- [ ] **Spin-up:** start a drain on a Project → a Dispatcher chat panel appears beside the Map; start a single manual Run → no Dispatcher (bare Pane). (stories 1, 23, 24)
- [ ] **Talk, don't watch (34→35):** during a 2+ issue drain, the Dispatcher tells you what each Run did as it finishes (from captured Completion blocks), and answering "what's left?" gives a coherent reply — without you reading the Panes. Peek a Pane in one click. (2, 3, 4, 5, 6)
- [ ] **Run log persists (34):** completion-block cards remain after closing Panes and after an app restart; per-Project. (7)
- [ ] **Auto vs approve (35→36):** the Dispatcher commits between issues and starts the next queued Run on its own; but proposing a new issue / a Merge / an abort surfaces a one-click approve/reject and does nothing until you approve; autonomous vs proposed actions are visibly distinct. (12–19)
- [ ] **Lifecycle reactions (35→37):** force a Run to block/strand → the Dispatcher surfaces it and proposes discard-and-continue (approval-gated); the drain doesn't silently stall. (20, 21)
- [ ] **Cross-Run synthesis (35→38):** a Run whose Completion block reports doc-drift → the Dispatcher flags it and proposes a plan amendment; when multiple Runs hit the same seam, it points that out and consolidates. (9, 10, 11)
- [ ] **Stays lean (34+35→39):** across a longer drain the Dispatcher's answers stay coherent (bounded context); ask it about an early issue late in the drain → it re-reads the block from the Run log and answers correctly. (8, 27, 28)
- [ ] **Scheduling delegated (35):** confirm "who runs next under the cap" matches the Run Coordinator's deterministic plan, not an LLM guess. (22)

## Blocked by

- 34, 35, 36, 37, 38, 39

## Human prerequisites

- Node 22 + an authenticated `claude` CLI on PATH (the Dispatcher spawns an orchestrator `claude` session and worker sessions) — already covered by `issues/HUMAN-SETUP.md`. Auto mode is the global default (`~/.claude/settings.json`), so worker Runs won't block on permission prompts.
