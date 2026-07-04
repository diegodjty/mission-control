---
status: done
depends_on: [60, 65]
---

# 66 — Run narrative lands in the Dispatcher conversation (ADR-0014)

## Parent

`docs/adr/0014-run-narrative-lands-in-the-dispatcher-conversation.md` — "the chat" is the claude conversation.

## What to build

Implement ADR-0014's channel model: the Dispatcher session — the embedded claude conversation — receives run narrative **live, as messages**, replicating the terminal-drain experience the user actually wanted all along:

1. **Completion blocks into the conversation.** As each Run finishes, its Completion block (from the Receipt, via the existing parsed record) is typed + submitted into the Dispatcher session through the issue-60 pump — one message per Run, rendered readably (the block itself, not a JSON blob). The `dispatcherFed` once-per-Run guard stays; the `synthesize`/ambient-only routing from issue 48 is replaced for narrative.
2. **HITL parks and drain facts too.** `hitl-waiting` already targets the chat — keep it, and route the other narrative-worthy lifecycle facts there as messages: drain stopped/halted, stray Receipts adopted, finished-without-receipt. Routine status flips and speculative signals stay OUT (ADR-0012's noise floor and debounce still apply); blocking approvals stay the ADR-0011 three-item list.
3. **The activity strip demotes to history.** It keeps recording everything (including delivery phases from issue 60), but it is no longer the primary notification surface — no behavior change needed beyond what 1–2 move into the chat.
4. **Issue 61's on-ask digest becomes catch-up only**: it must not re-list blocks already delivered live to this session (extend the fed-tracking so live-fed and digest-fed share one "session has seen it" set).

E2E-first (per CONFIG's machine-before-human rule): extend the harness's fake chat PTY scenarios — a mixed drain must show, in order, one submitted message per finished Run containing its block's What-changed, the HITL park notice, and no duplicates when the user then asks for a digest.

## Acceptance criteria

- [ ] E2E: cap-1 mixed drain with lingering workers delivers one conversation message per finished Run (containing the block's heading + What-changed), plus the HITL park notice — all via the pump, all surviving a session replacement.
- [ ] A digest ask after live delivery does not repeat already-delivered Runs; a session opened mid-drain still catches up via the digest.
- [ ] Junk/unknown records and debounced status refreshes send nothing to the conversation.
- [ ] Blocking-approval behavior (merge conflict / abort / HITL sign-off) unchanged.
- [ ] Unit tests on the routing decision (what goes to chat vs history-only); full suite + type-check + `npm run test:e2e` pass.

## Blocked by

- 60, 65
