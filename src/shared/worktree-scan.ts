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
   * True when the branch's tip is already an ancestor of `main` — its work is
   * integrated, so it is neither in flight nor awaiting merge. (A clean Merge
   * deletes the branch, so this mainly guards a leftover already-merged branch.)
   */
  mergedIntoMain: boolean;
}

/** The Map-facing state of an isolated Run derived from its on-disk `afk/` branch. */
export type WorktreeRunKind = 'running' | 'finished-unmerged';

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
 * Whether an `afk/` branch represents a live, in-flight Run: it has a worktree
 * and hasn't committed a `done` yet (the agent is still working, or stopped
 * before finishing). `mergedIntoMain` is deliberately NOT consulted here — a
 * freshly-created worktree branch has no new commits, so its tip trivially IS an
 * ancestor of `main`, which must not be mistaken for "already integrated"; that
 * flag only distinguishes a committed-`done` branch's merge state.
 */
function isRunning(f: AfkBranchFacts): boolean {
  return f.hasWorktree && f.committedStatus !== 'done';
}

/**
 * Derive the per-issue Map indicator from the on-disk `afk/` branch facts:
 * `running` while a Run is live in its worktree, `finished-unmerged` once its
 * branch carries a committed `done` that isn't merged. Branches whose work is
 * already on `main` contribute nothing (the Map row shows plain on-disk status).
 * Sorted ascending by issue id for a stable render order.
 */
export function deriveWorktreeRunStates(facts: AfkBranchFacts[]): WorktreeRunState[] {
  const states: WorktreeRunState[] = [];
  for (const f of facts) {
    if (isFinishedUnmerged(f)) {
      states.push({ issueId: f.issueId, slug: f.slug, kind: 'finished-unmerged' });
    } else if (isRunning(f)) {
      states.push({ issueId: f.issueId, slug: f.slug, kind: 'running' });
    }
  }
  return states.sort((a, b) => a.issueId - b.issueId);
}

/**
 * Decide, purely from the on-disk `afk/` state, whether a Merge should be
 * offered and which branches it would integrate — the same shape and rule as the
 * in-memory `mergeReadiness` (merge-plan), but sourced from disk so the Merge
 * affordance survives closing every Pane (issue 16). A Merge is offered once at
 * least one branch is finished-unmerged AND no isolated Run is still in flight
 * (the batch is done). Deterministic and idempotent — safe to recompute on every
 * scan.
 */
export function mergeReadinessOnDisk(facts: AfkBranchFacts[]): MergePlan {
  const mergeable: MergeCandidate[] = facts
    .filter(isFinishedUnmerged)
    .sort((a, b) => a.issueId - b.issueId)
    .map((f) => ({ issueId: f.issueId, slug: f.slug }));

  const pendingRunning = facts
    .filter(isRunning)
    .map((f) => f.issueId)
    .sort((a, b) => a - b);

  const ready = mergeable.length >= 1 && pendingRunning.length === 0;

  return { ready, mergeable, pendingRunning };
}
