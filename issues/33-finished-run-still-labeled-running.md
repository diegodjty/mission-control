---
status: done
depends_on: [21]
---

# 33 — A finished Run still shows "running" / "Run in progress" on the Map until dismissed

## Source

Issue-10 QA walkthrough (2026-07-03): ran issue 02 solo via the Run button; it completed and the issue was marked `done`, but the Map row kept the **"running"** indicator and the detail panel kept **"Run in progress"** until the Pane was dismissed. Confirmed root cause in `src/renderer/src/App.tsx:508`: `activeRunIssueIds = runs.map((r) => r.target.issueId)` — the set that drives the Map row `running` prop (`Map.tsx:440`) and the detail-panel "Run in progress" label (`Map.tsx:482-485`) — is **every tracked Run's id, unfiltered by status**. So a Run that has reached `finished` (but whose tile/Pane is still on screen) continues to mark its issue as running. The Pane tile badge itself is correct (it uses `runStatusOf`, which returns `finished`); only the Map row + detail stick. A correctly status-filtered set already exists one block above (`liveRunIssueIds`, `App.tsx:476` — runs where `runStatusOf(r) === 'running'`).

## What to build

Drive the Map's "running" row indicator and the detail-panel "Run in progress" label from a status-filtered set (only Runs whose `runStatusOf` is actually `running`), not from the raw tracked-`runs` list — e.g. pass `liveRunIssueIds` (or an equivalent) as `activeRunIssueIds`. A finished/stranded/commit-failed Run that hasn't been dismissed must not read as "running" / "Run in progress". Verify this doesn't regress issue 21's duplicate-run suppression: a `done` issue is already ineligible (`eligibleForRun` false), so its Run button stays hidden regardless; confirm no Run button wrongly reappears for a finished-but-undismissed Run.

## Acceptance criteria

- [ ] After a solo Run reaches `done`, its Map row no longer shows "running" and its detail panel no longer shows "Run in progress" (even before the Pane is dismissed).
- [ ] The Pane tile continues to show `finished` correctly.
- [ ] No duplicate-Run affordance regresses: a finished-but-undismissed Run's issue does not get a live Run button (issue 21 invariant holds).
- [ ] A test asserts the row/detail "running" set is status-filtered (a finished tracked Run is excluded).

## Blocked by

- 21
