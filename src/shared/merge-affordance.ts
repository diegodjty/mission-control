/**
 * Merge affordance (PURE) — issue 148, ADR-0021 (merge-as-you-go).
 *
 * Everyday merging now belongs to the always-on auto-merge lane (issues
 * 145/146); the Map's Merge affordance changes job to the lane's EXCEPTIONS
 * entry: resolving/aborting a conflict that pauses the lane, merging adopted
 * **stray** branches (no Receipt — the lane never touches them on principle),
 * and forcing a sweep. This module decides what, if anything, the affordance
 * shows — a paused conflict and/or strays are INDEPENDENT facts (unlike the
 * lane's own single per-sweep decision), so both can be true at once and the
 * UI surfaces them separately.
 */
import type { AfkBranchFacts } from './worktree-scan';
import { mergeReadinessOnDisk } from './worktree-scan';
import type { BranchPreview } from './merge-preview';
import type { RunLogRecord } from './ipc-contract';
import { hasReceiptFor } from './receipt-audit';
import { decideAutoMergeLane, laneBranchesFrom, pauseReason, type MainIdle } from './auto-merge-lane';

/** A finished-unmerged branch with no Receipt — the lane never auto-merges it. */
export interface StrayBranch {
  issueId: number;
  slug: string;
}

/** A predicted conflict pausing the lane on this branch (issue 146). */
export interface PausedConflict {
  issueId: number;
  slug: string;
  reason: string;
}

/**
 * The Merge button's exceptions-entry decision: a paused conflict (naming the
 * branch), and/or the stray branches only a human can merge. `null`/`[]` when
 * the lane is healthy and nothing exceptional is pending — the button recedes.
 */
export interface MergeAffordance {
  pausedConflict: PausedConflict | null;
  strays: StrayBranch[];
}

export interface MergeAffordanceInput {
  /** The repo's `afk/` branch facts (the same shape the Map scan reads). */
  branches: AfkBranchFacts[];
  /** Each finished-unmerged branch's preview verdict against the current tip. */
  previews: BranchPreview[];
  /** The Run log — Receipt-backing and finish-order facts derive from it. */
  runLog: RunLogRecord[];
  /** The three main-idle facts the lane's prediction is evaluated against. */
  main: MainIdle;
}

/**
 * Decide the Merge affordance from the same facts the Map already reads. The
 * paused-conflict check asks the pure lane brain what it would do (using the
 * CALLER's `main` facts, so a real mid-merge or a live solo Run correctly
 * suppresses the prediction the same way a sweep would hold); strays are an
 * independent, always-checked fact regardless of lane/main state.
 */
export function decideMergeAffordance(input: MergeAffordanceInput): MergeAffordance {
  const laneBranches = laneBranchesFrom(
    { branches: input.branches, previews: input.previews, midMerge: input.main.midMerge },
    input.runLog,
  );
  const decision = decideAutoMergeLane({ branches: laneBranches, main: input.main });
  const pausedConflict: PausedConflict | null =
    decision.kind === 'pause'
      ? {
          issueId: decision.issueId,
          slug: decision.slug,
          reason: pauseReason(decision.slug, decision.verdict),
        }
      : null;

  const strays: StrayBranch[] = mergeReadinessOnDisk(input.branches)
    .mergeable.filter((c) => !hasReceiptFor(input.runLog, c.issueId))
    .map((c) => ({ issueId: c.issueId, slug: c.slug }));

  return { pausedConflict, strays };
}
