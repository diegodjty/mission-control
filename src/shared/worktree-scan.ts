/**
 * Worktree scan — the pure derivation of a Project's in-flight and
 * finished-but-unmerged isolated Runs from an ON-DISK snapshot of its `afk/`
 * branches/worktrees (issue 16).
 *
 * The batch-QA walkthrough (issue 10) found two visibility gaps: the Map showed
 * issues being worked in worktrees as plain `open` (their progress lives on the
 * `afk/NN-slug` branch, not the main checkout the Map watches), and closing the
 * Panes dropped the in-memory Runs — so the Merge button vanished and the
 * finished-unmerged branches were orphaned. Building on issue 15 (a finished
 * isolated Run's work is COMMITTED on its `afk/` branch), the ground truth for
 * "which issues are in flight / awaiting merge" is the on-disk `afk/` state, not
 * the renderer's in-memory Run set — which is exactly what makes it survive
 * closing every Pane.
 *
 * The git commands that read that state live in the Git/Worktree Adapter (main
 * process); THIS module is PURE (no git, no fs, no Electron) so the "given these
 * branch facts, what does each Map row show and what is mergeable?" decision is
 * unit-testable in isolation (see PRD "Testing Decisions"). The adapter's scan
 * is separately exercised against a scratch repo with real `afk/` worktrees.
 */
import type { IssueStatus } from './backlog-model';
import type { MergeCandidate, MergePlan } from './merge-plan';

/**
 * The on-disk facts about one `afk/NN-slug` branch (and its optional worktree)
 * for the Project, as read by the Git/Worktree Adapter.
 */
export interface AfkBranchFacts {
  /** The issue id parsed from the `NN-slug` stem. */
  issueId: number;
  /** The full `NN-slug` stem, matching the `afk/NN-slug` branch + worktree key. */
  slug: string;
  /** True when a worktree is currently registered on this branch (Run in flight). */
  hasWorktree: boolean;
  /**
   * The issue's status as committed on the `afk/<slug>` branch tip, or null when
   * the branch/file isn't readable. `done` means the Run finished and committed
   * (issue 15) — i.e. the branch is mergeable.
   */
  committedStatus: IssueStatus | null;
  /**
   * The issue's status as seen in the worktree's WORKING TREE — where the agent's
   * `done` flip lands BEFORE Mission Control auto-commits it (issue 15) — or null
   * when there is no worktree / the file isn't readable. This is what tells a
   * commit-FAILURE (the agent finished, `worktreeStatus === 'done'`, yet the
   * `done` never reached `committedStatus`) apart from a Run still in progress
   * (issue 22, corr-5): without it a finished-but-uncommitted Run is
   * indistinguishable from a live one and reads `running` forever.
   */
  worktreeStatus: IssueStatus | null;
  /**
   * True when the branch's tip is already an ancestor of `main` — its work is
   * integrated, so it is neither in flight nor awaiting merge. (A clean Merge
   * deletes the branch, so this mainly guards a leftover already-merged branch.)
   */
  mergedIntoMain: boolean;
}

/**
 * The Map-facing state of an isolated Run derived from its on-disk `afk/` branch:
 *   - `running`          — a worktree with a Run session still LIVE driving it.
 *   - `stranded`         — a worktree whose Run has ENDED (blocked/stopped/exited)
 *                          without a `done` commit; it must be discarded or kept,
 *                          but must NOT read `running` forever nor block Merge
 *                          (issue 22, corr-1 / state-M3).
 *   - `commit-failed`    — the agent finished (`done` in the worktree) but the
 *                          auto-commit never landed on the branch (issue 22,
 *                          corr-5); distinct from perpetual `running`.
 *   - `finished-unmerged`— a committed `done` branch not yet merged (mergeable).
 */
export type WorktreeRunKind = 'running' | 'stranded' | 'commit-failed' | 'finished-unmerged';

export interface WorktreeRunState {
  issueId: number;
  slug: string;
  kind: WorktreeRunKind;
}

/** The issue id encoded in a `NN-slug` stem (`04-tracer-bullet` ⇒ 4). */
export function issueIdFromSlug(slug: string): number {
  const match = /^(\d+)/.exec(slug);
  return match ? Number(match[1]) : NaN;
}

/**
 * Whether an `afk/` branch's committed work is finished and not yet merged — the
 * mergeable, "awaiting merge" state. Requires a `done` commit on the branch
 * (issue 15) that isn't already on `main`.
 */
