/**
 * Dispatcher auto-merge decision (PURE) — issue 46, ADR-0011 refining ADR-0002.
 *
 * ADR-0002 made the Merge "always human-triggered". ADR-0011 refines that for the
 * **Dispatcher-driven drain** path only: a CLEAN, conflict-free merge of finished
 * parallel work **auto-proceeds** (the Dispatcher runs it and leaves a passive
 * note), while a **conflicting merge or a preflight failure** BLOCKS for a
 * one-click approval (the `merge-conflict` item on issue 45's three-item blocking
 * list) and surfaces the reason (issues 17/23/24). It never auto-resolves a
 * conflict.
 *
 * This module holds the two PURE decisions behind that wiring, kept out of the
 * React effect in `App.tsx` so the auto-vs-gate boundary is unit-testable in
 * isolation:
 *
 *   - `shouldAutoMerge` — the pre-run guard: given the live drain context, may
 *     the Dispatcher auto-invoke a merge right now? (mergeable branches exist,
 *     main isn't mid-merge, nothing is already in flight, and this exact
 *     mergeable set hasn't already been auto-attempted).
 *   - `decideDispatcherMerge` — the post-run classification: given the completed
 *     `MergeRunsResult` the adapter (`run-merge.ts`) returns, was it a clean
 *     auto-proceed (→ a passive `merge` note) or a conflict / preflight failure
 *     (→ a blocking `merge-conflict` gate that surfaces the reason)?
 *
 * The real git work — and the clean/conflict/preflight CLASSIFICATION itself —
 * lives in `run-merge.ts` (via `mergeRuns` + the issue-23/24 output parsing);
 * this module only maps its already-classified result onto the Dispatcher's
 * auto-vs-gate posture. It reuses the same `merge` / `merge-conflict` actions the
 * authority classifier (`dispatcher-authority`) already tiers as passive vs
 * blocking, so the gate builds on that one tested line.
 *
 * PURE: no I/O, no Electron, no LLM — safe to share across main/renderer.
 */
import type { MergeRunsResult } from './ipc-contract';
import type { DispatcherAction } from './dispatcher-authority';

/**
 * The live-drain context the pre-run guard reads. All plain booleans/counts so
 * the "auto-invoke now?" decision stays pure and testable.
 */
export interface AutoMergeContext {
  /** A Dispatcher drain is live (auto-merge is a Dispatcher-path behavior only). */
  dispatcherActive: boolean;
  /** How many finished isolated `afk/` branches are mergeable on disk right now. */
  mergeableCount: number;
  /** `main` is mid-merge from a prior partial conflict — resolve/abort first. */
  midMerge: boolean;
  /** A merge is already in flight (don't fire a second one over it). */
  merging: boolean;
  /**
   * This exact mergeable set was already auto-attempted this drain. Guards
   * against re-firing in a loop when a merge fails preflight without changing the
   * on-disk branch set (a clean merge drops the branches, a conflict sets
   * `midMerge` — both self-guard; a persistent preflight failure would not).
   */
  alreadyAttempted: boolean;
}

/**
 * The pre-run guard: should the Dispatcher auto-invoke a merge now? True exactly
 * when a drain is live, there is at least one mergeable branch, `main` is not
 * mid-merge, no merge is already running, and this mergeable set hasn't already
 * been auto-attempted. PURE.
 */
export function shouldAutoMerge(ctx: AutoMergeContext): boolean {
  return (
    ctx.dispatcherActive &&
    ctx.mergeableCount > 0 &&
    !ctx.midMerge &&
    !ctx.merging &&
    !ctx.alreadyAttempted
  );
}

/**
 * The post-run classification of a completed auto-merge:
 *   - `auto`  — the merge landed cleanly; the Dispatcher proceeded on its own and
 *     records a passive `merge` note (`action`) with a plain-language `note`.
 *   - `gate`  — the merge conflicted or failed preflight; the Dispatcher must
 *     BLOCK for a one-click approval, recording a `merge-conflict` proposal
 *     (`action`) and surfacing the `reason`. Never auto-resolved.
 *   - `noop`  — the run succeeded but merged nothing (e.g. the branches vanished
 *     between the readiness scan and the run): no note, no gate.
 */
export type DispatcherMergeDecision =
  | { kind: 'auto'; action: Extract<DispatcherAction, 'merge'>; note: string }
  | { kind: 'gate'; action: Extract<DispatcherAction, 'merge-conflict'>; reason: string }
  | { kind: 'noop' };

/**
 * Map the adapter's completed `MergeRunsResult` onto the Dispatcher's auto-vs-gate
 * posture (ADR-0011):
 *   - clean (`ok`) with ≥1 slug merged → `auto` (passive `merge` note).
 *   - clean but nothing merged           → `noop` (nothing actually landed).
 *   - not `ok` (a conflict OR a preflight failure) → `gate` (blocking
 *     `merge-conflict`, surfacing the adapter's reason). A conflict is never
 *     auto-resolved — the human resolves or aborts it.
 * The `message` the adapter builds already names the real cause (conflicting
 * files / mid-merge state, or the preflight refusal), so it is the `reason`. PURE.
 */
export function decideDispatcherMerge(result: MergeRunsResult): DispatcherMergeDecision {
  if (result.ok) {
    if (result.merged.length === 0) return { kind: 'noop' };
    return { kind: 'auto', action: 'merge', note: result.message };
  }
  // Not ok ⇒ a conflict or a preflight failure. Both block for approval under
  // ADR-0011's three-item list; neither is auto-resolved.
  return { kind: 'gate', action: 'merge-conflict', reason: result.message };
}
