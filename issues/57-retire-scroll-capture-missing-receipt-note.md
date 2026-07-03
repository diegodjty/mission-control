---
status: open
depends_on: [56]
---

# 57 — Retire scroll capture; add the finished-without-receipt passive note

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (see also the **Receipt** entry in `CONTEXT.md`).

## What to build

The deletion slice: Receipts (issue 56) become the **sole** capture input. Remove the wiring that feeds the PTY tail buffer into `parseCompletionBlock` / the Dispatcher feed; the tail buffer itself survives for human peek/debug only and is no longer an input to any classifier, status model, or feed. The boot-screen/unclassifiable capture class must be gone by construction — no scroll text can reach the Run log or status.

In its place, one honest signal: when ground truth says a Run ended (issue flips `done`/parks per git/afk-scan) but no Receipt exists for it, derive a single `finished-without-receipt` lifecycle event that lands as one passive note ("issue NN finished without a receipt — peek at the Pane"), per the Dispatcher input contract in `CONTEXT.md`. Never a scrape, never a guess, never more than one note per Run. Trust hierarchy per ADR-0013: git/issue-frontmatter stays ground truth for state; the Receipt is narrative only — a state/narrative mismatch surfaces as one debounced passive note, state wins.

## Acceptance criteria

- [ ] No code path parses PTY scroll into completion records; the tail buffer is reachable only from peek/debug surfaces.
- [ ] A drain in the sandbox produces zero unclassifiable/boot-screen entries in status or the Run log.
- [ ] A Run that ends with no Receipt yields exactly one `finished-without-receipt` passive note naming the issue — in the ambient log, not the chat.
- [ ] A Receipt/frontmatter state disagreement (e.g. Receipt says completed, issue file says wip) surfaces as one debounced passive note and the status model follows git.
- [ ] Tests covering the missing-receipt note and the removed scroll path (a boot-screen-shaped buffer produces nothing); type-check and full suite pass.

## Blocked by

- 56
