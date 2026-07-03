/**
 * Dispatcher authority classifier (PURE) — the ADR-0011 line.
 *
 * ADR-0011 INVERTS the old ADR-0007 posture: the Dispatcher acts **silently and
 * autonomously by default**, and interruptions are a tiny, explicit exception.
 * This module encodes that division: a proposed action → one of three tiers:
 *
 *   - `blocking` — the Dispatcher must STOP and get a one-click human approval
 *     before it proceeds. The ENTIRE blocking list is three items and nothing
 *     else: (1) a Merge that hit a conflict, (2) aborting/stopping a drain,
 *     (3) a HITL issue awaiting the user's sign-off.
 *   - `passive`  — a notable, non-blocking state change worth an ambient,
 *     ignorable note (committed a checkpoint, a clean merge, a follow-up issue
 *     logged, a plan amended, a stranded worktree discarded, a course tweak).
 *     Where those notes render is issue 48; here they just classify as passive.
 *   - `silent`   — pure mechanics the Dispatcher does without even a note,
 *     answerable on demand (starting the next Run, synthesizing, relaying).
 *
 * The proposal/activity UX that consumes it — recording a `blocking` action as a
 * pending one-click approve/reject, and everything else as an already-taken note
 * — lives in `dispatcher-proposal` (also pure) and `DispatcherPanel`, so every
 * gate builds on this one tested rule rather than re-deriving the boundary.
 *
 * PURE: no I/O, no Electron, no LLM — a table lookup, unit-testable in isolation
 * and safe to share across main/renderer.
 */

/**
 * A thing the Dispatcher might do. The `blocking` set is the ADR-0011 three-item
 * interruption list; everything else is non-blocking (`passive` or `silent`).
 */
export type DispatcherAction =
  // --- Silent mechanics (no note) ---
  /** Start the next queued Run within the cap (the *choice* is the Coordinator's). */
  | 'start-next'
  /** Synthesize a cross-Run summary ("both done — here's what changed"). */
  | 'synthesize'
  /** Relay progress in plain language. */
  | 'relay'
  // --- Passive notes (ambient, non-blocking) ---
  /** Commit a clean checkpoint between issues (reversible: a commit). */
  | 'commit-checkpoint'
  /** Log a new follow-up issue (cheap + reversible — a passive note, ADR-0011). */
  | 'log-issue'
  /**
   * Merge finished parallel Runs into main when it is CLEAN. A conflict-free
   * merge of finished work auto-proceeds (ADR-0011 refines ADR-0002) and leaves a
   * passive note; only a *conflicting* merge (`merge-conflict`) blocks.
   */
  | 'merge'
  /**
   * Discard a blocked/stranded Run's worktree + branch and continue the drain
   * (issue 22's discard path). Still destructive, but ADR-0011 keeps the blocking
   * list to three items and this is not one of them — so it is non-blocking, left
   * as a passive note rather than a gate.
   */
  | 'discard-and-continue'
  /**
   * Amend the plan (PRD/backlog) to reconcile a doc-drift finding a Run reported
   * (issue 38). Under ADR-0011 this no longer gates — it is a passive note; the
   * heavier "surface, human decides" ceremony was part of the interruption
   * firehose the ADR removes.
   */
  | 'amend-plan'
  /** Change course (re-order, re-scope, skip) — a passive note, not a gate. */
  | 'course-change'
  /**
   * A Merge that failed its PREFLIGHT (uncommitted changes on main, wrong
   * branch, tool error) — as opposed to hitting a real conflict (issue 59).
   * Approving it could only retry into the same failed preflight, so it is NOT
   * an approval: it surfaces as its own passive note naming the real cause
   * (the offending paths), and the retry happens after the user (or MC's
   * straggler-Receipt commit) cleans the tree.
   */
  | 'merge-preflight'
  // --- Blocking approval — the ADR-0011 three-item list ---
  /**
   * A Merge that hit a conflict. The one merge case that still blocks (ADR-0011
   * refines ADR-0002): a conflicting/risky merge must not land on main silently,
   * so the user resolves or aborts it.
   */
  | 'merge-conflict'
  /** Abort/stop the drain. */
  | 'abort-drain'
  /**
   * A HITL issue awaiting the user's sign-off — the drain reached a
   * human-in-the-loop issue parked for manual verification, and only the human
   * can mark it done.
   */
  | 'hitl-signoff';

/**
 * Which interruption tier an action falls in (ADR-0011):
 *   - `blocking` — stop and get one-click approval first.
 *   - `passive`  — a non-blocking ambient note.
 *   - `silent`   — done without a note, answerable on demand.
 */
export type Authority = 'blocking' | 'passive' | 'silent';

/**
 * The full ADR-0011 line as an exhaustive table — every action mapped to its
 * tier. A `Record` (not a `Set` + default) so a newly-added action fails to
 * compile until it is classified here, rather than silently defaulting.
 *
 * The `blocking` values are the ENTIRE interruption list: merge-conflict,
 * abort-drain, hitl-signoff. Nothing else blocks (ADR-0011).
 */
const AUTHORITY: Record<DispatcherAction, Authority> = {
  // Silent mechanics.
  'start-next': 'silent',
  synthesize: 'silent',
  relay: 'silent',
  // Passive, non-blocking notes.
  'commit-checkpoint': 'passive',
  'log-issue': 'passive',
  merge: 'passive',
  'discard-and-continue': 'passive',
  'amend-plan': 'passive',
  'course-change': 'passive',
  'merge-preflight': 'passive',
  // The three-item blocking list.
  'merge-conflict': 'blocking',
  'abort-drain': 'blocking',
  'hitl-signoff': 'blocking',
};

/** Classify a proposed Dispatcher action into its ADR-0011 interruption tier. */
export function classifyAuthority(action: DispatcherAction): Authority {
  return AUTHORITY[action];
}

/** Does this action STOP for a one-click human approval (the 3-item list)? */
export function isBlocking(action: DispatcherAction): boolean {
  return classifyAuthority(action) === 'blocking';
}
