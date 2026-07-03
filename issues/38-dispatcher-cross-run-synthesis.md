---
status: open
depends_on: [35]
---

# 38 — Cross-Run synthesis: doc-drift, patterns, consolidation

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

The synthesis-across-Runs value (the reason the Dispatcher exists beyond relaying): from the stream of Completion blocks it should (a) **flag doc-drift** — when a block reports a PRD/reality contradiction — and propose amending the plan (approval-gated); (b) **spot cross-Run patterns** — several Runs touching the same seam, a recurring class of finding — and surface them; (c) **consolidate** related findings from multiple Runs into one summary instead of leaving the user to re-derive the picture. This is the behavior modelled on the human dispatcher role (e.g. "these three Runs all hit the merge seam — consider a hardening pass").

Most of this is LLM behavior (verified via the QA walkthrough), but any pure helpers (e.g. extracting/grouping doc-drift entries from parsed blocks, detecting same-file/same-seam overlap across blocks) should be pure and unit-tested.

## Acceptance criteria

- [ ] When a Completion block reports doc-drift, the Dispatcher surfaces it and proposes a plan amendment (approval-gated).
- [ ] The Dispatcher can point out when multiple Runs touch the same seam / a recurring finding class.
- [ ] Related findings across Runs are consolidated into a single summary rather than listed raw.
- [ ] Pure helpers (doc-drift extraction/grouping, cross-block overlap detection) are unit-tested; LLM-level synthesis is verified via the batch QA walkthrough.

## Blocked by

- 35
