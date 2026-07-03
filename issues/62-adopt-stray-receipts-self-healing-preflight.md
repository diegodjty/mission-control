---
status: open
depends_on: []
---

# 62 — Adopt stray Receipts: design for sloppy Workers, halt only on unknown state

## Parent

`docs/adr/0013-receipt-files-replace-tui-capture.md` — Receipt files replace TUI capture (walkthrough-58 second-attempt finding, 2026-07-03).

## What to build

Root cause of the second failed walkthrough: a Worker in parallel mode wrote its Receipt into the **main checkout's** `issues/completions/` instead of its own worktree's copy (its branch commit `e8c22dc` has everything except the Receipt; the file sat untracked on main). One stray file → main "dirty" → the merge preflight refused every subsequent merge → four Runs piled up finished (unmerged) and the drain looked broken. Workers are LLMs: occasionally misplacing a file is a *when*, not an *if*. The posture change: **Mission Control repairs known artifacts and halts only on genuinely unknown state.**

1. **Adopt, don't halt.** Before any merge preflight (and on the solo finished path), untracked or modified files under `issues/completions/` on main are *adopted*: auto-committed with a dedicated message (e.g. `chore: adopt stray Receipt(s) — <files>`), logged as a passive note. The merge then proceeds normally. Ingest already handles both locations (the stray Receipt did reach the Run log) — this issue is about the git state it leaves behind.
2. **Unknown dirt still halts, truthfully.** Anything dirty *outside* the adopted set keeps issue 59's behavior: a passive "uncommitted changes on main: <paths>" halt, no fake conflict gate. The adopted-path set is exactly `issues/completions/` — do not generalize to other paths in this issue.
3. **Harden the cause, not just the consequence.** Wherever MC composes a Worker Run's prompt/launch, include the Run's explicit **absolute** Receipt path (its own worktree's `issues/completions/NN-slug.md` in parallel mode), so cwd confusion can't misplace the write. The skill's relative-path wording stays as the general contract; the per-Run absolute path is MC being defensive.

## Acceptance criteria

- [ ] Real-git integration test: finished branches + a stray untracked Receipt on main → merge auto-adopts (one `chore: adopt stray Receipt(s)` commit), then merges cleanly; one passive note records the adoption.
- [ ] A stray *modified* Receipt on main is adopted the same way; a dirty non-Receipt path (e.g. `docs/PRD.md`) still halts with the issue-59 message and is NOT auto-committed.
- [ ] Worker Run launch includes the absolute per-Run Receipt path in its prompt/config.
- [ ] Solo finished path also adopts a stray Receipt (covers a solo Worker writing to an unexpected-but-known location).
- [ ] Unit tests for the adopt/halt decision (pure); full suite + type-check pass.

## Blocked by

None - can start immediately.
