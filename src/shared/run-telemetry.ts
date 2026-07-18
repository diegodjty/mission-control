/**
 * Run telemetry (issue 143, ADR-0001 amendment): pure extraction/aggregation
 * over a headless Run's terminal result event, so the MC-owned Run-log record,
 * Run card, and drain journal can show tokens/cost/duration without touching
 * the Receipt (producer-owned, untouched — ADR-0013).
 *
 * A Pane Run never has a `TerminalResult` (no stream-json result event), so it
 * only ever contributes a duration — the asymmetry ("time-only") is expressed
 * here as every token/cost field staying `null`, not as a different shape.
 */
import type { TerminalResult } from './headless-feed';
import type { WorkerModelTier } from './worker-model';

export interface RunUsage {
  /** Wall-clock duration of the Run, in ms. Present for both Pane and headless. */
  durationMs: number | null;
  /** `usage.input_tokens` off the result event. Null for a Pane Run. */
  inputTokens: number | null;
  /** `usage.output_tokens` off the result event. Null for a Pane Run. */
  outputTokens: number | null;
  /** `usage.cache_read_input_tokens` off the result event. Null for a Pane Run. */
  cacheReadTokens: number | null;
  /** `usage.cache_creation_input_tokens` off the result event. Null for a Pane Run. */
  cacheCreationTokens: number | null;
  /** `raw.total_cost_usd` off the result event. Null for a Pane Run. */
  costUsd: number | null;
  /** The Worker model tier this Run spawned on (issue 154/155). Null for a Pane Run. */
  tier: WorkerModelTier | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Build the telemetry for a HEADLESS Run from its terminal result event (or
 * `null` if it never produced one — e.g. it was killed before finishing) plus
 * the wall-clock duration main measured from spawn to exit. Returns `null`
 * only when there is truly nothing to stamp (no result AND no duration) — a
 * Run that exited with no result event still gets a duration-only record.
 */
export function extractRunUsage(
  result: TerminalResult | null,
  durationMs: number | null,
  tier: WorkerModelTier | null = null,
): RunUsage | null {
  const usage = result?.usage ?? null;
  const inputTokens = num(usage?.input_tokens);
  const outputTokens = num(usage?.output_tokens);
  const cacheReadTokens = num(usage?.cache_read_input_tokens);
  const cacheCreationTokens = num(usage?.cache_creation_input_tokens);
  const costUsd = num(result?.raw.total_cost_usd);

  if (
    durationMs === null &&
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheCreationTokens === null &&
    costUsd === null
  ) {
    return null;
  }

  return {
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    tier,
  };
}

/** The time-only telemetry a Pane Run contributes — every token/cost field null. */
export function timeOnlyUsage(durationMs: number | null): RunUsage | null {
  if (durationMs === null) return null;
  return {
    durationMs,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    tier: null,
  };
}

export interface RunTotals {
  /** How many of the summed Runs carried any usage at all (Pane or headless). */
  runsWithUsage: number;
  /** Total Runs the totals were computed over, including ones with no usage. */
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
}

/** Sum telemetry across a mixed set of Runs (headless with usage, Pane time-only, or none). */
export function sumRunUsage(usages: readonly (RunUsage | null | undefined)[]): RunTotals {
  const totals: RunTotals = {
    runsWithUsage: 0,
    totalRuns: usages.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
  for (const usage of usages) {
    if (usage == null) continue;
    totals.runsWithUsage += 1;
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
    totals.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
    totals.costUsd += usage.costUsd ?? 0;
    totals.durationMs += usage.durationMs ?? 0;
  }
  return totals;
}

/** `12.3k` above 1000 tokens, the plain integer below — keeps card/journal lines short. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** `$0.0000` below a cent (never silently rounds to `$0.00`), `$1.23` otherwise. */
export function formatCostUsd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
