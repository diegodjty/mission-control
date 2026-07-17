/**
 * Auto-merge lane decision (PURE — the walking skeleton) — issue 145, ADR-0021
 * (merge-as-you-go), PRD "Headless drain lane + merge-as-you-go" stories 13 & 19.
 *
 * ADR-0021 replaces press-time merging with an **always-on, per-repo auto-merge
 * lane**: on every Run-finish (and every merge completion) Mission Control sweeps
 * a repo's finished-unmerged, **Receipt-backed** `afk/` branches in finish order
 * and merges the next one that the preview stamps clean against the CURRENT main
 * tip — provided main is idle. A clean auto-merge is silent + a passive note
 * (ADR-0011/0012 noise floor); it never blocks and never becomes a chat message.
 *
 * This module is the lane's pure BRAIN. Given the finished-unmerged candidates
 * (each annotated with whether a Receipt backs it, its Receipt `finished`
 * timestamp, and its merge-preview verdict) plus the three main-idle facts, it
 * decides ONE thing: merge the next clean branch, or hold (and why). The
 * `afk-merge.sh` executor and the per-repo serializer live in the main-process
 * `auto-merge-lane-executor`; this decision is PURE (no git, no fs, no Electron)
 * so the whole merge-or-hold matrix is unit-testable in isolation (see the PRD
 * "Testing Decisions").
 *
 * Scope of THIS slice (issue 145): the walking skeleton merges at most one branch
 * per sweep and treats every non-`clean` verdict as a hold. **Ordering across
 * many branches, the lane-pause flag a conflict raises, and the per-offender
 * artifact skip are issue 146** — this module already sorts candidates in finish
 * order so 146 extends it without reshaping the decision, but it deliberately does
 * not yet model pause or skip.
 */
import type { MergePreviewVerdict } from './merge-preview';

/**
 * One finished-unmerged `afk/` branch the lane is considering, annotated with the
 * three facts the decision needs beyond its identity.
 */
export interface LaneBranch {
  issueId: number;
  /** The `NN-slug` stem, matching the `afk/NN-slug` branch. */
  slug: string;
  /**
   * A Receipt backs this finished branch — MC can vouch for it (ADR-0021). A
   * **stray** branch (finished-unmerged but no Receipt) is `false` and NEVER
   * auto-merges; the human adopts it through the Merge button instead.
   */
  receiptBacked: boolean;
  /**
   * The Receipt's declared `finished` timestamp (ISO-8601) — the lane's finish
   * order (first finished, first merged). `null` when unknown (defensive); such a
   * branch sorts last so a branch with a real timestamp is always preferred.
   */
  finished: string | null;
  /**
   * The branch's merge-preview verdict against the CURRENT main tip (ADR-0018),
   * or `null` when no verdict is available yet. Only a `clean` verdict authorizes
   * an auto-merge; every other verdict (conflicts, blocked, artifact, the
   * transient recalculating/suspended, or null) holds this slice.
   */
  verdict: MergePreviewVerdict | null;
}

/**
 * The main-idle facts (ADR-0021): the lane may merge only onto an idle main —
 * a clean working tree, not mid-merge, and with no live solo Run mutating it.
 */
export interface MainIdle {
  /** The main working tree is clean (no uncommitted/untracked changes). */
  cleanTree: boolean;
  /** main is mid-merge — a prior partial conflict left MERGE_HEAD set (issue 24). */
  midMerge: boolean;
  /**
   * A **solo** Run (one working directly on main, not isolated in a worktree) is
   * live right now. Merging under it would collide with the tree it is editing,
   * so the lane holds until it ends (ADR-0002's lone-Run mode survives ADR-0021).
   */
  liveSoloRun: boolean;
}

/**
 * Why the lane held instead of merging. `no-clean-branch` covers all "nothing to
 * merge" reasons at once (no finished-unmerged branch, none Receipt-backed, or
 * none with a clean verdict) — the lane simply had no clean branch to take this
 * sweep; the three main-* reasons name a non-idle main.
 */
export type LaneHoldReason = 'mid-merge' | 'main-dirty' | 'live-solo-run' | 'no-clean-branch';

/** The lane's decision for one sweep: merge the next clean branch, or hold. */
export type AutoMergeLaneDecision =
  | { kind: 'merge'; issueId: number; slug: string }
  | { kind: 'hold'; reason: LaneHoldReason };

export interface AutoMergeLaneInput {
  /** The finished-unmerged candidates (any order — the lane sorts by finish time). */
  branches: LaneBranch[];
  /** The three main-idle facts. */
  main: MainIdle;
}

/**
 * The main-idle gate: which idle fact (if any) blocks the lane, or `null` when
 * main is idle. Checked most-specific first — a mid-merge (which also leaves the
 * tree dirty) reports `mid-merge`, not `main-dirty` — so the hold reason names the
 * real cause. Exported so the executor and 146's lane can reuse the exact gate.
 */
export function mainIdleHold(main: MainIdle): Exclude<LaneHoldReason, 'no-clean-branch'> | null {
  if (main.midMerge) return 'mid-merge';
  if (!main.cleanTree) return 'main-dirty';
  if (main.liveSoloRun) return 'live-solo-run';
  return null;
}

/**
 * The auto-mergeable candidates — Receipt-backed AND stamped `clean` — in finish
 * order (earliest Receipt `finished` first; a null timestamp sorts last; ties
 * broken by ascending issue id for determinism). Strays and non-`clean` verdicts
 * are filtered out. Exported so 146 can build its multi-branch ordering on the
 * same finish-order list this slice already produces. Pure; input untouched.
 */
export function mergeableInFinishOrder(branches: LaneBranch[]): LaneBranch[] {
  return branches
    .filter((b) => b.receiptBacked && b.verdict !== null && b.verdict.kind === 'clean')
    .slice()
    .sort((a, b) => {
      if (a.finished !== b.finished) {
        if (a.finished === null) return 1;
        if (b.finished === null) return -1;
        return a.finished < b.finished ? -1 : 1;
      }
      return a.issueId - b.issueId;
    });
}

/**
 * Decide one sweep of the auto-merge lane (issue 145). Deterministic and
 * idempotent — safe to recompute on every Run-finish / merge-completion event.
 *
 *  - main not idle (mid-merge / dirty / a live solo Run) → **hold**, naming the
 *    blocking fact — the lane never merges onto a moving or conflicted main.
 *  - main idle, at least one Receipt-backed branch stamped `clean` → **merge**
 *    the earliest-finished one (this slice takes exactly one per sweep; the next
 *    sweep, fired on the merge completion, takes the following one — issue 146).
 *  - main idle but nothing clean and Receipt-backed → **hold** (`no-clean-branch`).
 */
export function decideAutoMergeLane(input: AutoMergeLaneInput): AutoMergeLaneDecision {
  const idleHold = mainIdleHold(input.main);
  if (idleHold !== null) return { kind: 'hold', reason: idleHold };

  const next = mergeableInFinishOrder(input.branches)[0];
  if (next === undefined) return { kind: 'hold', reason: 'no-clean-branch' };
  return { kind: 'merge', issueId: next.issueId, slug: next.slug };
}
