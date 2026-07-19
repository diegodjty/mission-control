/**
 * Receipt audit (PURE) — issue 57, ADR-0013.
 *
 * With Receipts as the SOLE capture input (the PTY scroll is never parsed),
 * two honest signals replace what the scroll scrape used to fake:
 *
 *   - `auditMissingReceipts` — ground truth says a Run ended (its issue flipped
 *     `done`, or its session ended without finishing) but no Receipt exists for
 *     it → derive ONE `finished-without-receipt` lifecycle event per Run. The
 *     reaction ("peek at the Pane") lands as a passive ambient-log note — never
 *     a scrape, never a guess (ADR-0013's "missing Receipt is information").
 *
 *   - `detectReceiptStateMismatches` — the latest Receipt's declared narrative
 *     disagrees with git's ground truth (e.g. Receipt says `completed`, the
 *     issue file says `wip`). Trust hierarchy per ADR-0013: state (git/issue
 *     frontmatter) wins — the status model never reads outcomes — and the
 *     mismatch surfaces as one debounced passive note (the caller debounces by
 *     checking against the already-debounced status model after a grace
 *     window, and dedupes by issue).
 *
 * PURE: no I/O, no Electron, no timers. The renderer (App.tsx) supplies the
 * live facts (tracked Runs, the Run log, the reconciled status model) and the
 * grace-window timing.
 */
import type { RunLogRecord } from './ipc-contract';
import type { RunOutcome } from './completion-parser';
import type { RunStatus } from './run-state';
import type { LifecycleEvent } from './run-lifecycle';
import type { GroundedStatus, IssueGroundStatus } from './drain-status-model';

/**
 * Whether a Run-log record came from the Receipt capture edge (issue 56): its
 * id is the edge's `receipt:<NN-slug>:<finished>` identity. A legacy record
 * persisted by the retired scroll path (id = PTY session id) is not a Receipt
 * and must never satisfy "a Receipt exists for this Run".
 */
export function isReceiptRecord(record: Pick<RunLogRecord, 'id'>): boolean {
  return record.id.startsWith('receipt:');
}

/** Whether the Run log holds a Receipt for the given issue. */
export function hasReceiptFor(
  runLog: readonly RunLogRecord[],
  issueId: number,
): boolean {
  return runLog.some((rec) => isReceiptRecord(rec) && rec.issueId === issueId);
}

/** The LATEST Receipt record per issue id (newest `capturedAt` wins). */
function latestReceiptsByIssue(
  runLog: readonly RunLogRecord[],
): Map<number, RunLogRecord> {
  const latest = new Map<number, RunLogRecord>();
  for (const rec of runLog) {
    if (!isReceiptRecord(rec) || rec.issueId === null) continue;
    const prior = latest.get(rec.issueId);
    if (!prior || rec.capturedAt > prior.capturedAt) latest.set(rec.issueId, rec);
  }
  return latest;
}

/**
 * The outcome the latest Receipt for `issueId` declared, or null when no
 * Receipt exists for it. This is the declared fact the Run Coordinator's
 * park/blocked distinction reads (`isParkedHitl`, issue 64): a superseded
 * re-run's stale outcome is not a live claim, so only the newest Receipt
 * counts — the same latest-wins rule the mismatch audit judges by. Legacy
 * non-Receipt records (scroll-era, id = PTY session id) never contribute.
 */
export function latestReceiptOutcomeFor(
  runLog: readonly RunLogRecord[],
  issueId: number,
): RunOutcome | null {
  return latestReceiptsByIssue(runLog).get(issueId)?.outcome ?? null;
}

/**
 * The latest Receipt record for `issueId`, or null when none exists — the
 * full record (issue 156's checklist reads its `detail` body), same
 * newest-`capturedAt`-wins rule as `latestReceiptOutcomeFor`.
 */
export function latestReceiptFor(
  runLog: readonly RunLogRecord[],
  issueId: number,
): RunLogRecord | null {
  return latestReceiptsByIssue(runLog).get(issueId) ?? null;
}

/** The facts about one tracked Run the missing-Receipt audit needs. */
export interface AuditedRun {
  issueId: number;
  slug: string | null;
  title: string | null;
  /** The Run's derived status (run-state) — its ground-truth lifecycle. */
  status: RunStatus;
  /**
   * Why this Run's process ended with no Receipt (issue 141): `timeout` when
   * the Headless Session Manager killed it for exceeding `run_timeout`,
   * `crashed` when it exited non-zero on its own, or null/absent when unknown
   * (a user stop, a legacy pre-cause Run, an interactive Pane). Named in the
   * audit's note so the cause is visible without a scrape.
   */
  endCause?: 'timeout' | 'crashed' | null;
}

