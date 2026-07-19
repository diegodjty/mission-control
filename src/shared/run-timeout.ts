/**
 * Run timeout policy (issue 141) — a pure decision for "has this headless Run
 * been running too long?", plus the CONFIG parsing that feeds it.
 *
 * A headless drain Run (issue 139) is watched, never talked to: nothing stops
 * it from hanging forever (a Worker stuck in a loop, a wedged tool call). The
 * project CONFIG's `run_timeout` (minutes, default 30) declares how long is
 * too long; `hasRunTimedOut` is the breach test the caller (the Headless
 * Session Manager, which owns the actual kill) evaluates against a Run's
 * recorded start time.
 *
 * Issue 170 revises the "no new failure vocabulary" call this module
 * originally made: a timeout kill is no longer folded silently into the
 * generic no-Receipt path (the 2026-07-19 incident — a healthy, finished
 * refactor killed and stranded with no distinct signal). `resolveRunTimeoutMs`
 * / `resolveRunTimeoutMinutes` are the blunt-kill mitigation — a per-issue
 * override or an effort-scaled budget — and the DISTINCT timeout signal itself
 * lives in `timeout-salvage.ts`.
 *
 * PURE: no I/O, no Electron, no timers. Parsing never throws — a missing or
 * malformed `run_timeout` degrades to the default, exactly like the other
 * CONFIG keys (`worker_model`/`escalation_ceiling`, `parseTier`/
 * `parseWorkerTieringConfig` in worker-model.ts).
 */
import type { WorkerEffort } from './worker-model';

/** CONFIG `run_timeout` default when unset/unknown/malformed — 30 minutes. */
export const DEFAULT_RUN_TIMEOUT_MINUTES = 30;

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** Read one `key: value` line from a CONFIG's YAML frontmatter block. */
function frontmatterValue(content: string, key: string): string | undefined {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(fm[1]);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse the project CONFIG's `run_timeout` (minutes) frontmatter value. A
 * missing key, a non-numeric value, or a non-positive number all degrade to
 * the documented default — a garbage value is not a declaration, exactly like
 * `parseTier`/`parseEffort` (worker-model.ts).
 */
export function parseRunTimeoutMinutes(configContent: string | null | undefined): number {
  const raw = frontmatterValue(configContent ?? '', 'run_timeout');
  if (raw === undefined) return DEFAULT_RUN_TIMEOUT_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RUN_TIMEOUT_MINUTES;
}

/** The resolved `run_timeout`, in milliseconds — what the spawn edge arms its kill timer with. */
export function runTimeoutMsFor(configContent: string | null | undefined): number {
  return parseRunTimeoutMinutes(configContent) * 60_000;
}

/**
 * Whether a Run started at `startedAt` has breached `timeoutMs` as of `now`
 * (both epoch ms). The caller supplies `now` so the decision stays pure and
 * testable without a real clock.
 */
export function hasRunTimedOut(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt >= timeoutMs;
}

/**
 * Blunt-kill mitigation (issue 170): a flat 30-minute wall-clock killed a
 * legitimately long, healthy refactor (the 2026-07-19 incident — issue 161
 * finished correctly at ~30m but was killed before it could commit). Two
 * declared (never guessed) levers soften the cliff:
 *
 *  - a per-issue `run_timeout` frontmatter override, read the same way the
 *    CONFIG default is (`parseIssueRunTimeoutMinutes`) — an issue that KNOWS
 *    it's a big refactor declares its own budget, exactly like `model:`/
 *    `effort:` (worker-model.ts, issues 154/155);
 *  - absent an override, the CONFIG default scales with the Worker's
 *    resolved EFFORT tier (`resolveRunTimeoutMinutes`) — a `high`/`xhigh`/
 *    `max` effort Worker is doing harder, more deliberate work, so its clock
 *    runs longer before a kill is declared blunt rather than protective.
 */
export function parseIssueRunTimeoutMinutes(issueContent: string | null | undefined): number | null {
  const raw = frontmatterValue(issueContent ?? '', 'run_timeout');
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Effort → timeout multiplier, applied to the CONFIG default when an issue
 * declares no override of its own. `low`/`medium` (haiku/sonnet — the cheap,
 * mechanical default) get no extra runway; `high` (opus/fable) and the
 * override-only `xhigh`/`max` tiers get progressively more, since a Worker
 * running deeper reasoning over a bigger task is expected to take longer.
 */
const EFFORT_TIMEOUT_MULTIPLIER: Record<WorkerEffort, number> = {
  low: 1,
  medium: 1,
  high: 1.5,
  xhigh: 2,
  max: 2.5,
};

/**
 * The resolved `run_timeout`, in MINUTES, for one Run: the issue's own
 * `run_timeout` override when set and valid (wins outright, no scaling
 * applied on top — the issue declared its exact budget); otherwise the
 * CONFIG default scaled by the resolved effort's multiplier, rounded to the
 * nearest minute. `effort` absent/null applies no scaling (multiplier 1).
 */
export function resolveRunTimeoutMinutes(
  configContent: string | null | undefined,
  issueContent: string | null | undefined,
  effort?: WorkerEffort | null,
): number {
  const override = parseIssueRunTimeoutMinutes(issueContent);
  if (override !== null) return override;
  const base = parseRunTimeoutMinutes(configContent);
  const multiplier = effort ? (EFFORT_TIMEOUT_MULTIPLIER[effort] ?? 1) : 1;
  return Math.round(base * multiplier);
}

/** The resolved `run_timeout` for one Run, in MILLISECONDS — see `resolveRunTimeoutMinutes`. */
export function resolveRunTimeoutMs(
  configContent: string | null | undefined,
  issueContent: string | null | undefined,
  effort?: WorkerEffort | null,
): number {
  return resolveRunTimeoutMinutes(configContent, issueContent, effort) * 60_000;
}
