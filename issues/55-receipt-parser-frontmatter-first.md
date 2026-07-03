---
status: done
depends_on: []
---

# 55 — Receipt parser (pure): frontmatter-first, block-parser fallback

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (see also the **Receipt** entry in `CONTEXT.md`).

## What to build

A pure `parseReceipt` module (sibling to the existing completion-block parser, same PURE contract: no I/O, never throws) that turns a Receipt file's text into the structured record the Dispatcher feed consumes. Declared facts win: when the YAML frontmatter carries a valid `outcome` (and `issue`/`slug`/`finished`), classification is a field read — no heading regexes, no heuristics. When frontmatter is missing or broken, degrade to the existing §5-block parser over the file body, flagged so downstream can tell a declared outcome from an inferred one. Any input (empty, malformed YAML, junk) yields a record — never a throw. ANSI stripping is irrelevant here by construction (Receipts are files, not PTY scroll) and must not be load-bearing.

## Acceptance criteria

- [ ] A well-formed Receipt (frontmatter + block) parses with the declared `outcome`, `issue` id, `slug`, and `finished` stamp, plus the block's sections from the body.
- [ ] Each of the three outcomes (`completed`, `needs-verification`, `blocked`) classifies from the frontmatter alone — a body whose prose *looks* like a different shape does not override the declaration.
- [ ] Missing or unparseable frontmatter falls back to the existing block parser over the body, and the record marks the outcome as inferred rather than declared.
- [ ] Empty/junk input yields an `unknown` record; nothing throws.
- [ ] Unit-tested in isolation; type-check and full test suite pass.

## Blocked by

None - can start immediately.