function isFinishedUnmerged(f: AfkBranchFacts): boolean {
  return f.committedStatus === 'done' && !f.mergedIntoMain;
}

/**
 * Whether the agent FINISHED in the worktree (`worktreeStatus === 'done'`) but
 * that `done` never reached the branch tip — i.e. the auto-commit failed or is
 * still pending (issue 22, corr-5). Distinct from a Run in progress: the work is
 * done, only the commit is missing, so it is neither mergeable nor "running".
 */
function isCommitFailed(f: AfkBranchFacts): boolean {
  return f.hasWorktree && f.worktreeStatus === 'done' && f.committedStatus !== 'done';
}

/**
 * Classify one `afk/` branch's Map-facing state from its on-disk facts plus the
 * set of issue ids whose Run session is currently LIVE in Mission Control.
 *
 * Liveness is the fact the disk alone cannot supply and the reason a
 * blocked/stopped Run used to read `running` forever (issue 22, corr-1): a
 * worktree with no `done` commit is `running` ONLY while a live session drives
 * it; once that session has ended it is `stranded` — recoverable, and no longer
 * blocking the batch Merge. `mergedIntoMain` is consulted only for a
 * committed-`done` branch (a fresh worktree branch is trivially an ancestor of
 * `main`, which must not read as "already integrated"). Returns null for a
 * branch that contributes no Map indicator (already merged, or a bare branch
 * with no worktree and nothing committed-done).
 */
export function classifyBranch(
  f: AfkBranchFacts,
  liveRunIssueIds: readonly number[] = [],
): WorktreeRunKind | null {
  if (isFinishedUnmerged(f)) return 'finished-unmerged';
  if (f.committedStatus === 'done') return null; // committed done AND merged → integrated
  if (isCommitFailed(f)) return 'commit-failed';
  if (!f.hasWorktree) return null; // bare branch, nothing to show
  return liveRunIssueIds.includes(f.issueId) ? 'running' : 'stranded';
}

/**
 * Derive the per-issue Map indicator from the on-disk `afk/` branch facts and
 * the live-Run set: `running` while a session is live in its worktree,
 * `stranded` once that session has ended without a `done` commit, `commit-failed`
 * when a finished worktree never committed, and `finished-unmerged` once its
 * branch carries a committed `done` that isn't merged. Branches whose work is
 * already on `main` contribute nothing. Sorted ascending by issue id for a
 * stable render order.
 */
export function deriveWorktreeRunStates(
  facts: AfkBranchFacts[],
  liveRunIssueIds: readonly number[] = [],
): WorktreeRunState[] {
  const states: WorktreeRunState[] = [];
  for (const f of facts) {
    const kind = classifyBranch(f, liveRunIssueIds);
    if (kind !== null) states.push({ issueId: f.issueId, slug: f.slug, kind });
  }
  return states.sort((a, b) => a.issueId - b.issueId);
}

/**
 * Decide, purely from the on-disk `afk/` state, whether a Merge should be
 * offered and which branches it would integrate — the same shape and rule as the
 * in-memory `mergeReadiness` (merge-plan), but sourced from disk so the Merge
 * affordance survives closing every Pane (issue 16). A Merge is offered once at
 * least one branch is finished-unmerged AND no isolated Run is still LIVE (the
 * batch is done).
 *
 * Crucially (issue 22, corr-1 / state-M3), only genuinely-`running` branches
 * gate the Merge: a `stranded` (blocked/stopped) or `commit-failed` branch does
 * NOT count as "pending running", so it can no longer suppress Merge for its
 * finished siblings indefinitely. Its work simply isn't in the mergeable set —
 * the user discards or resolves it separately. Deterministic and idempotent.
 */
export function mergeReadinessOnDisk(
  facts: AfkBranchFacts[],
  liveRunIssueIds: readonly number[] = [],
): MergePlan {
  const mergeable: MergeCandidate[] = facts
    .filter(isFinishedUnmerged)
    .sort((a, b) => a.issueId - b.issueId)
    .map((f) => ({ issueId: f.issueId, slug: f.slug }));

  const pendingRunning = facts
    .filter((f) => classifyBranch(f, liveRunIssueIds) === 'running')
    .map((f) => f.issueId)
    .sort((a, b) => a - b);

  const ready = mergeable.length >= 1 && pendingRunning.length === 0;

  return { ready, mergeable, pendingRunning };
}

