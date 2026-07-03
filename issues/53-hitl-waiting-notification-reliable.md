---
status: open
depends_on: [37, 47, 48]
---

# 53 — A parked HITL issue must reliably, prominently notify the user

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## Source / root cause

Issue-51 verification (2026-07-03): a cap-2 drain stopped at the HITL issue 05 (`hitl: true`), but the Dispatcher **never notified the user** that 05 was waiting for them — the whole point of issue 37's proactive HITL notification. Detection isn't the issue (05 is `hitl: true` and App.tsx reads that); `hitl-waiting` correctly maps to the `hitl-signoff` blocking action → chat channel. So the break is **upstream — the `hitl-waiting` lifecycle event isn't firing** for a parked HITL Run in a Dispatcher drain: likely the HITL run's "Ready for manual verification" block isn't being captured as a `needs-verification` record (issue 42/47), or the lifecycle effect isn't deriving a `hitl-waiting` event from it, so nothing is ever surfaced.

## What to build

Trace and fix the chain so a parked HITL issue **reliably** produces a **prominent** notification: the HITL run's "Ready for manual verification" block is captured (needs-verification), the lifecycle layer derives a `hitl-waiting` event for a `hitl: true` OR `(HITL)`-heading issue, and it surfaces to the **chat** (blocking tier) — naming the issue and relaying its manual-verification steps (from the captured `detail`, issue 42). It must not be lost to the ambient log or the noise floor. Add a test that a drain reaching a parked HITL issue yields exactly one prominent HITL-waiting notification with the issue id + steps.

## Acceptance criteria

- [ ] When a drain reaches a parked HITL issue (left `wip`, awaiting sign-off), the Dispatcher proactively surfaces a prominent chat notification naming the issue and relaying its verification steps.
- [ ] Works whether the issue is marked `hitl: true` (frontmatter) or `(HITL)` (heading).
- [ ] The notification is not swallowed by the ambient-log routing (issue 48) or the noise floor (issue 47).
- [ ] The capture→needs-verification→hitl-waiting→chat chain is covered by a test (a parked HITL run → one notification with id + steps).
- [ ] type-check + build pass.

## Blocked by

- 37
- 47
- 48
