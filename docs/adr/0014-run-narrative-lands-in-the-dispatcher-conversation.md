# "The chat" is the claude conversation: Run narrative lands in the Dispatcher session

**Status:** accepted. Refines ADR-0011/ADR-0012; restores the intent of issue 35's block feed with Receipt sourcing (ADR-0013) and the unstallable pump (issue 60).

Three walkthroughs of channel-model iteration traced to one ambiguity: when the user said "notify me in the chat," "chat" always meant **the embedded claude conversation itself** — the Dispatcher session narrating work the way a terminal drain does — not Mission Control's activity strip rendered above it. The ADR-0012 recalibration (a correct reaction to a *proposal/approval* firehose) overcorrected by muting run *narrative* out of the conversation too, leaving the Dispatcher session unaware of finished work (patched on-ask by issue 61) and the user reading a side strip they never wanted as the primary surface.

**Decision — the channel model, restated:**

- **Run narrative flows into the Dispatcher session as messages, live**: each Run's Completion block (read from its Receipt) is typed+submitted into the claude session as the Run finishes, as are HITL park notices and drain lifecycle facts worth telling (stopped, halted, adopted strays). The Dispatcher LLM receives them as conversation and can narrate/synthesize — replicating the terminal-drain experience.
- **The blocking-approval list is unchanged** (ADR-0011's three items). The firehose lesson stands where it was learned: *proposals and gates* stay minimal; narrative is not a gate.
- **The activity strip becomes history**, secondary to the conversation — a scannable log, not the notification surface.
- **The noise floor (ADR-0012) still governs junk**: unknown/unclassifiable records and speculative signals stay out of the chat; debounced status-refresh does not stream into it. Issue 61's on-ask digest remains as catch-up for anything a session missed (e.g. it was opened mid-drain).

## Consequences

- Reverses ADR-0012's "passive notes render in the ambient log, not injected into the chat" **for run narrative specifically**; retains it for routine status flips and speculative signals.
- Delivery rides the issue-60 pump (unstallable, session-replacement-safe, observable), which did not exist when issue 48 moved notes out of the chat — the original reliability reason for the rerouting is gone.
- CONTEXT.md's Dispatcher authority / noise-floor entries updated to match.
