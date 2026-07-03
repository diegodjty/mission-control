---
status: open
depends_on: [45]
---

# 46 — Auto-proceed clean merges; gate only on conflict

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0011, refines ADR-0002).

## What to build

Under Dispatcher-driven drains, a **clean, conflict-free Merge auto-proceeds** — the Dispatcher runs it on its own and leaves a passive note ("merged 05 clean") — while a **conflicting/risky merge blocks** for one-click approval (per issue 45's blocking list). This refines ADR-0002 ("Merge always human-triggered") to *auto-on-clean, gate-on-conflict* for the Dispatcher path. Reuse the existing merge adapter (`src/main/run-merge.ts`, issues 08/23/24), which already classifies clean vs conflict vs preflight-failure — wire the Dispatcher to auto-invoke on clean and only surface the conflict/failure cases. The manual **Merge button** on the Map (execution view) is unchanged.

## Acceptance criteria

- [ ] During a Dispatcher drain, a clean merge of finished parallel work proceeds automatically (no click), logged as a passive note.
- [ ] A merge that conflicts (or fails preflight) blocks for approval and surfaces the reason (issues 17/23/24), never auto-resolving.
- [ ] The manual Map Merge button behaves exactly as before (unchanged).
- [ ] The auto-vs-gate decision (clean → auto, conflict/failure → block) is pure and unit-tested.
- [ ] type-check + build pass.

## Blocked by

- 45