/** The note's cause clause for `endCause`, or null for the unchanged default. */
function endCauseClause(endCause: 'timeout' | 'crashed' | null | undefined): string | null {
  switch (endCause) {
    case 'timeout':
      return 'was killed after exceeding its run timeout';
    case 'crashed':
      return 'crashed';
    default:
      return null;
  }
}

/**
 * Whether a Run's ground-truth status means it ENDED and therefore owes a
 * Receipt (ADR-0013: all three Worker exits write one). `finished` (issue
 * flipped `done`) and `blocked` (session ended without finishing) both qualify;
 * a `running` Run may still write one, and a user-`stopped` Run was killed
 * mid-flight — no Receipt is expected, so a note would be noise (ADR-0012).
 */
function endedOwingReceipt(status: RunStatus): boolean {
  return status === 'finished' || status === 'blocked';
}

/**
 * Derive the `finished-without-receipt` lifecycle events: one per ended Run
 * with no Receipt in the log. The caller applies the grace window (a Receipt
 * may land a beat after the `done` flip) and the once-per-Run guard; this is
 * only the pure decision.
 */
export function auditMissingReceipts(
  runs: readonly AuditedRun[],
  runLog: readonly RunLogRecord[],
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  for (const run of runs) {
    if (!endedOwingReceipt(run.status)) continue;
    if (hasReceiptFor(runLog, run.issueId)) continue;
    events.push({
      kind: 'finished-without-receipt',
      runId: `missing-receipt-${run.issueId}`,
      issueId: run.issueId,
      slug: run.slug,
      title: run.title,
      detail: endCauseClause(run.endCause),
    });
  }
  return events;
}

/** One Receipt-vs-git disagreement (narrative vs state, ADR-0013). */
export interface ReceiptStateMismatch {
  issueId: number;
  slug: string | null;
  /** What the Receipt declared happened. */
  declared: RunOutcome;
  /** What git/issue-frontmatter (the reconciled status model) says. */
  grounded: GroundedStatus;
}

/** Grounded statuses that mean the issue's work genuinely finished. */
const FINISHED_STATES: readonly GroundedStatus[] = ['done', 'finished-unmerged'];

/**
 * Whether a declared outcome contradicts the grounded status. Held to a HIGH
 * confidence bar (ADR-0012 — if in doubt, stay silent): only the two
 * unambiguous disagreements fire.
 *   - Receipt says `completed` but git shows the issue still open/wip.
 *   - Receipt says `needs-verification`/`blocked` but git shows it finished.
 * Everything else (a park on a wip issue, an unknown outcome) is consistent
 * enough to stay quiet.
 */
function contradicts(declared: RunOutcome, grounded: GroundedStatus): boolean {
  if (declared === 'completed') return !FINISHED_STATES.includes(grounded);
  if (declared === 'needs-verification' || declared === 'blocked') {
    return FINISHED_STATES.includes(grounded);
  }
  return false;
}

/**
 * Detect Receipt/state disagreements between the Run log and the reconciled
 * status model's issues. Judges only the LATEST Receipt per issue (newest
 * `capturedAt`): a superseded re-run's stale narrative is not a live claim.
 * Legacy non-Receipt records are ignored entirely.
 */
export function detectReceiptStateMismatches(
  runLog: readonly RunLogRecord[],
  issues: readonly IssueGroundStatus[],
): ReceiptStateMismatch[] {
  const latest = latestReceiptsByIssue(runLog);

  const mismatches: ReceiptStateMismatch[] = [];
  for (const issue of issues) {
    const rec = latest.get(issue.issueId);
    if (!rec) continue;
    if (!contradicts(rec.outcome, issue.status)) continue;
    mismatches.push({
      issueId: issue.issueId,
      slug: issue.slug ?? rec.slug,
      declared: rec.outcome,
      grounded: issue.status,
    });
  }
  return mismatches;
}

/** Stable note id for a mismatch, so it is surfaced at most once per issue. */
export function mismatchKey(mismatch: ReceiptStateMismatch): string {
  return `receipt-state-mismatch:${mismatch.issueId}`;
}

/**
 * The one-line passive note for a mismatch. Says which side wins (state — git
 * stays authoritative; ADR-0013) so the user reads it as a heads-up about a
 * stale/early narrative, not a status change.
 */
export function describeReceiptMismatch(mismatch: ReceiptStateMismatch): string {
  const label =
    `issue ${String(mismatch.issueId).padStart(2, '0')}` +
    (mismatch.slug ? ` — ${mismatch.slug}` : '');
  return (
    `Receipt for ${label} says ${mismatch.declared}, but git shows ` +
    `${mismatch.grounded} — status follows git.`
  );
}
