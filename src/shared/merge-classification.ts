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
 * This module holds the PURE post-run classification behind that wiring, kept
 * out of the React effect in `App.tsx` so the auto-vs-gate boundary is
 * unit-testable in isolation: `decideDispatcherMerge` — given the completed
 * `MergeRunsResult` the adapter (`run-merge.ts`) returns, was it a clean
 * auto-proceed (→ a passive `merge` note) or a conflict / preflight failure
 * (→ a blocking `merge-conflict` gate that surfaces the reason)?
 *
 * (The pre-run "should this auto-fire now?" guard used to live here too, but
 * ADR-0021's always-on lane replaced it — `decideAutoMergeLane`, issues
 * 145/146/148, decides WHEN to merge; this module only classifies the RESULT
 * once something has run, whichever path triggered it.)
 *
 * The real git work — and the clean/conflict/preflight CLASSIFICATION itself —
 * lives in `run-merge.ts` (via `mergeRuns` + the issue-23/24 output parsing);
 * this module only maps its already-classified result onto the Dispatcher's
 * auto-vs-gate posture. It reuses the same `merge` / `merge-conflict` actions the
 * authority classifier (`action-authority`) already tiers as passive vs
 * blocking, so the gate builds on that one tested line.
 *
 * PURE: no I/O, no Electron, no LLM — safe to share across main/renderer.
 */
import type { MergeRunsResult } from './ipc-contract';
import type { DispatcherAction } from './action-authority';

/**
 * The post-run classification of a completed auto-merge:
 *   - `auto`  — the merge landed cleanly; the Dispatcher proceeded on its own and
 *     records a passive `merge` note (`action`) with a plain-language `note`.
 *   - `gate`  — the merge hit a REAL conflict; the Dispatcher must BLOCK for a
 *     one-click approval, recording a `merge-conflict` proposal (`action`) and
 *     surfacing the `reason`. Never auto-resolved.
 *   - `halt`  — the merge failed BEFORE merging anything (a preflight refusal —
 *     uncommitted changes / wrong branch — or a tool error, issue 59). This is
 *     NOT a conflict and NOT approvable: an approval could only retry into the
 *     same failed preflight and fail identically. It surfaces as its own passive
 *     `merge-preflight` note carrying the truthful `reason` (the offending
 *     paths); the retry comes after the tree is cleaned up.
 *   - `noop`  — the run succeeded but merged nothing (e.g. the branches vanished
 *     between the readiness scan and the run): no note, no gate.
 */
export type DispatcherMergeDecision =
  | { kind: 'auto'; action: Extract<DispatcherAction, 'merge'>; note: string }
  | { kind: 'gate'; action: Extract<DispatcherAction, 'merge-conflict'>; reason: string }
  | { kind: 'halt'; action: Extract<DispatcherAction, 'merge-preflight'>; reason: string }
  | { kind: 'noop' };

/**
 * Map the adapter's completed `MergeRunsResult` onto the Dispatcher's posture
 * (ADR-0011, refined by issue 59):
 *   - clean (`ok`) with ≥1 slug merged → `auto` (passive `merge` note).
 *   - clean but nothing merged           → `noop` (nothing actually landed).
 *   - a real conflict (`conflicted`)     → `gate` (blocking `merge-conflict`,
 *     surfacing the adapter's reason). Never auto-resolved — the human resolves
 *     or aborts it. The ADR-0011 blocking list is unchanged.
 *   - any other failure (preflight refusal / tool error) → `halt` (a passive
 *     `merge-preflight` note, issue 59) — the old behavior gated these too, which
 *     presented an approval that could never succeed: approving just re-ran the
 *     merge into the same dirty tree.
 * The `message` the adapter builds already names the real cause (conflicting
 * files / mid-merge state, or the preflight refusal with its offending paths),
 * so it is the `reason`. PURE.
 */
export function decideDispatcherMerge(result: MergeRunsResult): DispatcherMergeDecision {
  if (result.ok) {
    if (result.merged.length === 0) return { kind: 'noop' };
    return { kind: 'auto', action: 'merge', note: result.message };
  }
  if (result.conflicted) {
    return { kind: 'gate', action: 'merge-conflict', reason: result.message };
  }
  return { kind: 'halt', action: 'merge-preflight', reason: result.message };
}
