---
status: done
depends_on: []
---

# 41 — Dispatcher feed must auto-submit the Completion block (not just type it)

## Source

Issue-35 live verification (2026-07-03): during a drain the Dispatcher panel stayed inert as Runs finished. Root cause: each Run's Completion block is fed with a single `window.mc.writePty({ sessionId, data: \`${oneLine}\r\` })` (App.tsx ~L928). The block text and the trailing `\r` go in **one** PTY write; under the claude TUI's bracketed-paste handling the `\r` is treated as literal input rather than a submit, so the block sits in the input box **unsent** — the user had to press Enter manually. So the Dispatcher never received/processed blocks automatically, and never narrated. (Synthesis was fine; the messages weren't being submitted.)

## What to build

Make the Dispatcher feed actually **submit** each Completion block, with no human keystroke. Send the block text, then submit it as a **separate** action — e.g. a distinct `\r` (Enter) PTY write after the input settles, and/or handle bracketed paste so the submit isn't absorbed into the pasted text. Multiple blocks arriving close together (parallel drain) must each be submitted **distinctly** (never concatenated into one input). After this, as each Run finishes the Dispatcher should receive its block and narrate a short synthesis on its own — the behavior PRD story 2 promises — with no manual Enter.

## Acceptance criteria

- [ ] A Completion block fed to the Dispatcher is submitted automatically (the session receives and processes it with no human keystroke).
- [ ] Two blocks arriving in quick succession are submitted as two distinct messages, not merged.
- [ ] After the fix, driving a drain shows the Dispatcher narrating per finished Run without the user pressing Enter (live verification — the issue-35 walkthrough).
- [ ] Any pure/formatting helper introduced (e.g. building the submit sequence) is unit-tested; type-check + build pass. The live auto-narration is confirmed via the issue-35 / batch QA walkthrough.

## Blocked by

None - can start immediately.
