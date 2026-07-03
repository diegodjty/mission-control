# The Dispatcher defaults to silent autonomy; interruptions are a tiny explicit list

**Status:** refines ADR-0007 (hybrid authority) and ADR-0002 (human-triggered Merge).

A dogfood run showed the previous "auto vs approve, both common" model floods the user with interruptions (dozens of proposals + several approval gates for a single drain) — "defeats the purpose." So the Dispatcher's posture is **inverted**: it acts **silently and autonomously by default**, and interruptions are a small, explicit exception in three tiers:

- **Blocking approval** (must click before it proceeds) — the *entire* list: **(1) a Merge that hits a conflict**, **(2) aborting/stopping a drain**, **(3) a HITL issue awaiting the user's sign-off**. Nothing else blocks.
- **Passive note** (ambient, ignorable log; never blocks) — committed a checkpoint, a clean merge, an issue completed, a follow-up issue logged.
- **Silent** — everything else; answerable on demand.

## Considered Options

- **Keep ADR-0007 as-is** (auto vs approve, log-issue/merge/abort all gate). Rejected: the dogfood proved it interrupts far too often; the value of "talk to one orchestrator" inverts into "click through a firehose."
- **Silent-autonomy default with a 3-item blocking list** (chosen).

## Consequences

- **Refines ADR-0002:** a clean, conflict-free Merge **auto-proceeds** (the Dispatcher does it, logs a passive note); only a *conflicting/risky* merge blocks. Rationale: a clean merge of finished work is expected, git-reversible, and the whole point of the drain — gating ~5 clean inter-issue merges per drain is 5 clicks for zero real decisions. The safety ADR-0002 protected (no silent bad merge into main) is preserved where it matters: conflicts still block.
- **Logging a follow-up issue** stops being a gate — it's cheap and reversible, so the Dispatcher does it and leaves a passive note.
- The authority classifier (issue 36) must be re-mapped to this 3-item blocking list; most former `needs-approval` actions become silent+passive.
- Interruption budget is now a first-class design constraint: the bar for surfacing *anything* (even a passive note, and especially a proposal) is raised — see the noise/confidence model (ADR-0012, once resolved).
- ADR-0001's interactive posture still holds for a *single manual Run* (a bare Pane you drive); this ADR governs the *Dispatcher-driven drain*.
