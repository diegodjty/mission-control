---
status: open
depends_on: []
---

# 61 — The Dispatcher session must hold the Completion blocks: fold a block digest into the on-ask snapshot

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 finding, 2026-07-03).

## What to build

Walkthrough-58 exposed a contradiction the ADR-0012 recalibration introduced: rerouting completed-issue reports out of the chat (issues 45–49) also stopped them from ever reaching the Dispatcher *session's context* — the ambient log is UI-only. So the claude session honestly answers "nothing has reported in yet" mid-drain, violating ADR-0009's contract that the Dispatcher "holds the summaries." The user-approved middle path: **the chat stays quiet; the session's knowledge catches up when the user asks.**

Extend the on-ask ground-truth injection (issue 52's `buildStatusSnapshotMessage` path): alongside the reconciled status snapshot, include a compact digest of the Completion blocks captured since the session's seed (or since the last injection) — per Run: issue id + slug, declared outcome, and a one-to-two-line What-changed/park-reason extract from the parsed record. Blocks the session has already been given are not repeated (track fed ids the same way `dispatcherFed` does today). No new automatic chat messages: the digest rides the existing on-ask injection through the same serialized queue and typing gate; blocking notifications (issue 60) are unchanged. Cap the digest defensively (newest N with an "…and K earlier Runs" line) so a long drain can't blow the session's context — ADR-0009's bounded-context rule still governs.

Doc note for the completion block: this refines the CONTEXT.md "Dispatcher input contract" wording (blocks reach the session on-ask rather than as a live typed stream) — flag it under Doc drift; amending CONTEXT.md/ADR-0012 is the user's call.

## Acceptance criteria

- [ ] Mid-drain "where are we at?"-style ask injects status + a digest naming each captured Run (issue, declared outcome, one-line substance); the session's answer can name completed issues and the parked HITL issue without reading disk.
- [ ] Already-digested blocks are not re-injected on the next ask; new Runs since the last ask are.
- [ ] Digest is capped (newest N + count of elided) — a 50-Run drain injects a bounded message.
- [ ] No new unprompted chat messages; ADR-0012 routing (cards + ambient log) is unchanged.
- [ ] Unit tests on the pure digest builder (inclusion, dedupe, cap, HITL park wording); full suite + type-check pass.

## Blocked by

None - can start immediately.
