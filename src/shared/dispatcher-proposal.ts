/**
 * Dispatcher activity + proposal model (PURE) — the ADR-0007 approval gate's
 * state, minus the UI.
 *
 * The authority classifier (`dispatcher-authority`) draws the line: an action is
 * `auto` (reversible mechanics the Dispatcher just does) or `needs-approval`
 * (a scope-changing judgement call). This module turns a classified action into
 * a renderable **activity**:
 *
 *   - an `auto` action is recorded as already `taken` — the UI shows it as
 *     something the Dispatcher DID on its own;
 *   - a `needs-approval` action is recorded as `pending` — a PROPOSAL the human
 *     approves or rejects with one click before it executes.
 *
 * Approving/rejecting is a pure state transition here; the actual execution (run
 * the merge, etc.) is the caller's — this module never performs a side effect.
 * Keeping the "proposed vs taken" distinction and the approve/reject transition
 * as a pure, table-driven function is what makes the gate unit-testable in
 * isolation and safe to share across main/renderer.
 */
import {
  classifyAuthority,
  type Authority,
  type DispatcherAction,
} from './dispatcher-authority';

/**
 * Where an activity is in its lifecycle:
 *   - `taken`     — an autonomous (auto) action the Dispatcher already did.
 *   - `pending`   — a scope-changing proposal awaiting the human's one click.
 *   - `approved`  — a proposal the human approved (the caller then executes it).
 *   - `rejected`  — a proposal the human dropped; the Dispatcher continues.
 */
export type ActivityStatus = 'taken' | 'pending' | 'approved' | 'rejected';

/** A human's one-click verdict on a pending proposal. */
export type ApprovalDecision = 'approved' | 'rejected';

/**
 * One thing the Dispatcher did or proposes, as the chat panel renders it. The
 * `authority` is carried alongside `status` so the UI can style "autonomous"
 * (auto) distinctly from "proposed" (needs-approval) regardless of status.
 */
export interface DispatcherActivity {
  /** Stable id (caller-assigned), so approve/reject can target one activity. */
  id: string;
  action: DispatcherAction;
  authority: Authority;
  /** Plain-language description of the action. */
  label: string;
  status: ActivityStatus;
}

/**
 * Plain-language, tense-neutral description of each action, so both a "did this"
 * chip and a "do this?" proposal can reuse one phrase. Exhaustive over the union
 * (a `Record`), so a new action forces a label here rather than rendering blank.
 */
const LABELS: Record<DispatcherAction, string> = {
  'commit-checkpoint': 'Commit a clean checkpoint between issues',
  'start-next': 'Start the next queued Run within the cap',
  synthesize: 'Synthesize cross-Run progress',
  relay: 'Relay progress in plain language',
  'log-issue': 'Log a new issue',
  merge: 'Merge finished parallel Runs into main',
  'abort-drain': 'Abort the drain',
  'discard-and-continue': 'Discard the stranded worktree and continue the drain',
  'amend-plan': 'Amend the plan to reconcile a doc-drift finding',
  'course-change': 'Change course',
};

/** Plain-language description of an action, for the chat panel. */
export function describeAction(action: DispatcherAction): string {
  return LABELS[action];
}

/**
 * Build the activity for a proposed/taken action. Its initial status follows its
 * authority: an `auto` action is already `taken` (the Dispatcher did it); a
 * `needs-approval` action is `pending` (a proposal awaiting a click) — so a
 * Merge, always `needs-approval` (ADR-0002), can never start as `taken`.
 */
export function recordActivity(
  id: string,
  action: DispatcherAction,
): DispatcherActivity {
  const authority = classifyAuthority(action);
  return {
    id,
    action,
    authority,
    label: describeAction(action),
    status: authority === 'auto' ? 'taken' : 'pending',
  };
}

/**
 * Apply a human's approve/reject verdict. Only a `pending` proposal can be
 * resolved: an autonomous `taken` action was never up for a vote, and an
 * already-resolved proposal is left as-is (idempotent — a double-click or a
 * re-render can't flip an approval to a rejection or re-fire it).
 */
export function resolveActivity(
  activity: DispatcherActivity,
  decision: ApprovalDecision,
): DispatcherActivity {
  if (activity.status !== 'pending') return activity;
  return { ...activity, status: decision };
}

/** A scope-changing action the Dispatcher proposes rather than takes. */
export function isProposal(activity: DispatcherActivity): boolean {
  return activity.authority === 'needs-approval';
}

/** A reversible-mechanics action the Dispatcher takes on its own. */
export function isAutonomous(activity: DispatcherActivity): boolean {
  return activity.authority === 'auto';
}

/** Whether this activity is still awaiting a human click (approve/reject shown). */
export function isActionable(activity: DispatcherActivity): boolean {
  return activity.status === 'pending';
}
