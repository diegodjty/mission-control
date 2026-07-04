---
status: open
depends_on: [72]
---

# 73 — Memory injection + journal: CORE.md into every seed, drain summaries out

## Parent

`docs/adr/0015-the-workbench.md` — the Workbench.

## What to build

The memory loop's MC half. **In:** when spawning a Worker or seeding a Dispatcher for a workbench Project, read `memory/CORE.md` and include it in the prompt under a clearly-labeled context section (missing/empty CORE = silently omitted; oversized CORE = truncated at the ADR's ~1.5k-token cap with a truncation marker — never unbounded). **Out:** when a drain ends (any stop reason), the Dispatcher layer appends a dated summary artifact to `memory/journal/` — issues completed/parked/blocked with one-line outcomes, doc-drift flags, and notable events (adoptions, missing receipts) — content assembled from the Run log via a pure builder, written once per drain, auto-committed with the workbench commit path from issue 72. Legacy Projects: no memory dir, both halves inert.

## Acceptance criteria

- [ ] Worker prompts and Dispatcher seeds for a workbench Project contain CORE.md's content, capped and labeled; absent CORE injects nothing.
- [ ] A finished drain writes exactly one journal entry naming every Run and its outcome; a second drain the same day gets its own entry (no clobber).
- [ ] Pure journal builder + cap/truncation unit-tested; e2e asserts a fixture drain produces the journal artifact; full suite + type-check pass.

## Blocked by

- 72
