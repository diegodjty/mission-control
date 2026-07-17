# Merge-as-you-go: clean finished branches integrate continuously; solo-chaining retires

**Status:** accepted (2026-07-17). Refines ADR-0002 (MC owns the worktree+merge lifecycle) and ADR-0011 (clean merges auto-proceed — now *continuously*, not at press time). Updates ADR-0018's ordering assumption (ascending id → finish order) and its "purely advisory" line (previews now authorize the auto-lane). Retires the issue-111 solo-chain rule; supersedes issue 135's HITL-edge exemption once landed. Companion to the ADR-0001 amendment (headless drain lane), decided in the same grill.

Finished `afk/NN-slug` branches used to pile up until a human pressed **Merge**; `afk-merge.sh` then integrated them in ascending issue id, stopping at the first conflict. Two costs grew with every drain: (1) **divergence rot** — branches aged against a stale main until press time, manufacturing conflicts; (2) **solo-chain serialization** — because a dependent had to build on its dependency's committed work, and that work only reached main if the dependency ran *solo there*, any dependency edge between not-done issues forced both endpoints onto the single solo slot. The batch-QA aggregator's depends-on-everything edges then serialized entire drains (the issue-132/135 class).

## Decision

- **An auto-merge lane, always on, per repo.** On every Run-finish and every merge completion, MC sweeps the repo's finished-unmerged **Receipt-backed** `afk/` branches in **finish order** (first finished, first merged), merging each that the preview stamps clean against the *current* main tip. Precondition: idle main — clean tree, not mid-merge, no live solo Run; otherwise the sweep queues and re-fires when the state clears (per-repo serializer arbitrates). `afk-merge.sh` remains the executor.
- **Conflict pauses the lane.** A predicted or actual conflict gates as a **blocking approval** (ADR-0011's list stays exactly three — this is the existing merge-conflict entry) and pauses the whole auto-merge lane for that repo until resolved or aborted. Runs keep executing; their branches queue. The lane never merges around a conflict — siblings would land on a main the simulation didn't model.
- **Artifact-hygiene offenders are skipped, not lane-pausing.** Per issue 106's per-offender doctrine: a branch refused for install artifacts raises an attention item and waits for surgery; innocent siblings keep merging (each sweep re-previews against the current tip, so skipping an offender is sound where skipping a conflict is not — the offender needs branch repair regardless of what main does).
- **Solo-chaining retires.** The start condition becomes: an issue is startable — in a worktree, like any other — when every dependency is `done` **and integrated** (its branch merged, or it ran solo/lone on main). A dependency that is done-but-unmerged holds its dependents in a visible wait ("waiting on merge of NN"), never a start from stale main, never a worktree cut from a sibling branch. The coordinator's single-solo-slot logic is deleted; "solo" survives only as ADR-0002's lone-Run mode.
- **The Merge button changes job.** Everyday merging is the lane's. The button remains the entry point for the exceptions: resolving/aborting a conflict, merging adopted **stray** branches (no Receipt — MC can't vouch for them, so they never auto-merge), and forcing a sweep.
- **Noise floor unchanged.** A clean auto-merge is silent + a passive note (ADR-0011/0012). Only the conflict gate notifies.

## Considered Options

- **Keep press-time merging** (status quo). Rejected: divergence rot and solo-chain serialization are structural, not incidental; both worsen with drain size.
- **Drain-only lane.** Rejected: a drain that stops with branches pending recreates today's rot exactly where attention is lowest (you walked away — that's the point of the headless lane).
- **Ascending-id auto-merge.** Rejected: id order manufactures "blocked behind NN" waits for branches that finished first; finish order shrinks each branch's divergence window to near zero, and the preview machinery re-stamps against every new tip anyway.
- **Skip around conflicts.** Rejected: merges siblings into a main the sequence simulation never modeled — the exact surprise-conflict class previews exist to kill.
- **Stacked worktrees** (cut a dependent's worktree from its dependency's unmerged branch). Rejected: history-rewrite hazards on branches Receipts reference, and a cleverness tax on every recovery path.

## Consequences

- **Gained:** dependency chains pipeline through worktrees (finish → auto-merge → dependent starts off fresh main); the divergence window collapses; "blocked behind NN" mostly disappears; the coordinator sheds the solo-slot machinery; unattended drains (headless lane) integrate their own work.
- **Given up / accepted:** main is a moving target mid-drain — a long-running worktree Run merges into a main that advanced since its cut. Conflicts arrive *earlier and smaller* instead of later and compounded; the conflict gate and re-stamped previews carry the risk.
- **New coupling, paid once:** startability now reads a git-derived fact (dependency *integrated*), not just issue frontmatter. It is the same finished-unmerged signal afk-scan and the preview coordinator already produce.
- **Downstream:** ADR-0018's "previews never gate the Merge" softens — the lane consults the preview verdict as its go/no-go (the human-facing badges stay advisory); issue 135's exemption becomes dead code to remove when this lands.
