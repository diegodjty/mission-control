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
 * Scope (issues 145 → 146). Issue 145's walking skeleton merged at most one clean
 * branch per sweep and treated every non-`clean` verdict as a hold. **Issue 146
 * completes the lane doctrine** on top of that seed: the decision now WALKS the
 * receipt-backed candidates in finish order and distinguishes the non-clean cases
 * the skeleton lumped together —
 *   - a predicted **conflict** (`conflicts`/`blocked`) → `pause`: the lane raises
 *     a blocking approval on that branch and merges NOTHING past it in finish
 *     order (later clean branches queue). Runs keep executing — the pause is a
 *     merge-lane fact, not a Run fact — and it clears itself the moment the
 *     conflicting branch leaves the candidate set (resolved or aborted), so
 *     "resume" needs no stored flag: the next sweep simply re-derives.
 *   - an artifact-hygiene **offender** (`artifact`, issue 98/106) → skipped
 *     PER-OFFENDER while the walk continues, so an innocent clean sibling later in
 *     finish order still merges. The skipped offenders ride the decision so the
 *     executor can raise their per-branch attention items.
 *   - a **stray** (no Receipt) is filtered out of the walk entirely — never
 *     auto-merged, never a blocker (ADR-0021: the human adopts it by hand).
 * Still one merge per sweep (the next sweep, fired on the merge completion, takes
 * the following branch); still PURE (no git/fs/Electron) so the whole
 * merge / pause / skip / hold matrix is unit-testable in isolation.
 */
import type { BranchPreview, MergePreviewVerdict, SettledVerdict } from './merge-preview';
import type { AfkBranchFacts } from './worktree-scan';
import { mergeReadinessOnDisk } from './worktree-scan';
import type { RunLogRecord } from './ipc-contract';
import { hasReceiptFor } from './receipt-audit';

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

/**
 * An artifact-hygiene offender the lane skipped this sweep (issue 106/146): a
 * finished, Receipt-backed branch whose merge-preview stamped it `artifact`
 * (it would add ignored install artifacts to the default branch — issue 98). The
 * lane skips it per-offender and keeps merging innocent siblings; the executor
 * turns each skip into that branch's attention item. `paths` are the offending
 * artifact paths the badge names.
 */
export interface LaneSkip {
  issueId: number;
  slug: string;
  paths: string[];
}

/**
 * The lane's decision for one sweep (issue 146):
 *   - `merge` — merge THIS clean branch (the earliest-finished one still
 *     mergeable), carrying any artifact offenders `skipped` on the way to it.
 *   - `pause` — a predicted conflict on `issueId`/`slug` (its `verdict` is
 *     `conflicts` or `blocked`) stops the lane: raise a blocking approval, merge
 *     nothing past it. `skipped` carries offenders passed before the pause point.
 *   - `hold`  — nothing to do this sweep: main isn't idle (`reason` names the
 *     fact), or no branch is currently mergeable (`no-clean-branch`). `skipped`
 *     still reports any offenders seen (they are order-independent facts).
 */
export type AutoMergeLaneDecision =
  | { kind: 'merge'; issueId: number; slug: string; skipped: LaneSkip[] }
  | { kind: 'pause'; issueId: number; slug: string; verdict: SettledVerdict; skipped: LaneSkip[] }
  | { kind: 'hold'; reason: LaneHoldReason; skipped: LaneSkip[] };

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
 * Finish-order comparator (ADR-0021, "first finished, first merged"): earliest
 * Receipt `finished` first; a null timestamp sorts last so a branch with a real
 * timestamp is always preferred; ties broken by ascending issue id for
 * determinism. The one ordering the whole lane merges by.
 */
function byFinishOrder(a: LaneBranch, b: LaneBranch): number {
  if (a.finished !== b.finished) {
    if (a.finished === null) return 1;
    if (b.finished === null) return -1;
    return a.finished < b.finished ? -1 : 1;
  }
  return a.issueId - b.issueId;
}

/**
 * The Receipt-backed candidates in finish order — strays (no Receipt) filtered
 * out, EVERY verdict kept (clean, conflict, artifact, transient). This is the
 * list the 146 walk marches down deciding merge / skip / pause per branch. Pure;
 * input untouched.
 */
export function receiptBackedInFinishOrder(branches: LaneBranch[]): LaneBranch[] {
  return branches.filter((b) => b.receiptBacked).slice().sort(byFinishOrder);
}

/**
 * The auto-mergeable candidates — Receipt-backed AND stamped `clean` — in finish
 * order. Strays and non-`clean` verdicts are filtered out. Retained from issue
 * 145 (and still the seed the walk builds on); pure, input untouched.
 */
export function mergeableInFinishOrder(branches: LaneBranch[]): LaneBranch[] {
  return receiptBackedInFinishOrder(branches).filter(
    (b) => b.verdict !== null && b.verdict.kind === 'clean',
  );
}

/**
 * Decide one sweep of the full auto-merge lane (issue 146). Deterministic and
 * idempotent — safe to recompute on every Run-finish / merge-completion event, and
 * "resume after resolve/abort" needs no stored state: once the conflicting branch
 * leaves the candidate set the next sweep re-derives a `merge`.
 *
 *  1. main not idle (mid-merge / dirty / a live solo Run) → **hold**, naming the
 *     blocking fact — the lane never merges onto a moving or conflicted main. (An
 *     ACTUAL conflict left by a prior sweep sets `midMerge`, so it pauses the lane
 *     here; a PREDICTED conflict pauses at step 2 below, before any git touch.)
 *  2. main idle → WALK the Receipt-backed candidates in finish order:
 *       - `clean`               → **merge** it (one per sweep), reporting offenders
 *                                  skipped on the way.
 *       - `artifact`            → **skip** this offender, keep walking (issue 106).
 *       - `conflicts`/`blocked` → **pause** the lane on this branch (blocking
 *                                  approval); merge nothing past it — later clean
 *                                  branches queue until it's resolved or aborted.
 *       - transient (`recalculating`/`suspended`) or no verdict → **hold** without
 *         merging past it, preserving finish order until the preview settles.
 *     Walk falls off the end with nothing mergeable → **hold** (`no-clean-branch`),
 *     still reporting any offenders skipped.
 */
