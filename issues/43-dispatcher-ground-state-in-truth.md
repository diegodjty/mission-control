---
status: done
depends_on: [34, 35]
---

# 43 — Dispatcher must ground "what's done/left" in ground truth, not the fed-block stream alone

## Source

Issue-35 live verification (2026-07-03): after a drain that completed 02, 03, 04 (cap 1, stopped at 05/HITL), the Dispatcher's "what's left" reported only 01 and 02 done and listed 03/04 as still-to-run. Root cause: the Dispatcher infers done-ness **only** from the Completion blocks it's been fed (+ the seed backlog snapshot from drain start). A block that's missed, misparsed, or skipped drifts its picture from reality. Two contributing factors: (1) unknown-outcome captures are dropped from the feed (`App.tsx`: `if (rec.outcome === 'unknown') continue`), so if 03/04 didn't parse as `completed` the Dispatcher never heard about them; (2) there is no re-grounding against the authoritative state. (For cap≥2 the same drift appears via a different route: an unmerged worktree's `done`-flip is on the `afk/` branch, invisible to anything reading `main`/blocks — the afk-scan already knows this as `finished-unmerged`.)

## What to build

The Dispatcher's authoritative model of **which issues are open / wip / done / finished-unmerged** must come from the **live backlog + Run-log store + afk-scan** (the same sources of truth the Map uses), re-grounded as state changes — NOT inferred solely from the fed block stream. Completion blocks remain the source of the *qualitative* synthesis (what changed, why blocked, doc-drift); they are not the source of *status*. Concretely: feed/refresh the Dispatcher with the current backlog statuses (and finished-unmerged set) as they change, so "what's left" always reconciles to reality. Also stop silently dropping unknown-outcome captures from the feed — they now carry `detail` (issue 42), so convey them (as an unknown/needs-look item) rather than skipping, so nothing a Run emitted is lost.

## Acceptance criteria

- [ ] After a drain completes N issues, the Dispatcher's "what's left" matches the actual backlog/Run-log done-set (no phantom "not done" for issues that are done).
- [ ] A finished-unmerged issue (cap≥2) is reflected as finished-unmerged, not as "still to run".
- [ ] Unknown-outcome captures are conveyed to the Dispatcher (with their `detail`), not silently skipped.
- [ ] Blocks are still used for qualitative synthesis; status comes from ground truth.
- [ ] The reconciliation logic (backlog/scan/Run-log → status model handed to the Dispatcher) is pure and unit-tested; the live-accuracy is confirmed via the issue-35 / batch QA walkthrough.

## Blocked by

- 34
- 35
