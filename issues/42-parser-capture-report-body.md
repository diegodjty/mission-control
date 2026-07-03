---
status: done
depends_on: [34]
---

# 42 — Completion parser drops the blocked / no-work report body (Dispatcher gets a header, no substance)

## Source

Issue-35 live verification (2026-07-03): the Dispatcher received a blocked Run's block as a header only ("03 blocked") with no reason, and correctly said the body didn't land. Confirmed root cause in `src/shared/completion-parser.ts` — the blocked / no-work handler returns all-null section fields + `outcome: 'blocked'` (≈L148-153); it captures **no blocker reason**. The `RunLogRecord` fields are `{whatChanged, tryIt, verified, bookkeeping, docDrift, outcome}` — none holds a free-form report body, so a blocked/"no work available"/`unknown` report has **no substance** in the record. When the feed renders the record for the Dispatcher (`renderCompletionEvent` from the structured fields), there's nothing but a header to send. The loss is at PARSE time, before the feed. (The `flattenMessage` step is fine — it preserves content; completed blocks, which populate the section fields, feed correctly.)

## What to build

Capture the meaningful body of **every** report shape into the structured record, so the Dispatcher receives substance regardless of outcome:
- A **blocked / no-work** report: capture its reason / what-it's-waiting-on text into a field (e.g. a new `detail`/`body` field, or populate `whatChanged` with the report body when no named sections exist).
- A **needs-verification** (HITL) report and an **unknown**/unparsed block: likewise carry their body, so nothing meaningful is silently dropped.
- Ensure the Dispatcher feed (`renderCompletionEvent` / the message built in App.tsx) includes that captured body, so the block the Dispatcher receives contains the reason, not just the header.
Keep the parser pure and never-throw; keep completed-block behavior unchanged.

## Acceptance criteria

- [ ] A blocked report's reason/detail is captured into the `RunLogRecord` (not dropped), and the message fed to the Dispatcher includes it.
- [ ] needs-verification and unknown/unparsed reports also carry their body into the record.
- [ ] Completed blocks are unchanged (section fields still parsed as before).
- [ ] Parser stays pure and never throws; new behavior is unit-tested with a real blocked report, a needs-verification block, and a body-only/unknown block asserting the body survives.
- [ ] The Run-log card and the Dispatcher feed both show the captured body for a blocked Run.

## Blocked by

- 34
