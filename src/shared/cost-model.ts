/**
 * Cost model (PURE) — issue 181, ADR-0023.
 *
 * Turns the two data sources the Cost tab reads into chart-ready shapes:
 * the already-loaded Run log (`RunLogRecord[]`, full per-Run telemetry
 * precision — issue 143) for per-issue cost and token breakdown, and the raw
 * `memory/journal/` entries (issue 73) for **drain grouping** — a drain's
 * boundary and its member Runs exist ONLY in the journal text, so `## Runs`
 * bullet names are parsed back into Run-log record keys and the REAL numbers
 * are re-summed from the Run log (never re-parsed out of a formatted
 * string, which would be lossy — `formatTokens`/`formatCostUsd` round).
 *
 * PURE: no I/O, no Electron, no timers, no DOM.
 */
import type { JournalFile } from './attention-hub-model';
import type { RunLogRecord } from './ipc-contract';
import { sumRunUsage, type RunTotals } from './run-telemetry';

// Structurally identical to the renderer's Charts.tsx prop shapes (BarChartDatum,
// StackedBarDatum, LineSeries/LinePoint) — defined locally rather than imported
// so this PURE module has no dependency on the renderer layer; TS's structural
// typing lets the renderer pass these straight into <BarChart>/<StackedBarChart>/
// <LineChart> with no conversion.
export interface BarChartDatum {
  label: string;
  value: number;
}
export interface StackedBarSegment {
  label: string;
  value: number;
}
export interface StackedBarDatum {
  label: string;
  segments: StackedBarSegment[];
}
export interface LinePoint {
  x: number;
  y: number;
}
export interface LineSeries {
  label: string;
  points: LinePoint[];
}

/** A Run-log record's display label: its slug, or `issue N`, or `Run`. */
function recordLabel(rec: RunLogRecord): string {
  if (rec.slug) return rec.slug;
  if (rec.issueId !== null) return `issue ${rec.issueId}`;
  return 'Run';
}

/**
 * Per-issue cost bars, sorted descending, capped at `limit` (the outliers
 * are the whole point — a long tail past the cap would just be noise).
 * Records with no captured cost (Pane Runs, pre-143 logs, uncaptured
 * telemetry) are excluded rather than shown as zero.
 */
export function issueCostBars(records: readonly RunLogRecord[], limit = 20): BarChartDatum[] {
  return records
    .filter((r) => r.usage?.costUsd !== null && r.usage?.costUsd !== undefined)
    .map((r) => ({ label: recordLabel(r), value: r.usage!.costUsd! }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/**
 * Token breakdown for the top `topN` issues by total tokens — input / output /
 * cache-read / cache-creation stacked, so a "re-read a big file" issue (huge
 * input/cache) reads differently from an "output-heavy" one at a glance.
 * Records with no captured token count are excluded.
 */
export function tokenBreakdownBars(records: readonly RunLogRecord[], topN = 8): StackedBarDatum[] {
  const withTokens = records
    .map((r) => {
      const u = r.usage;
      if (u === null) return null;
      const input = u.inputTokens ?? 0;
      const output = u.outputTokens ?? 0;
      const cacheRead = u.cacheReadTokens ?? 0;
      const cacheCreation = u.cacheCreationTokens ?? 0;
      if (u.inputTokens === null && u.outputTokens === null && u.cacheReadTokens === null && u.cacheCreationTokens === null) {
        return null;
      }
      return { label: recordLabel(r), total: input + output + cacheRead + cacheCreation, input, output, cacheRead, cacheCreation };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  return withTokens.map((d) => ({
    label: d.label,
    segments: [
      { label: 'input', value: d.input },
      { label: 'output', value: d.output },
      { label: 'cache read', value: d.cacheRead },
      { label: 'cache creation', value: d.cacheCreation },
    ],
  }));
}

const RUN_BULLET_RE = /^-\s+([^:]+):/;

/**
 * The Run-log keys a drain journal entry's `## Runs` section names — each
 * bullet's leading name before the colon, a slug or `issue N` (exactly the
 * two shapes `buildJournalEntry`/`recordLabel` produce). Returns `[]` when
 * there is no `## Runs` section (malformed/legacy entry).
 */
export function parseDrainRunKeys(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## Runs');
  if (start === -1) return [];
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = RUN_BULLET_RE.exec(line);
    if (m) keys.push(m[1].trim());
  }
  return keys;
}

/** The drain's stated stop reason, from the `- Reason:` line. `''` when absent. */
export function parseDrainReason(content: string): string {
  const m = /^-\s*Reason:\s*(.*)$/m.exec(content);
  return m ? m[1].trim() : '';
}

/** The journal file's date prefix (`YYYY-MM-DD`), or the bare file name when unparseable. */
function drainDate(fileName: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(fileName);
  return m ? m[1] : fileName;
}

/** One drain's totals: when it ran, why it stopped, and its summed telemetry. */
export interface DrainTotal {
  date: string;
  reason: string;
  fileName: string;
  totals: RunTotals;
}

/**
 * Group the Run log into drains using the journal's `## Runs` membership,
 * summing each drain's REAL per-Run usage (never re-parsed text). A run key
 * with no matching Run-log record (renamed slug, pruned record) is silently
 * skipped — `totals.runsWithUsage`/`totalRuns` reflect only what still
 * resolves, never a throw. Ascending by date (oldest drain first, the shape
 * a trend line wants).
 */
export function drainTotals(
  files: readonly JournalFile[],
  records: readonly RunLogRecord[],
): DrainTotal[] {
  const bySlug = new Map<string, RunLogRecord>();
  const byIssueId = new Map<number, RunLogRecord>();
  for (const r of records) {
    if (r.slug) bySlug.set(r.slug, r);
    if (r.issueId !== null) byIssueId.set(r.issueId, r);
  }

  const resolve = (key: string): RunLogRecord | undefined => {
    const issueMatch = /^issue\s+(\d+)$/.exec(key);
    if (issueMatch) return byIssueId.get(Number(issueMatch[1]));
    return bySlug.get(key);
  };

  return files
    .map((f) => {
      const keys = parseDrainRunKeys(f.content);
      const matched = keys.map(resolve).filter((r): r is RunLogRecord => r !== undefined);
      return {
        date: drainDate(f.name),
        reason: parseDrainReason(f.content),
        fileName: f.name,
        totals: sumRunUsage(matched.map((r) => r.usage)),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.fileName.localeCompare(b.fileName)));
}

/** Cost per drain, in drain order — one point per drain, x = its index. */
export function costTrendSeries(drains: readonly DrainTotal[]): LineSeries[] {
  const points: LinePoint[] = drains.map((d, i) => ({ x: i, y: d.totals.costUsd }));
  return [{ label: 'cost', points }];
}

/** Total tokens (input + output) per drain, in drain order. */
export function tokenTrendSeries(drains: readonly DrainTotal[]): LineSeries[] {
  const points: LinePoint[] = drains.map((d, i) => ({
    x: i,
    y: d.totals.inputTokens + d.totals.outputTokens,
  }));
  return [{ label: 'tokens', points }];
}
