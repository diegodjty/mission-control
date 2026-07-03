---
status: open
depends_on: [47]
---

# 48 — Passive notes render in the ambient log, not the chat; serialize input; don't inject while typing

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0012).

## What to build

Fix the "prompt over prompt" racing (ADR-0012) by separating the two channels:
- **Passive notes render in the ambient activity log, NOT injected into the Dispatcher chat session.** Routine facts (committed / merged-clean / done / issue-logged) become quiet lines in the bounded activity log (issue 44's resolved-log area), not messages typed into the chat PTY. Only **blocking approvals** and the **user's questions + the Dispatcher's answers** use the chat. This structurally removes most of the input collisions.
- **One serialized queue** for any remaining programmatic writes to the chat session, and **no injection while the user is composing** — defer a programmatic write until the input line is idle, so the app never interleaves with the user's typing.

Currently everything (blocks, status refreshes, lifecycle, synthesis) is written into the one chat PTY (issues 35/41/43), racing with the user. Route the ambient stuff to the log; keep the chat for conversation + the 3 blocking items.

## Acceptance criteria

- [ ] Routine passive facts appear in the ambient log and are NOT typed into the chat session.
- [ ] The chat carries only: blocking-approval prompts, the user's messages, and the Dispatcher's replies.
- [ ] All programmatic chat writes go through one serialized queue; none is issued while the user is mid-compose (deferred until idle).
- [ ] Driving a drain while manually typing does not interleave/garble input ("prompt over prompt" gone).
- [ ] Pure routing/queue logic (which channel a given event uses; defer-while-typing gate) is unit-tested; on-screen behavior via the batch QA walkthrough.
- [ ] type-check + build pass.

## Blocked by

- 47
