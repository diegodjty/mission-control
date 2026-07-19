# The Dispatcher defaults to silent autonomy; interruptions are a tiny explicit list

**Status:** superseded-and-rehomed by ADR-0022 (2026-07-18). Refines ADR-0007 (hybrid authority) and ADR-0002 (human-triggered Merge). The Dispatcher framing is retired; auto-merge-on-clean and the three-item blocking set survive, moved to ADR-0021's auto-merge lane.

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

## Proposed amendment (issue 113 — awaiting Diego's sign-off, NOT yet ratified)

> **Status of this section:** a DRAFT amendment recorded for sign-off, not a decided change. The code (`src/shared/dispatcher-authority.ts`) already implements it so the guard ships in issue 113's slice, but the blocking list is not considered "officially" four items until Diego approves this section. If rejected, back the `protected-branch-land` classification out; if approved, fold the item into the body above and delete this heading.

**What changes.** The blocking-approval list grows from three items to **four**: a new **(4) landing a Run's work on a PROTECTED branch** (`main`/`master` by default, configurable) — for BOTH the autonomous Dispatcher/runner merge and a user-initiated merge, and for the solo auto-commit onto the current branch.

**Why it's an ADR change, not just code.** ADR-0011's whole thesis is "interruptions are a tiny, explicit exception" and the list was deliberately fixed at three. Adding a fourth blocking action is a change to the documented authority model, so it must be recorded and signed off rather than slipped in — exactly the "surface, human decides" discipline the batch runs on.

**Why this fourth item earns a block anyway.** The three-item list was chosen because everything else is cheap and git-reversible; a clean merge auto-proceeds precisely because it's expected and reversible. Landing on `main`/`master` is the one routine action that is *not* safely reversible in practice: `main` is typically wired to production/deploy workflows (push-on-merge, release automation), so a silent land can trigger irreversible external effects. That is a genuine "must not happen silently" of the same kind as a conflict landing on `main` — so it belongs on the list, and nothing else newly does. A non-protected feature branch stays fully auto (the branch-you're-on targeting), so the interruption budget only spends on the one branch that matters.

**Interaction with other ADRs.** Refines ADR-0002/ADR-0018 (merge lifecycle): the merge is still Mission-Control-owned and still auto-proceeds onto a feature branch; the protected-branch confirmation is a new pre-land gate layered on top, not a new merge mechanism.
