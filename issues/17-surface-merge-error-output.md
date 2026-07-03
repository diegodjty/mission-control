---
status: done
depends_on: [8]
---

# 17 — Surface merge error output ("see details below" shows nothing)

## Source

Issue-10 batch QA walkthrough finding (2026-07-02). A failed Merge showed "Merge could not run — see details below." next to the button, but **no details appeared anywhere**, leaving the user unable to tell what went wrong. Confirmed in code: `mergeRuns` (`src/main/run-merge.ts`) returns the real error text in the result's **`output`** field (afk-merge.sh stdout/stderr) and a short summary in `message`, but the renderer only displays `result.message` (`App.tsx` sets `mergeMessage = result.message`; `Map.tsx` renders only `mergeMessage`). The `output` field — the actual "details below" — is never rendered.

## What to build

When a Merge fails (or conflicts), show the result's `output` (and a clear failure state) in the UI, so "see details below" actually has a below. A collapsible/scrollable details panel beneath the Merge button is fine; it must show the script's output verbatim (it names missing branches, conflicts, preflight refusals, etc.). Keep the concise `message` as the headline. On a clean merge, the existing success message behavior is unchanged (no noisy output dump required, though showing it is acceptable).

Also handle the empty/degenerate case cleanly: if Merge is triggered with no actually-mergeable branches on disk (e.g. stale in-memory state after the branches were removed), the message should say so plainly ("no finished branches to merge") rather than a bare "could not run".

## Acceptance criteria

- [ ] A failed Merge renders the adapter's `output` text in the UI (scrollable/collapsible), not just the one-line "see details below" message.
- [ ] A conflict shows the conflicting-files output the script prints, with the existing "resolve then Merge again" headline.
- [ ] Triggering Merge with no mergeable branches on disk shows a plain "nothing to merge" style message, not "could not run — see details below".
- [ ] The success path still shows its concise merged-N message.
- [ ] Any pure formatting/selection logic (what to show for ok/conflict/empty/error) is unit-tested; the on-screen panel verifies via type-check + build + the batch QA walkthrough.

## Blocked by

- 8
