/**
 * Dispatcher authority classifier (PURE) — the ADR-0007 line, minimal slice.
 *
 * The Dispatcher acts on its own for **safe, reversible mechanics** and asks for
 * one-click human approval on **scope-changing** judgment calls. This module is
 * the encoding of that division: a proposed action → `auto | needs-approval`.
 *
 * This is the FULL ADR-0007 line (issue 36): the auto side (commit a checkpoint,
 * start the next Run within the cap, synthesize/relay) AND the scope-changing
 * side (log a new issue, Merge, abort a drain, any course change) are both
 * classified here. The approval-gate UX that consumes it — proposing an action,
 * one-click approve/reject, distinguishing autonomous from proposed — lives in
 * `dispatcher-proposal` (also pure) and `DispatcherPanel`, so every gate builds
 * on this one tested rule rather than re-deriving the boundary.
 *
 * PURE: no I/O, no Electron, no LLM — a table lookup, unit-testable in isolation
 * and safe to share across main/renderer.
 */

/**
 * A thing the Dispatcher might do. The `auto` set (reversible mechanics) and the
 * `needs-approval` set (scope-changing) are exactly the ADR-0007 division.
 */
export type DispatcherAction =
  // --- Reversible mechanics — auto (ADR-0007) ---
  /** Commit a clean checkpoint between issues (reversible: a commit). */
  | 'commit-checkpoint'
  /** Start the next queued Run within the cap (the *choice* is the Coordinator's). */
  | 'start-next'
  /** Synthesize a cross-Run summary ("both done — here's what changed"). */
  | 'synthesize'
  /** Relay progress in plain language. */
  | 'relay'
  // --- Scope-changing — needs human approval (ADR-0007) ---
  /** Log a new issue (a scope change). */
  | 'log-issue'
  /** Merge finished parallel Runs into main (human-triggered, ADR-0002). */
  | 'merge'
  /** Abort the drain. */
  | 'abort-drain'
  /**
   * Discard a blocked/stranded Run's worktree + branch and continue the drain
   * (issue 22's discard path). Destructive and irreversible — it force-removes a
   * worktree and deletes its branch — so it is a scope-changing call the human
   * must approve (issue 37), never something the Dispatcher does on its own.
   */
  | 'discard-and-continue'
  /** Change course (re-order, re-scope, skip). */
  | 'course-change';

/** Whether the Dispatcher may act on its own, or must ask first. */
export type Authority = 'auto' | 'needs-approval';

/**
 * The reversible-mechanics set: the Dispatcher acts on these without asking. A
 * `Set` (not a switch) so the boundary is one obvious list to read and extend.
 */
const AUTO_ACTIONS: ReadonlySet<DispatcherAction> = new Set<DispatcherAction>([
  'commit-checkpoint',
  'start-next',
  'synthesize',
  'relay',
]);

/**
 * Classify a proposed Dispatcher action. Anything not explicitly in the auto set
 * is `needs-approval` — the safe default is to ask, so a new (unclassified)
 * action never silently self-authorizes.
 */
export function classifyAuthority(action: DispatcherAction): Authority {
  return AUTO_ACTIONS.has(action) ? 'auto' : 'needs-approval';
}

/** Convenience: does the Dispatcher act on this on its own? */
export function isAuto(action: DispatcherAction): boolean {
  return classifyAuthority(action) === 'auto';
}
