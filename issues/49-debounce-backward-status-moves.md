---
status: open
depends_on: []
---

# 49 — Debounce backward status moves (finished→open) before surfacing

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0012).

## What to build

Stop the Dispatcher escalating on a transient mid-reconcile snapshot (the dogfood's false "05/06/07 regressed to open — the merge is failing" alarm). A **backward** status transition (e.g. `finished`/`finished-unmerged` → `open`, or `done` → not-done) must **persist across ≥1 reconcile checkpoint** before it is surfaced or escalated at all. Forward transitions surface immediately as before; only regressions are debounced. This lives in the status-grounding layer (issue 43) that feeds the Dispatcher.

## Acceptance criteria

- [ ] A one-snapshot backward status move is NOT surfaced/escalated; it must persist across at least one more reconcile before the Dispatcher reacts.
- [ ] A genuine, persistent regression is still surfaced (after the debounce window).
- [ ] Forward transitions (open→wip→done, →finished-unmerged→merged) surface without added delay.
- [ ] The debounce/transition logic is pure and unit-tested (transient blip suppressed; persistent regression passes through; forward unaffected).
- [ ] type-check + build pass.

## Blocked by

None - can start immediately.
