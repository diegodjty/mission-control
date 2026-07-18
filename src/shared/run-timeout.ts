/**
 * Run timeout policy (issue 141) — a pure decision for "has this headless Run
 * been running too long?", plus the CONFIG parsing that feeds it.
 *
 * A headless drain Run (issue 139) is watched, never talked to: nothing stops
 * it from hanging forever (a Worker stuck in a loop, a wedged tool call). The
 * project CONFIG's `run_timeout` (minutes, default 30) declares how long is
 * too long; `hasRunTimedOut` is the breach test the caller (the Headless
 * Session Manager, which owns the actual kill) evaluates against a Run's
 * recorded start time. A killed Run — like any headless Run that exits
 * non-zero with no Receipt — lands in the existing no-Receipt handling
 * (conservative drain stop, attention item): no new failure vocabulary.
 *
 * PURE: no I/O, no Electron, no timers. Parsing never throws — a missing or
 * malformed `run_timeout` degrades to the default, exactly like the other
 * CONFIG keys (`worker_model`/`escalation_ceiling`, `parseTier`/
 * `parseWorkerTieringConfig` in worker-model.ts).
 */

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