export function decideAutoMergeLane(input: AutoMergeLaneInput): AutoMergeLaneDecision {
  const idleHold = mainIdleHold(input.main);
  if (idleHold !== null) return { kind: 'hold', reason: idleHold, skipped: [] };

  const skipped: LaneSkip[] = [];
  for (const b of receiptBackedInFinishOrder(input.branches)) {
    const verdict = b.verdict;
    if (verdict === null) return { kind: 'hold', reason: 'no-clean-branch', skipped };
    switch (verdict.kind) {
      case 'clean':
        return { kind: 'merge', issueId: b.issueId, slug: b.slug, skipped };
      case 'artifact':
        skipped.push({ issueId: b.issueId, slug: b.slug, paths: verdict.paths });
        continue;
      case 'conflicts':
      case 'blocked':
        return { kind: 'pause', issueId: b.issueId, slug: b.slug, verdict, skipped };
      // A transient verdict (a moved tip / mid-merge suspension) leaves this
      // branch's true outcome unknown; hold rather than merge a LATER branch
      // ahead of it and break finish order — the next settled sweep re-decides.
      default:
        return { kind: 'hold', reason: 'no-clean-branch', skipped };
    }
  }
  return { kind: 'hold', reason: 'no-clean-branch', skipped };
}

/**
 * One repo's scanned facts a sweep (or the renderer's exceptions-entry Merge
 * affordance, issue 148) reads: the `afk/` branch facts, each finished-unmerged
 * branch's preview verdict, and whether this repo is left mid-merge.
 */
export interface AutoMergeLaneScan {
  branches: AfkBranchFacts[];
  previews: BranchPreview[];
  midMerge: boolean;
}

/**
 * The Receipt `finished` timestamp embedded in a Run-log record's id
 * (`receipt:<NN-slug>:<finished>`, ADR-0013). The slug carries no colon and
 * `finished` is ISO-8601 (which does), so everything past the second colon is the
 * timestamp. Null for a non-Receipt (legacy scroll-era) record or a malformed id.
 */
function finishedFromReceiptId(id: string): string | null {
  const prefix = 'receipt:';
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const slugEnd = rest.indexOf(':');
  if (slugEnd === -1) return null;
  const finished = rest.slice(slugEnd + 1);
  return finished.length > 0 ? finished : null;
}

/** The latest Receipt's `finished` timestamp per issue id (newest `capturedAt` wins). */
function latestFinishedByIssue(runLog: readonly RunLogRecord[]): Map<number, string> {
  const latestCapturedAt = new Map<number, string>();
  const finished = new Map<number, string>();
  for (const rec of runLog) {
    if (rec.issueId === null || !rec.id.startsWith('receipt:')) continue;
    const prior = latestCapturedAt.get(rec.issueId);
    if (prior !== undefined && rec.capturedAt <= prior) continue;
    const stamp = finishedFromReceiptId(rec.id);
    if (stamp === null) continue;
    latestCapturedAt.set(rec.issueId, rec.capturedAt);
    finished.set(rec.issueId, stamp);
  }
  return finished;
}

/**
 * Assemble the pure lane's candidate list from a scan + previews + the Run log:
 * every finished-unmerged branch (`mergeReadinessOnDisk`), annotated with whether
 * a Receipt backs it, its Receipt `finished` timestamp, and its preview verdict.
 * Exported so the main-process executor and the renderer's Merge-affordance
 * decision (issue 148) share the exact same assembly.
 */
export function laneBranchesFrom(
  scan: AutoMergeLaneScan,
  runLog: readonly RunLogRecord[],
): LaneBranch[] {
  const verdictByIssue = new Map(scan.previews.map((p) => [p.issueId, p.verdict]));
  const finishedByIssue = latestFinishedByIssue(runLog);
  return mergeReadinessOnDisk(scan.branches).mergeable.map((c) => ({
    issueId: c.issueId,
    slug: c.slug,
    receiptBacked: hasReceiptFor(runLog, c.issueId),
    finished: finishedByIssue.get(c.issueId) ?? null,
    verdict: verdictByIssue.get(c.issueId) ?? null,
  }));
}

/**
 * The plain-language cause a paused lane surfaces on its blocking `merge-conflict`
 * approval — the conflicting files for a `conflicts` branch, or the earlier branch
 * a `blocked` one is stuck behind. Mirrors the wording the merge-preview badge uses.
 */
export function pauseReason(slug: string, verdict: SettledVerdict): string {
  if (verdict.kind === 'blocked') {
    return `Auto-merge lane paused: ${slug} is blocked behind issue ${verdict.behindIssueId}'s predicted conflict — resolve or abort it to resume the lane.`;
  }
  const files = verdict.kind === 'conflicts' && verdict.files.length > 0 ? ` in ${verdict.files.join(', ')}` : '';
  return `Auto-merge lane paused: ${slug} is predicted to conflict${files} — resolve or abort it to resume the lane.`;
}
