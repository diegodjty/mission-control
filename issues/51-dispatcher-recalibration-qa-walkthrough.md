---
status: open
depends_on: [45, 46, 47, 48, 49, 50]
hitl: true
---

# 51 — Dispatcher recalibration QA walkthrough (HITL)

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0011 + ADR-0012).

## What to build

Not a build slice — the human walk-through confirming the Dispatcher is now quiet, legible, and hands-off (the "daily-usable" bar). Drive a real drain against a seeded multi-issue backlog (with a HITL issue and a couple of parallel issues) and confirm the recalibration held:

## Acceptance criteria

- [ ] **Quiet by default (ADR-0011):** a full drain runs with **no approval prompts** except the three blocking cases; routine progress does not interrupt you.
- [ ] **Clean merges auto-proceed (46):** parallel finished work merges on its own with a passive note; you are NOT asked to approve a clean merge.
- [ ] **Conflict still gates (46):** force a conflict → the Dispatcher blocks for approval and shows the reason, never auto-resolves.
- [ ] **HITL sign-off still gates + is announced (45/37):** the HITL issue blocks for your sign-off and the Dispatcher proactively tells you it's waiting, with steps.
- [ ] **Abort gates (45):** stopping the drain asks first.
- [ ] **No noise (47):** no "unclassifiable Run" spam from boot screens, no doc-drift-on-none, no repeated "consolidate?" prompts across the whole drain.
- [ ] **Passive-not-chat + no racing (48):** routine facts appear in the ambient log, not the chat; typing to the Dispatcher while a drain runs does not garble ("prompt over prompt" gone).
- [ ] **No false regression alarm (49):** the drain completes without a false "merge is failing / regressed to open" escalation.
- [ ] **Clean finish (50):** after all merge, `.afk-worktrees/` is empty and no merged `afk/*` branches remain.
- [ ] **Overall:** it feels like talking to one calm orchestrator, not clicking through a firehose.

## Blocked by

- 45, 46, 47, 48, 49, 50

## Human prerequisites

- Node 22 + authenticated `claude` CLI (covered by `issues/HUMAN-SETUP.md`); auto mode is the global default.
