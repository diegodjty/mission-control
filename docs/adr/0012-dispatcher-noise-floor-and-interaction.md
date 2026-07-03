# Dispatcher noise floor, confidence bar, and interaction model

**Status:** completes ADR-0011 (silent-autonomy default). Refines issues 37/38/43's surfacing behavior.

The dogfood run flooded the user with non-blocking noise (≈15 boot-screen "unclassifiable" Runs, dozens of garbled "consolidate?" proposals, doc-drift on "none"). Silent-autonomy (ADR-0011) removes most *approvals*; this ADR removes most *surfacing* and fixes the interaction racing.

## Decisions

**Noise floor — what never surfaces (not even a passive note):**
- **Empty / boot-screen / unclassifiable captures are dropped silently.** Only a capture parsing to a *real* terminal outcome (completed / blocked / HITL / needs-verification) becomes a Run in the log. (This deliberately narrows issue 43's "convey unknowns as needs-a-look" — a genuinely empty capture is noise, not a needs-a-look item.)
- **Doc-drift surfaces only on a real contradiction; "none"/empty is silent.**
- **Cross-run consolidation is demoted from a proposal to a rare passive note** — surfaced *once*, deduped, only on a strong concrete overlap (≥2 Runs genuinely touching the same file/seam); never the per-tick "consolidate?" firehose.

**Confidence bar:** routine per-issue *facts* (committed, merged-clean, done) are fine as ambient passive notes; anything *inferred/speculative* (doc-drift, consolidation, "might be relevant") must clear a **high confidence bar** before earning even a passive line — **if in doubt, stay silent** (the user can always ask).

**Interaction model:**
- **Passive notes render in the ambient log, not the chat.** They are NOT injected into the Dispatcher's chat session. Only blocking approvals and the user's questions + the Dispatcher's answers use the chat. This structurally removes most of the "prompt over prompt" input racing.
- **One serialized queue** for any remaining programmatic chat writes, and **no injection while the user is composing** (defer until the input is idle).
- **Debounce backward status moves:** a finished→open regression must persist across ≥1 reconcile checkpoint before it is surfaced or escalated (kills the false "merge is failing" alarm).
- **Lean on-demand:** the Dispatcher keeps the ambient log current and answers when asked; it does not narrate every step into the chat. Proactive chat is reserved for the ADR-0011 blocking list + a genuinely high-confidence flag.

## Consequences

- Most of what issues 37/38/43 surface becomes a silent-or-passive-log event; their pure detectors stay, but their surfacing is gated by the confidence bar and routed to the log, not the chat.
- The chat becomes low-traffic and legible (composes with issue 44's bounded panel): conversation + rare approvals only.
- "If in doubt, stay silent" is the governing default — an interruption (even passive) must justify itself.
