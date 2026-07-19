# The Dispatcher keeps its own context bounded via rolling synthesis; the Run log on disk is the durable record

**Status:** retired by ADR-0022 (2026-07-18). Cross-run synthesis is dropped outright — per-issue doc-drift is caught at the source by the completion-block rule, and cross-run pattern-spotting is now `/debrief`.

The **Dispatcher** manages its own context so it doesn't become the bloated thing it exists to avoid. It folds finished/merged issues into a compact running "situation summary," keeps full detail in active context only for **open or flagged** threads, and drops verbatim **Completion blocks** from active context once they're folded in and persisted to the **Run log** on disk. Its active context is therefore a bounded sliding window: seed (backlog + PRD/CONTEXT) + rolling synthesis + recent-N blocks + open threads. The Run log (on disk) is the complete, durable history, re-readable on demand.

## Considered Options

- **Keep everything verbatim** — every Completion block stays in the Dispatcher's context for the whole drain. Rejected: context grows unbounded; by issue 40 it degrades — the exact problem the user's `/clear`-per-issue ritual fights.
- **Rolling synthesis** (chosen) — the Dispatcher applies the `/clear` insight to itself.

## Consequences

- A long drain (50–100 issues) doesn't degrade the Dispatcher's judgment, because its active context stays bounded regardless of drain length.
- The Run log must be a durable on-disk store (not just in-memory), so the Dispatcher can re-read a specific past block when a later issue makes an old one relevant (e.g. a doc-drift flag from issue 7 mattering at issue 30).
- Requires a retention rule the implementation encodes: full detail for open/flagged threads; everything else folded to the running summary + on-disk Run log.
- This mirrors the harness's own long-conversation context management, made explicit for the orchestrator — and is the same principle as ADR-0001 (structured data from artifacts, not a raw stream) applied to the Dispatcher's memory.
