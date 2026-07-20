import { useMemo } from 'react';
import './Cost.css';
import { BarChart, Card, LineChart, StackedBarChart } from './components';
import type { JournalFile } from '../../shared/attention-hub-model';
import type { RunLogRecord } from '../../shared/ipc-contract';
import {
  costTrendSeries,
  drainTotals,
  issueCostBars,
  tokenBreakdownBars,
  tokenTrendSeries,
} from '../../shared/cost-model';
import { formatCostUsd, formatTokens } from '../../shared/run-telemetry';
import { formatElapsed } from '../../shared/headless-feed';

interface CostViewProps {
  /** The Project's Run log — every finished Run captured so far (issue 34). */
  records: RunLogRecord[];
  /** The Project's raw drain-journal entries (issue 181's only drain grouping source). */
  journals: JournalFile[];
}

/**
 * The Cost tab (issue 181, ADR-0023) — Run telemetry (issue 143, fixed by
 * 177) as charts, in-app: the same read the `/cost` skill's interim artifact
 * makes, native. Per-issue cost bars and the token breakdown read the
 * already-loaded Run log directly (full telemetry precision); per-drain
 * totals and the trend group those SAME records by the journal's `## Runs`
 * membership (issue 181, cost-model.ts) — the only place a drain's boundary
 * exists on disk.
 */
export function CostView({ records, journals }: CostViewProps): JSX.Element {
  const costBars = useMemo(() => issueCostBars(records), [records]);
  const tokenBars = useMemo(() => tokenBreakdownBars(records, 8), [records]);
  const drains = useMemo(() => drainTotals(journals, records), [journals, records]);
  const drainsWithTelemetry = useMemo(
    () => drains.filter((d) => d.totals.runsWithUsage > 0),
    [drains],
  );

  const hasTelemetry = costBars.length > 0 || tokenBars.length > 0;

  if (!hasTelemetry) {
    return (
      <div className="cost">
        <p className="cost__empty">
          No Run telemetry captured yet. Telemetry only populates from drains run after the
          issue-177 fix — run a drain on the 177-fixed build to see charts here.
        </p>
      </div>
    );
  }

  return (
    <div className="cost">
      <Card className="cost__section">
        <h2 className="cost__title">Cost per issue</h2>
        <BarChart data={costBars} formatValue={formatCostUsd} width={480} />
      </Card>

      {tokenBars.length > 0 && (
        <Card className="cost__section">
          <h2 className="cost__title">Token breakdown — top issues</h2>
          <StackedBarChart data={tokenBars} width={480} />
        </Card>
      )}

      <Card className="cost__section">
        <h2 className="cost__title">Per-drain totals</h2>
        {drains.length === 0 ? (
          <p className="cost__empty">No drain journal entries yet.</p>
        ) : (
          <ul className="cost__drains">
            {drains.map((d) => (
              <li key={d.fileName} className="cost__drain">
                <span className="cost__drain-date">{d.date}</span>
                <span className="cost__drain-reason" title={d.reason}>
                  {d.reason || '(no reason given)'}
                </span>
                <span className="cost__drain-stat">
                  {d.totals.runsWithUsage}/{d.totals.totalRuns} Runs
                </span>
                <span className="cost__drain-stat">
                  {formatTokens(d.totals.inputTokens)} in / {formatTokens(d.totals.outputTokens)} out
                </span>
                <span className="cost__drain-stat">{formatCostUsd(d.totals.costUsd)}</span>
                <span className="cost__drain-stat">{formatElapsed(d.totals.durationMs)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {drainsWithTelemetry.length >= 2 && (
        <Card className="cost__section">
          <h2 className="cost__title">Trend — cost &amp; tokens per drain</h2>
          <div className="cost__trend-row">
            <div>
              <h3 className="cost__subtitle">Cost</h3>
              <LineChart series={costTrendSeries(drainsWithTelemetry)} width={360} height={140} />
            </div>
            <div>
              <h3 className="cost__subtitle">Tokens</h3>
              <LineChart series={tokenTrendSeries(drainsWithTelemetry)} width={360} height={140} />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
