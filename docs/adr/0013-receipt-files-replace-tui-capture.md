# Workers hand off results via Receipt files; the live TUI stream is never parsed

**Status:** accepted. Refines ADR-0009 (the Dispatcher's input path) and extends ADR-0006 (watch, don't poll). Supersedes the PTY scroll-capture edge as the source of Completion blocks. Amended 2026-07-09 — Receipt write ordering (see **Amendment** below).

The Dispatcher's input was captured by scraping the Worker Pane's raw TUI scrollback (tail-truncated PTY buffer → `parseCompletionBlock`). Live use showed the scrape grabs boot-screen banners instead of the Worker's real final block: ~15 unclassifiable entries polluted status, and a misclassified HITL block meant the `hitl-waiting` notice never fired (issue 53). The root cause is structural, not a parser bug: MC was *inferring* from noisy scroll what the Worker could simply *declare* — and a TUI stream never signals "my final message is complete" (Workers don't exit; the Pane sits at a prompt).

**Decision:** every Worker exit path writes a **Receipt** — `issues/completions/NN-slug.md`, committed, one per issue (latest Run wins) — with YAML frontmatter declaring the machine-facing facts (`issue`, `slug`, `outcome: completed | needs-verification | blocked`, `finished`) and the verbatim §5 Completion block as the body. The write instruction lives in the global `afk-issue-runner` SKILL.md (producer-owned contract), at **all three** exit points: finish (§5), HITL park (§2), and blocked (§6). Mission Control's capture pipeline has exactly one input: Receipt files. This also matches CONTEXT.md's pre-existing definitions — Artifacts already listed "the completion blocks the afk-issue-runner emits" and the Map is "rendered from the artifacts on disk, never from a live agent stream"; the scroll scrape contradicted the glossary.

## Considered Options

- **Patch the scroll parser** (skip boot banners). Rejected: polishes a mechanism with no completion signal and an unbounded noise surface; the inference-error class survives.
- **MC-private contract** (inject the write instruction in MC's spawn prompt, skill untouched). Rejected: every future consumer re-specifies the contract; hand-run terminal drains leave no Receipt. The Receipt pattern is intended as the standard result-handoff for the wider tool ecosystem, so it belongs to the producer.
- **Receipts outside the repo / gitignored.** Rejected: divorces the record from the git history it describes; parallel-mode receipts would die with their worktree. Committed under `issues/` they are true Artifacts, ride the `afk/NN-slug` branch, and Merge carries them to main.
- **File primary + scroll fallback/cross-check.** Rejected: dual capture paths keep the broken class alive and double the test surface; per ADR-0012 a cross-check can only add noise. A missing Receipt is *information*, surfaced honestly.

## Consequences

- **Trust hierarchy:** git/issue-frontmatter stays ground truth for *state*; the Receipt is ground truth for *narrative*. On disagreement, state wins and the mismatch surfaces as one debounced passive note (ADR-0012).
- **Missing Receipt** (issue flips `done`, no file): one explicit "finished without receipt — peek at the Pane" passive note. Never a scrape, never a guess.
- `parseCompletionBlock` demotes to fallback: outcome classification reads the declared frontmatter; the §5-block parser handles a missing/broken frontmatter over the file body only. ANSI stripping and boot-screen heuristics stop being load-bearing.
- The PTY tail buffer survives for human peek/debug only — it is no longer an input to any classifier, status model, or the Dispatcher feed.
- **Watch mechanics** (extends ADR-0006): the existing `issues/` watcher covers solo Runs; in parallel mode MC watches each Run's worktree `issues/completions/`. The file event *is* the "final message complete" signal the TUI could never give. Implementation must debounce half-written files and dedupe re-ingestion after an MC restart (key: `issue` + `finished`).
- **Skill edit** required in `~/.claude/skills/afk-issue-runner/SKILL.md`: all three exit points write the Receipt; parallel mode commits it on the `afk/NN-slug` branch; solo mode leaves it uncommitted on `main` with the rest of the work (the user's per-issue commit carries it).
- The Dispatcher input contract wording changes from "captured Completion blocks" to "Completion blocks read from Receipts"; "finished without receipt" joins the lifecycle-event set.

## Amendment (2026-07-09) — write the Receipt *before* the streamed final message

**Symptom.** In live use the "finished without receipt — peek at the Pane" note (above) fired on nearly every drain — including for Runs that plainly succeeded and whose Receipt was on disk. Proof: issue 104 appears in *both* the "Runs" (with its Receipt narrative) and "Notable events" (finished-without-receipt) sections of the 2026-07-08 drain journal, and a deterministic repro reproduced it with the real ReceiptWatcher + real `auditMissingReceipts`.

**Root cause — a race, not a lost Receipt.** The Worker flipped the issue `done` first, then *streamed its full completion block as its final message* (multi-second), then wrote the Receipt "last." Mission Control's audit starts a fixed grace timer (`RECEIPT_AUDIT_GRACE_MS = 5000`, `App.tsx`) the instant it observes the `done`-flip; the streamed block routinely outran it, so the note fired and the Receipt landed a beat later. The e2e suite never caught this because the scripted fake Worker writes the Receipt with a ~0 ms gap after the flip.

**Decision.** The producer contract (`afk-issue-runner` SKILL.md) now writes the Receipt *right after the status flip and before emitting the completion block as the final message* — keeping the flip first. The Receipt then lands adjacent to the flip (well inside the grace window) by construction, which is what "the file event *is* the final-message-complete signal" (Consequences, above) always intended. **No Mission Control code changes.**

**Why the producer, and why flip-first.** The commit paths were already robust — the Workbench `done` commit is Receipt-driven (`workbench-run-events.ts`) and the solo commit tolerates a late Receipt (`run-state.ts`) — so only the cosmetic note was affected; the smallest correct fix is the producer reorder, which also avoids adding timing logic to the large, untested `App.tsx`. Flip-first (not Receipt-first) is kept so a Worker that dies *between* the two writes leaves the softer, rarer disagreement (a `wip` issue with no Receipt) rather than a Receipt declaring `completed` for a still-`wip` issue.

**Rejected alternatives.** Lengthening the grace window (guessing a number as models/blocks stream slower); gating the note on Pane session-liveness (real Panes *linger* and never exit — issue 65 — so "session ended" is not an observable signal).

**Known gap (not closed here).** No automated test guards the producer ordering: MC's fake Worker models the *good* (~0 ms) ordering, and the audit's timing glue lives in the untested `App.tsx`. This amendment is the durable guard. A follow-up should extract the audit-timing decision into a pure, testable module and give the fake Worker a configurable flip→Receipt delay so CI can pin MC's tolerance.