/**
 * Whether Mission Control should auto-commit this `afk/` branch's finished
 * worktree onto its branch (issue 30). True exactly when the agent has FINISHED
 * in the worktree (`worktreeStatus === 'done'`) but that `done` has not yet
 * reached the committed branch tip — the once-only, event-driven commit trigger
 * that replaces committing on every status-read tick. It is the same on-disk
 * shape `classifyBranch` reports as `commit-failed`; the caller fires the commit
 * ONCE per Run (guarded by an id set) rather than re-committing each poll, so a
 * genuinely failed commit is surfaced instead of retried into churn. Pure so the
 * "commit now?" decision is unit-testable; the git side effect lives in the
 * Git/Worktree Adapter's `commitFinishedWorktree`.
 */
export function needsWorktreeCommit(f: AfkBranchFacts): boolean {
  return f.hasWorktree && f.worktreeStatus === 'done' && f.committedStatus !== 'done';
}

/** Value-equality of one `afk/` branch's scanned facts (issue 30). */
function branchFactsEqual(a: AfkBranchFacts, b: AfkBranchFacts): boolean {
  return (
    a.issueId === b.issueId &&
    a.slug === b.slug &&
    a.hasWorktree === b.hasWorktree &&
    a.committedStatus === b.committedStatus &&
    a.worktreeStatus === b.worktreeStatus &&
    a.mergedIntoMain === b.mergedIntoMain
  );
}

/**
 * Whether two on-disk `afk/` scans carry the SAME facts (issue 30). The scan
 * poll reads git every ~1.5s, but most ticks observe no change; storing a fresh
 * array each tick would give every downstream memo/effect a new identity and
 * re-run the drain re-plan (and its `applyIsolation`) needlessly. Guarding the
 * scan setState on this value-equality keeps the scan's identity — and therefore
 * every derived Run status, Map indicator, and the drain plan — STABLE across
 * no-change ticks, which is what removes the per-tick churn and the running↔
 * finished flicker. Order-sensitive because `scanAfkBranches` sorts by issue id,
 * so equal scans always list branches in the same order. Pure.
 */
export function afkScanUnchanged(
  prev: AfkBranchFacts[],
  next: AfkBranchFacts[],
): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!branchFactsEqual(prev[i], next[i])) return false;
  }
  return true;
}

/**
 * Optimistically mark a branch's committed status as `done` for the given slug
 * (issue 30) — applied the instant Mission Control's event-driven auto-commit
 * succeeds, mirroring `dropMergedBranches`' optimistic prefix (issue 29). Without
 * it, the branch reads `commit-failed` (worktree done, tip not) for the whole
 * ~1.5s until the next scan confirms the commit — a transient wrong state. The
 * next real scan observes the same committed `done`, so this is a safe optimistic
 * prefix of it. Pure; input untouched (a slug not present is a no-op).
 */
export function markBranchCommitted(
  facts: AfkBranchFacts[],
  slug: string,
): AfkBranchFacts[] {
  let changed = false;
  const next = facts.map((f) => {
    if (f.slug === slug && f.committedStatus !== 'done') {
      changed = true;
      return { ...f, committedStatus: 'done' as IssueStatus };
    }
    return f;
  });
  return changed ? next : facts;
}

/**
 * Drop the just-merged `afk/` branches (by slug) from a scan's on-disk facts —
 * an optimistic clear applied the instant a Merge succeeds (issue 29).
 *
 * The double-merge race: after a successful merge the branches/worktrees are
 * gone from disk, but the LAST poll's facts still list them until the next
 * ~1.5s scan tick. Meanwhile the Merge button re-enables (its `merging` guard
 * resets on completion), so within that window `mergeReadinessOnDisk` still
 * reports `ready` with a stale `mergeable` set — a second click would call the
 * merge on branches that no longer exist and surface an error contradicting the
 * success just shown. Removing the merged slugs from the scan synchronously with
 * the success makes readiness recompute to not-ready immediately, without
 * waiting for the poll. The next real scan then confirms the same truth, so this
 * is a safe optimistic prefix of it. Pure; input untouched.
 */
export function dropMergedBranches(
  facts: AfkBranchFacts[],
  mergedSlugs: readonly string[],
): AfkBranchFacts[] {
  if (mergedSlugs.length === 0) return facts;
  const merged = new Set(mergedSlugs);
  return facts.filter((f) => !merged.has(f.slug));
}
