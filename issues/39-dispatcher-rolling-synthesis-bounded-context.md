---
status: done
depends_on: [34, 35]
---

# 39 — Rolling synthesis: keep the Dispatcher's own context bounded

## Parent

`docs/PRD-dispatcher.md` — Mission Control Dispatcher.

## What to build

Make the Dispatcher apply the `/clear` insight to itself (ADR-0009) so a long drain doesn't degrade its judgment. The **rolling-synthesis state** module (pure) folds finished/merged issues into a compact running "situation summary," keeps full detail in active context only for **open or flagged** threads, and drops verbatim Completion blocks from active context once they're folded in and persisted to the Run log. Active context stays bounded: seed + rolling summary + recent-N blocks + open/flagged threads. The Dispatcher can **re-read** a specific past block from the on-disk Run log (issue 34) on demand when a later issue makes an old one relevant.

## Acceptance criteria

- [ ] `(situationSummary, event) → boundedNextState` is a pure module, unit-tested: a finished-and-merged issue folds into the summary and drops from verbatim; an open/flagged (e.g. doc-drift) thread stays verbatim; state size stays bounded across many events.
- [ ] The Dispatcher's active context does not grow unbounded across a long (many-issue) drain.
- [ ] The Dispatcher can retrieve an earlier Completion block from the Run log on demand (a late issue referencing an early one works).
- [ ] The retention rule (full detail for open/flagged only; everything else folded + on disk) is the one implemented.

## Blocked by

- 34
- 35
