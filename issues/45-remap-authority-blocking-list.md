---
status: open
depends_on: []
---

# 45 — Re-map the Dispatcher authority to the 3-item blocking list

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0011).

## What to build

Invert the Dispatcher's authority posture per ADR-0011: **silent autonomy by default**. The authority classifier (`src/shared/dispatcher-authority.ts`, issue 36) must map to a **three-item blocking list** — the ONLY actions that block for a one-click approval are: **(1) a Merge that hit a conflict, (2) aborting/stopping a drain, (3) a HITL issue awaiting the user's sign-off**. Everything previously `needs-approval` — logging a follow-up issue, a clean merge, amend-plan, discard-and-continue, course tweaks — becomes either **silent** or a **passive note** (see issue 48 for where passive notes render). Re-map the classifier and the proposal/activity wiring (issues 36/38) so those no longer raise blocking approve/reject prompts.

## Acceptance criteria

- [ ] The classifier blocks ONLY on the three items (merge-conflict, abort, HITL sign-off); everything else is non-blocking.
- [ ] Logging an issue, a clean merge, amend-plan, discard-and-continue no longer produce a blocking approve/reject gate.
- [ ] The three blocking actions still require explicit user approval before executing.
- [ ] The classifier is pure and unit-tested against the full action set → {blocking | silent | passive}.
- [ ] type-check + build pass.

## Blocked by

None - can start immediately.
