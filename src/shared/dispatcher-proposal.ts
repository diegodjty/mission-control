/**
 * Dispatcher activity + proposal model (PURE) — the ADR-0011 approval gate's
 * state, minus the UI.
 *
 * The authority classifier (`dispatcher-authority`) draws the line into three
 * tiers: `blocking` (the 3-item interruption list), `passive` (an ambient note),
 * and `silent`. This module turns a classified action into a renderable
 * **activity**:
 *
 *   - a `blocking` action is recorded as `pending` — a PROPOSAL the human
 *     approves or rejects with one click before it executes;
 *   - a `passive` or `silent` (non-blocking) action is recorded as already
 *     `taken` — the Dispatcher acted on its own (ADR-0011's silent autonomy);
 *     the UI shows it as a quiet note rather than a gate.
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
 * (silent/passive) distinctly from "proposed" (blocking) regardless of status.
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
  'log-issue': 'Log a new follow-up issue',
  merge: 'Merge finished parallel Runs into main (clean)',
  'discard-and-continue': 'Discard the stranded worktree and continue the drain',
  'amend-plan': 'Amend the plan to reconcile a doc-drift finding',
  'course-change': 'Change course',
  'merge-conflict': 'Resolve the merge conflict on main (or abort it)',
  'abort-drain': 'Abort the drain',
  'hitl-signoff': 'Sign off the HITL issue awaiting manual verification',
};

/** Plain-language description of an action, for the chat panel. */
export function describeAction(action: DispatcherAction): string {
  return LABELS[action];
}

/**
 * Build the activity for a proposed/taken action. Its initial status follows its
 * authority (ADR-0011): a `blocking` action is `pending` (a proposal awaiting a
 * click); a non-blocking (`passive` or `silent`) action is already `taken` (the
 * Dispatcher did it on its own) — so only the three-item blocking list ever
 * starts as a gate, and a clean merge or a logged issue never does.
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
    status: authority === 'blocking' ? 'pending' : 'taken',
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

/** A blocking action the Dispatcher proposes rather than takes (ADR-0011). */
export function isProposal(activity: DispatcherActivity): boolean {
  return activity.authority === 'blocking';
}

/** A non-blocking action the Dispatcher takes on its own (silent or passive). */
export function isAutonomous(activity: DispatcherActivity): boolean {
  return activity.authority !== 'blocking';
}

/** Whether this activity is still awaiting a human click (approve/reject shown). */
export function isActionable(activity: DispatcherActivity): boolean {
  return activity.status === 'pending';
}

/**
 * The two display groups the panel renders separately (issue 44): `pending`
 * proposals still awaiting the human's approve/reject verdict, and everything
 * else (`resolved` — autonomous notes the Dispatcher took on its own, plus
 * already-approved/rejected proposals). Splitting them lets the UI keep pending
 * action items prominent and always reachable while the resolved log scrolls
 * within a small bounded height, so a new autonomous note can't progressively
 * shrink the chat. Order within each group is preserved (arrival order).
 */
export interface ActivityGroups {
  pending: DispatcherActivity[];
  resolved: DispatcherActivity[];
}

/** Partition activities into pending proposals vs everything already resolved. */
export function partitionActivities(activities: DispatcherActivity[]): ActivityGroups {
  const pending: DispatcherActivity[] = [];
  const resolved: DispatcherActivity[] = [];
  for (const a of activities) {
    if (a.status === 'pending') pending.push(a);
    else resolved.push(a);
  }
  return { pending, resolved };
}
