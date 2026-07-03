---
status: done
depends_on: []
---

# 47 — Dispatcher noise floor: drop empties, doc-drift-on-none, and the consolidate firehose

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher (recalibration, ADR-0012).

## What to build

Raise the bar for what the Dispatcher surfaces at all (ADR-0012), killing the three dogfood noise sources:
- **Empty / boot-screen / unclassifiable captures are dropped silently** — only a capture parsing to a real terminal outcome (completed / blocked / HITL / needs-verification) becomes a Run in the log. This **narrows issue 43**'s "convey unknowns as needs-a-look": a genuinely empty/boot-screen capture is noise, not a needs-a-look item. (Keep conveying a *real* unknown that has substance, if any; drop the empties.)
- **Doc-drift surfaces only on a real contradiction** — a `docDrift` of "none"/empty produces nothing (retires doc-drift-on-none in issue 38's detection).
- **Cross-run consolidation is demoted from a proposal to a rare, deduped passive note** — surfaced once, only on a strong concrete overlap (≥2 Runs genuinely touching the same file/seam), never the per-tick "consolidate?" firehose (issue 38).

Governing rule: routine facts are fine as passive notes, but **inferred/speculative signals must clear a high confidence bar — if in doubt, stay silent.**

## Acceptance criteria

- [ ] An empty/boot-screen/unclassifiable capture never becomes a Run, a note, or a needs-a-look item.
- [ ] Doc-drift on "none"/empty surfaces nothing; a real contradiction still surfaces.
- [ ] Consolidation surfaces at most once per strong overlap as a passive note (no proposal, no per-tick repeats); a weak/false overlap surfaces nothing.
- [ ] The classification/confidence logic (is-real-capture, is-real-drift, is-strong-overlap) is pure and unit-tested, including the exact dogfood noise cases.
- [ ] type-check + build pass.

## Blocked by

None - can start immediately.
