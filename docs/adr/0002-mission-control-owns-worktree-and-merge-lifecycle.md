# Mission Control owns the worktree + merge lifecycle, keyed on concurrency

Isolation is Mission Control's job, not the user's, and it keys off how many Runs are live: a **single Run works directly on `main`** (solo mode, no worktree); as soon as **2+ Runs** run concurrently, Mission Control auto-enables parallel mode, gives each Run its own git worktree on an `afk/NN-slug` branch, and — when the parallel Runs finish — surfaces a human-triggered **Merge** action on the Map that runs `afk-merge.sh` and reports conflicts.

## Considered Options

- **Hands-off** — Mission Control opens panes; the user sets parallel mode and merges manually. Rejected: this is exactly today's friction (merge confusion — *"do i need to merge or not?"* — was a top pain point), just tiled.
- **Full lifecycle owner** (chosen) — Mission Control manages worktree creation and offers the merge.
- **Owner + auto-merge** — as chosen, but merges automatically on clean completion. Rejected: a merge is a costly, hard-to-unwind action, and auto-merging without a gate contradicts the app's permission posture (ADR-0001 / hybrid approvals).

## Consequences

- The single-issue common case stays trivial (no worktree overhead); the worktree tax is paid only when actually running in parallel.
- Directly retires the merge-confusion friction: merging becomes a labeled button that appears at the right moment, not an open question.
- Mission Control must detect the solo↔parallel transition and manage `issues/.afk-parallel` and worktree creation/cleanup itself.
