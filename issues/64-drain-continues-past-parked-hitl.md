---
status: open
depends_on: [63]
---

# 64 — A parked HITL issue must not halt the drain

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (surfaced by issue 63's e2e harness).

## What to build

The e2e harness proved that a cap-1 mixed drain **stops entirely** at a parked HITL issue: the Run Coordinator derives the park (session ended, issue still `wip`) as `blocked`, and a blocked Run halts the drain — so eligible issues after the HITL park never run. Parking is success, not failure: the Worker did its job, the `hitl-waiting` notice (issues 53/60) tells the human, and the drain should move on.

Teach the coordinator/run-state to distinguish a **parked HITL Run** from a genuinely blocked one and continue the drain past it:

- A Run whose Receipt declares `outcome: needs-verification` (or whose issue is HITL-marked and ended `wip` with a Receipt) is a **park**: the drain skips that issue for the rest of the session and keeps scheduling other eligible issues. Issues that `depends_on` the parked one stay blocked naturally — no special casing.
- A Run that declares `outcome: blocked` (or ends with no Receipt and no done flip — the genuinely-unknown case) keeps today's conservative behavior: the drain stops and reports.
- The distinction must come from declared state (Receipt outcome / issue HITL marker), never from prose heuristics — same declare-don't-imply rule as ADR-0013.

Update the e2e harness to encode the new truth: Scenario 3's cap-1 mixed drain should now assert the drain continues past the park (e.g. started `[2,3,4,5,6,7]`, 05 left `wip`, exactly one hitl-waiting delivery), and a genuine `blocked` Worker still halts the drain. The walkthrough-58 checklist keeps working, minus the "stop the drain to preserve 06/07" workaround.

## Acceptance criteria

- [ ] Cap-1 mixed drain (e2e): runs every eligible issue, parks the HITL issue `wip`, delivers exactly one hitl-waiting notification, and finishes the rest — no halt.
- [ ] An issue depending on the parked HITL issue is not started; everything independent of it is.
- [ ] A Worker declaring `outcome: blocked` still halts the drain with today's report; a die-mid-exit Worker (no Receipt, no flip) also still halts.
- [ ] The park/blocked distinction reads declared state only (Receipt outcome / HITL marker), covered by unit tests on the pure decision.
- [ ] Full suite + type-check + `npm run test:e2e` pass.

## Blocked by

- 63
