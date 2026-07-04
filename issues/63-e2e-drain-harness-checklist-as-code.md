---
status: done
depends_on: [62]
---

# 63 — E2E drain harness: walkthrough 58's checklist as code, with deliberately misbehaving Workers

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 second-attempt finding, 2026-07-03).

## What to build

Three human walkthroughs in a row failed on seam bugs that 700 unit tests could not see, because the seams (watchers, timers, git, worktrees, PTY delivery, React effects) were only ever exercised by a human driving the live app. Build the walkthrough as an automated end-to-end suite so a human walkthrough is only ever run *after the machine already passed it*.

Shape: a `npm run test:e2e` suite that drives the **real modules against real infrastructure** — a temp git repo seeded like the QA sandbox (issue backlog incl. an HITL issue and a dep-blocked issue), the real receipt watcher on the real filesystem, real worktrees and the real merge path, the real ingest → feed → lifecycle → pump pipeline (pump against a scripted fake PTY that records typed/submitted messages). Workers are **scripted and deterministic** — a small fake-worker driver that, per issue, writes the deliverable, flips status, commits (parallel) and writes the Receipt per the skill's contract — **with configurable misbehavior modes**: receipt-to-wrong-checkout (the walkthrough-2 bug), no-receipt-at-all, receipt-written-before-commit, die-mid-exit (flip done, then stop). No LLM anywhere in the suite.

Scenarios must map 1:1 to walkthrough 58's checklist:

1. Solo Run → ONE commit containing deliverable + flip + Receipt; a Run-log record with declared outcome.
2. HITL Run parks → `hitl-waiting` derived → the notification is **delivered** (fake PTY saw typed + submitted), surviving a mid-queue session replacement (issue 60's guarantee, end-to-end).
3. Zero unclassifiable records across a full mixed drain.
4. Parallel Runs → Receipts ingested live from worktrees pre-merge → clean auto-merge lands Receipts on main.
5. Misbehavior: stray Receipt on main → adopted (issue 62) and merges proceed; no-receipt Worker → exactly one finished-without-receipt note; die-mid-exit → the Run does not stall the drain's remaining issues.
6. Dirty non-Receipt file on main → truthful halt, no merge, no fake conflict.

Keep it honest and maintainable: if a checklist item genuinely cannot be exercised without the live Electron shell, mark it explicitly in the suite output as `manual-only` with the reason — no silent coverage gaps. Wire the command into `issues/CONFIG.md`'s test commands and document a one-line "run this before any human walkthrough" rule there.

## Acceptance criteria

- [ ] `npm run test:e2e` exists, runs headlessly on Node 22, and passes, with scenarios 1–6 above each present and named.
- [ ] The fake-worker driver supports the four misbehavior modes; at least the stray-receipt and no-receipt modes are exercised in the passing suite.
- [ ] Reverting issue 62's adoption logic makes the stray-receipt scenario fail (the suite guards the fix).
- [ ] Any checklist item not covered is listed as `manual-only` with a reason in the suite/docs — zero silent gaps.
- [ ] `issues/CONFIG.md` documents the command and the "machine passes before human walkthrough" rule; full suite + type-check pass.

## Blocked by

- 62
