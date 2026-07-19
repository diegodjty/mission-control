# The Dispatcher delegates scheduling to the pure Run Coordinator, never does queue math itself

**Status:** superseded-and-rehomed by ADR-0022 (2026-07-18). The Dispatcher framing is retired; the decision survives with a new driver — the drain loop calls the Run Coordinator directly, with no Dispatcher intermediary.

The LLM **Dispatcher** does not decide which issues start under the cap. That mechanical scheduling — startable set given the max-concurrent cap and `depends_on`, what queues, when a drain stops — stays in the pure, unit-tested **Run Coordinator** (issue 06). The Dispatcher *calls* the coordinator for "who starts next" and spends its intelligence only on judgment: reading Completion blocks, flagging doc-drift, consolidating findings, deciding whether to commit/log/stop.

## Considered Options

- **Dispatcher delegates to the Run Coordinator** (chosen).
- **Dispatcher owns scheduling** — the LLM decides what runs next, subsuming the coordinator. Rejected.

## Consequences

- Scheduling stays deterministic, instant, correct, and under the test coverage hardened in issues 20–32. Handing "which of 6 issues can start under a cap of 3, respecting depends_on" to an LLM would make it non-deterministic, untestable, slower, and token-costly for zero benefit.
- Clear separation of concerns: **Run Coordinator** = the engine (arithmetic scheduling); **Dispatcher** = the driver + synthesis layer that calls it and applies judgment over summaries.
- The Dispatcher's autonomy (ADR-0007) is exercised *through* the coordinator's plan — "start the next queued Run within the cap" is an auto action, but the *choice* of which is the coordinator's deterministic output, not an LLM decision.
