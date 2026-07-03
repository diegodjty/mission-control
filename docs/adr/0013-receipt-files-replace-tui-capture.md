# Workers hand off results via Receipt files; the live TUI stream is never parsed

**Status:** accepted. Refines ADR-0009 (the Dispatcher's input path) and extends ADR-0006 (watch, don't poll). Supersedes the PTY scroll-capture edge as the source of Completion blocks.

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
