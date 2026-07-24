import { useMemo, useState } from 'react';
import './Receipts.css';
import { Badge, RichViewer, type BadgeTone } from './components';
import type { RunLogRecord } from '../../shared/ipc-contract';
import { receiptMarkdown } from '../../shared/receipt-markdown';
import { formatCostUsd, formatTokens, type RunUsage } from '../../shared/run-telemetry';
import { formatElapsed } from '../../shared/headless-feed';

interface ReceiptsViewProps {
  /** The Project's Run log — every finished Run captured so far. */
  records: RunLogRecord[];
}

/** A short, human label for a Run outcome (mirrors Map's Run-log card, which
 *  this view replaces — issue 180). */
function outcomeLabel(outcome: RunLogRecord['outcome']): string {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'needs-verification':
      return 'needs verification';
    case 'blocked':
      return 'blocked';
    default:
      return 'unparsed';
  }
}

/** The shared-Badge tone for a Run outcome. */
function outcomeTone(outcome: RunLogRecord['outcome']): BadgeTone {
  switch (outcome) {
    case 'completed':
      return 'green';
    case 'needs-verification':
      return 'amber';
    case 'blocked':
      return 'red';
    default:
      return 'neutral';
  }
}

/** Titles usually start with "NN — "; drop that since the row shows the id. */
function stripId(title: string): string {
  return title.replace(/^\d+\s*[—-]\s*/, '');
}

/**
 * The per-receipt usage strip (issue 210) — tokens · duration · cost · model,
 * read straight off the record's `usage` (stamped by the AFK usage hook for CLI
 * drains, or by main's in-app bridge). Renders only the stats that are present,
 * and nothing at all when a Receipt carries no telemetry — so it never shows an
 * empty shell on a drain run without the hook.
 */
function UsageStrip({ usage }: { usage: RunUsage }): JSX.Element | null {
  const totalTokens =
    usage.inputTokens !== null || usage.outputTokens !== null
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : null;
  const stats: { label: string; value: string; cost?: boolean }[] = [];
  if (totalTokens !== null) stats.push({ label: 'tokens', value: formatTokens(totalTokens) });
  if (usage.durationMs !== null) stats.push({ label: 'duration', value: formatElapsed(usage.durationMs) });
  if (usage.costUsd !== null) stats.push({ label: 'cost', value: formatCostUsd(usage.costUsd), cost: true });
  if (stats.length === 0 && usage.tier === null) return null;
  return (
    <div className="receipts__usage">
      {stats.map((s) => (
        <div key={s.label} className="receipts__usage-stat">
          <span className="receipts__usage-label">{s.label}</span>
          <span className={`receipts__usage-value${s.cost ? ' receipts__usage-value--cost' : ''}`}>
            {s.value}
          </span>
        </div>
      ))}
      {usage.tier !== null && <span className="receipts__usage-tier">{usage.tier}</span>}
    </div>
  );
}

/**
 * The Receipts tab (issue 180, ADR-0023) — browse finished Runs, newest first,
 * and read a selected Run's Receipt through the shared rich viewer (issue
 * 179), diagrams live. Replaces Map's inline Run-log strip (issue 34/159):
 * one review surface instead of two, and a Receipt's "How it works" mermaid
 * fence — previously dumped as raw text — now renders as a real diagram.
 */
export function ReceiptsView({ records }: ReceiptsViewProps): JSX.Element {
  const sorted = useMemo(
    () =>
      [...records].sort(
        (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
      ),
    [records],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((r) => r.id === selectedId) ?? sorted[0] ?? null;

  return (
    <div className="receipts">
      <div className="receipts__list">
        <div className="receipts__list-head">
          Receipts · {sorted.length} finished Run{sorted.length === 1 ? '' : 's'}
        </div>
        {sorted.length === 0 && (
          <p className="receipts__empty">
            No finished Runs yet — they appear here once a Run completes.
          </p>
        )}
        <ul className="receipts__items">
          {sorted.map((r) => {
            const idLabel = r.issueId !== null ? String(r.issueId).padStart(2, '0') : '—';
            const heading = r.title ? stripId(r.title) : (r.issue ?? r.slug ?? 'Run');
            const cost = r.usage?.costUsd ?? null;
            return (
              <li key={r.id}>
                <button
                  className={`receipts__item${selected?.id === r.id ? ' receipts__item--active' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                  title={heading}
                >
                  <Badge tone={outcomeTone(r.outcome)}>{outcomeLabel(r.outcome)}</Badge>
                  <span className="receipts__item-id">{idLabel}</span>
                  <span className="receipts__item-title">{heading}</span>
                  {cost !== null && (
                    <span className="receipts__item-cost">{formatCostUsd(cost)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="receipts__detail">
        {selected === null ? (
          <p className="receipts__empty">Select a Run to read its Receipt.</p>
        ) : (
          <>
            {selected.usage !== null && <UsageStrip usage={selected.usage} />}
            <RichViewer text={receiptMarkdown(selected)} />
          </>
        )}
      </div>
    </div>
  );
}
