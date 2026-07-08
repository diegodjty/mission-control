# Merge previews are sequence-simulated, advisory, and in-memory

**Status:** accepted — extends ADR-0002 (Mission Control owns the merge lifecycle); changes no Merge/Abort behavior.

Conflicts are discovered only after pressing **Merge**, and a partial conflict leaves main
mid-merge (`afk-merge.sh` integrates sequentially and stops at the first conflict). We add a
background **Merge preview** per finished-unmerged `afk/` branch so pressing Merge is never a
surprise. The preview **simulates the full merge sequence in current merge order** (ascending
issue id, the order `mergeReadiness` fixes): `git merge-tree --write-tree` for the first branch,
then chained via dangling `commit-tree` commits for each subsequent one, stopping at the first
predicted conflict — later branches read "blocked behind NN", because that is what the script
actually does. Pairwise-against-main was rejected: it can badge branch 2-of-N "clean" and still
conflict at press time, a false no-surprise in exactly the multi-branch drain case that motivates
the feature.

Decisions that a future reader would otherwise re-litigate:

- **"Read-only" means no refs, no worktrees, no index.** Both `merge-tree --write-tree` and the
  `commit-tree` chaining write *unreachable* objects into the odb (gc-pruned later); that is
  accepted by design. A scratch-merge fallback (temp worktree + real `git merge`) was rejected:
  index locks, cleanup paths, and serializer contention for no accuracy gain.
- **The badge predicts the outcome of pressing Merge, restricted to per-branch stable facts.**
  The issue-98 artifact-hygiene refusal is folded in (per offender only — innocent siblings keep
  their real merge verdicts; the batch-level refusal stays a press-time message). Deliberately NOT
  modeled: CHOKEPOINT union auto-resolution (the badge is conservative on legacy hand-written
  confs; MC-generated confs define no chokepoints) and transient repo states (dirty main,
  wrong branch — point-in-time facts, not branch properties).
- **Freshness rides the existing ~1.5 s AfkScan poll, no `.git` watcher.** Every verdict is
  stamped with the (default-branch tip, ordered finished-branch tips) it was computed against; a
  stamp mismatch flips affected badges to `recalculating` — never a stale verdict — and queues one
  coalesced recompute per repo through the per-repo serializer (never per-branch, never two
  pending). A refs watcher was rejected: packed-refs edge cases for an imperceptible latency win,
  given badges are advisory and the Merge preflight re-checks everything at press time.
- **A mid-merge repo suspends its previews** ("merge in progress"): any verdict there would
  predict a press that cannot happen. Recompute resumes via the stamp once main is clean.
- **Verdicts live in main-process memory and travel with the scan result.** No disk artifact and
  no Workbench writes: previews are derived, recomputable state, and recompute-on-every-main-move
  would churn the Workbench auto-commit history. If the Dispatcher later wants earlier warnings,
  it gets them through its event stream, not by reading disk.
- **git ≥ 2.38 is required** (`merge-tree --write-tree`); older git degrades to no badges plus one
  passive note. No fallback merge machinery.

Explicit no-s for v1, each a separate future feature: previews for in-flight (wip) Runs (branch
tips churn per Worker commit; no steering affordance exists), auto-rebase of remaining finished
branches after each merge (history rewrite on branches Receipts reference — needs its own grill),
and conflict-aware merge reordering (the sequence simulation already yields the data). Dispatcher
authority is unchanged: clean auto-proceeds, conflict blocks (ADR-0011).
