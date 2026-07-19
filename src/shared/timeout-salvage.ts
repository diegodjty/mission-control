/**
 * Timeout salvage (PURE) — issue 170.
 *
 * A `run_timeout` kill (issue 141) stops a Worker mid-flight: its worktree may
 * hold FINISHED, committable work (the 2026-07-19 incident — issue 161 passed
 * type-check and all 1742 tests, then got killed before it could commit/write
 * a Receipt/flip status) or genuinely broken work. Either way the strand must
 * be LOUD, not a silent no-Receipt death, and RECOVERABLE, not a hand rescue.
 *
 * This module is the pure decision layer:
 *
 *  - `TimeoutSalvageRecord` — one pending strand: which issue, which worktree,
 *    when it timed out. Persisted by the caller (main) as plain JSON — parse/
 *    serialize/upsert/remove here are pure so the fs edge stays a thin adapter.
 *  - `salvageActionFor` — once the caller has run the project's verify
 *    commands (type-check + test) against the worktree, this is the one-line
 *    decision: green offers **complete-from-worktree**, red offers
 *    **discard-and-requeue**.
 *
 * PURE: no I/O, no Electron, no timers. Malformed persisted content degrades
 * to the empty list — never a throw, never a guess.
 */

/** One Run killed for exceeding `run_timeout`, awaiting a salvage decision. */
export interface TimeoutSalvageRecord {
  /** The workbench project directory name (or legacy repo key) this belongs to. */
  project: string;
  issueId: number;
  /** The `NN-slug` of the killed Run's `afk/NN-slug` branch. */
  slug: string;
  /** The absolute path of the worktree the killed Worker was running in. */
  worktreePath: string;
  /** When the kill fired (ISO-8601). */
  timedOutAt: string;
}

function isValidRecord(value: unknown): value is TimeoutSalvageRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.project === 'string' &&
    r.project.length > 0 &&
    typeof r.issueId === 'number' &&
    Number.isFinite(r.issueId) &&
    typeof r.slug === 'string' &&
    r.slug.length > 0 &&
    typeof r.worktreePath === 'string' &&
    r.worktreePath.length > 0 &&
    typeof r.timedOutAt === 'string' &&
    r.timedOutAt.length > 0
  );
}

/**
 * Parse the persisted salvage-records file (`TimeoutSalvageRecord[]` JSON).
 * Malformed content — missing file, junk JSON, non-array, malformed entries —
 * degrades to the empty list: a strand that fails to parse must never be
 * silently dropped from the user's view by throwing; the caller's read simply
 * yields "nothing pending" and the record is recoverable by re-deriving from
 * a fresh timeout (the record is regenerated at kill time, not user-authored).
 */
export function parseTimeoutSalvageRecords(content: string | null | undefined): TimeoutSalvageRecord[] {
  if (typeof content !== 'string' || content.trim().length === 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidRecord);
}

/** Serialize the salvage-records list for the persisted file (stable order). */
export function serializeTimeoutSalvageRecords(records: readonly TimeoutSalvageRecord[]): string {
  const sorted = [...records].sort((a, b) =>
    a.project === b.project ? a.issueId - b.issueId : a.project.localeCompare(b.project),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Upsert one record, keyed on `project` + `issueId` — a re-timeout of the same
 * issue (a re-run that itself times out again) replaces the prior record
 * rather than accumulating duplicates.
 */
export function upsertTimeoutSalvageRecord(
  records: readonly TimeoutSalvageRecord[],
  record: TimeoutSalvageRecord,
): TimeoutSalvageRecord[] {
  const rest = records.filter((r) => !(r.project === record.project && r.issueId === record.issueId));
  return [...rest, record];
}

/** Remove one project+issue's pending record — resolved (salvaged or discarded). */
export function removeTimeoutSalvageRecord(
  records: readonly TimeoutSalvageRecord[],
  project: string,
  issueId: number,
): TimeoutSalvageRecord[] {
  return records.filter((r) => !(r.project === project && r.issueId === issueId));
}

/** The records belonging to one project, in ascending issue order. */
export function timeoutSalvageRecordsFor(
  records: readonly TimeoutSalvageRecord[],
  project: string,
): TimeoutSalvageRecord[] {
  return records.filter((r) => r.project === project).sort((a, b) => a.issueId - b.issueId);
}

/** What a salvage verify pass offers next: complete when green, discard when red. */
export type SalvageAction = 'complete-from-worktree' | 'discard-and-requeue';

/**
 * The salvage decision once the project's verify commands (type-check + test)
 * have been run against the killed Run's worktree: green offers one-click
 * **Complete from worktree** (commit + Receipt + `done` flip); red offers
 * **discard-and-requeue** (the worktree is thrown away, the issue reopens for
 * the drain to retry). Pure — the caller supplies the already-computed result.
 */
export function salvageActionFor(verifyPassed: boolean): SalvageAction {
  return verifyPassed ? 'complete-from-worktree' : 'discard-and-requeue';
}
