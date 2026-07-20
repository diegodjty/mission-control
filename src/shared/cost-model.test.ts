import { describe, expect, it } from 'vitest';
import {
  drainTotals,
  issueCostBars,
  parseDrainReason,
  parseDrainRunKeys,
  tokenBreakdownBars,
  tokenTrendSeries,
  costTrendSeries,
  type DrainTotal,
} from './cost-model';
import type { RunLogRecord } from './ipc-contract';
import type { JournalFile } from './attention-hub-model';

function record(over: Partial<RunLogRecord>): RunLogRecord {
  return {
    issue: null,
    issueId: null,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed',
    id: 'r1',
    capturedAt: '2026-07-18T00:00:00.000Z',
    slug: null,
    title: null,
    usage: null,
    ...over,
  };
}

describe('issueCostBars', () => {
  it('is empty when no record carries a cost', () => {
    expect(issueCostBars([record({ slug: 'a' })])).toEqual([]);
  });

  it('sorts descending by cost, labeled by slug', () => {
    const records = [
      record({ slug: '10-a', usage: { durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 1, tier: null } }),
      record({ slug: '11-b', usage: { durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 5, tier: null } }),
    ];
    expect(issueCostBars(records)).toEqual([
      { label: '11-b', value: 5 },
      { label: '10-a', value: 1 },
    ]);
  });

  it('falls back to "issue N" when there is no slug', () => {
    const records = [
      record({ issueId: 42, usage: { durationMs: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 2, tier: null } }),
    ];
    expect(issueCostBars(records)).toEqual([{ label: 'issue 42', value: 2 }]);
  });

  it('caps at the given limit, keeping the most expensive', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record({
        slug: `${i}-x`,
        usage: { durationMs: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: i, tier: null },
      }),
    );
    expect(issueCostBars(records, 2).map((b) => b.label)).toEqual(['4-x', '3-x']);
  });
});

describe('tokenBreakdownBars', () => {
  it('is empty when no record carries any token count', () => {
    expect(tokenBreakdownBars([record({ slug: 'a' })])).toEqual([]);
  });

  it('excludes a record whose usage is undefined (not null) without throwing — pre-143 logs', () => {
    const preTelemetryRecord = record({ slug: 'legacy' });
    delete (preTelemetryRecord as { usage?: unknown }).usage;
    expect(() => tokenBreakdownBars([preTelemetryRecord])).not.toThrow();
    expect(tokenBreakdownBars([preTelemetryRecord])).toEqual([]);
  });

  it('excludes a record whose usage fields are all undefined without throwing', () => {
    const allUndefinedUsage = record({
      slug: 'all-undefined',
      usage: {
        durationMs: undefined as unknown as number | null,
        inputTokens: undefined as unknown as number | null,
        outputTokens: undefined as unknown as number | null,
        cacheReadTokens: undefined as unknown as number | null,
        cacheCreationTokens: undefined as unknown as number | null,
        costUsd: undefined as unknown as number | null,
        tier: null,
      },
    });
    expect(() => tokenBreakdownBars([allUndefinedUsage])).not.toThrow();
    expect(tokenBreakdownBars([allUndefinedUsage])).toEqual([]);
  });

  it('builds one stacked row per record, segmented by token kind, top-N by total tokens', () => {
    const records = [
      record({
        slug: 'small',
        usage: { durationMs: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, tier: null },
      }),
      record({
        slug: 'big',
        usage: { durationMs: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100, costUsd: 0.5, tier: null },
      }),
    ];
    const bars = tokenBreakdownBars(records, 1);
    expect(bars).toHaveLength(1);
    expect(bars[0].label).toBe('big');
    expect(bars[0].segments).toEqual([
      { label: 'input', value: 1000 },
      { label: 'output', value: 500 },
      { label: 'cache read', value: 200 },
      { label: 'cache creation', value: 100 },
    ]);
  });
});

describe('parseDrainRunKeys', () => {
  it('reads the "## Runs" section bullet names, slug or "issue N"', () => {
    const content = [
      '# Drain journal — 2026-07-18',
      '',
      '## Runs',
      '',
      '- 170-timeout-kill: completed — did a thing (sonnet · 1.2k in / 340 out tok · $0.02 · 3:12)',
      '- issue 42: blocked — stuck',
      '',
      '## Totals',
      '',
      '- 2/2 Runs with telemetry — 1.2k in / 340 out tok · $0.02 · 3:12',
    ].join('\n');
    expect(parseDrainRunKeys(content)).toEqual(['170-timeout-kill', 'issue 42']);
  });

  it('returns [] when there is no Runs section', () => {
    expect(parseDrainRunKeys('# Drain journal — 2026-07-18\n')).toEqual([]);
  });
});

describe('parseDrainReason', () => {
  it('reads the "- Reason:" line', () => {
    const content = '# Drain journal\n\n- Ended: 2026-07-18T00:00:00.000Z\n- Reason: Stopped: hit the ceiling.\n';
    expect(parseDrainReason(content)).toBe('Stopped: hit the ceiling.');
  });

  it('degrades to empty string when absent', () => {
    expect(parseDrainReason('# Drain journal\n')).toBe('');
  });
});

describe('drainTotals', () => {
  const records: RunLogRecord[] = [
    record({
      slug: '170-timeout-kill',
      usage: { durationMs: 1000, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, tier: null },
    }),
    record({
      issueId: 42,
      usage: { durationMs: 2000, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.2, tier: null },
    }),
  ];

  it('matches each journal drain\'s Runs by slug or issue id and sums their real usage', () => {
    const files: JournalFile[] = [
      {
        name: '2026-07-18.md',
        content: '- Reason: done\n\n## Runs\n\n- 170-timeout-kill: completed\n- issue 42: completed\n',
      },
    ];
    const totals = drainTotals(files, records);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ date: '2026-07-18', reason: 'done', fileName: '2026-07-18.md' });
    expect(totals[0].totals.costUsd).toBeCloseTo(0.3);
    expect(totals[0].totals.inputTokens).toBe(300);
    expect(totals[0].totals.runsWithUsage).toBe(2);
  });

  it('sorts ascending by date (oldest drain first)', () => {
    const files: JournalFile[] = [
      { name: '2026-07-19.md', content: '## Runs\n\n- issue 42: completed\n' },
      { name: '2026-07-17.md', content: '## Runs\n\n- 170-timeout-kill: completed\n' },
    ];
    expect(drainTotals(files, records).map((d) => d.date)).toEqual(['2026-07-17', '2026-07-19']);
  });

  it('skips run keys with no matching Run-log record without throwing', () => {
    const files: JournalFile[] = [{ name: '2026-07-18.md', content: '## Runs\n\n- unknown-slug: completed\n' }];
    expect(drainTotals(files, records)[0].totals.runsWithUsage).toBe(0);
  });
});

describe('costTrendSeries / tokenTrendSeries', () => {
  const drains: DrainTotal[] = [
    { date: '2026-07-17', reason: '', fileName: 'a.md', totals: { runsWithUsage: 1, totalRuns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, durationMs: 0 } },
    { date: '2026-07-18', reason: '', fileName: 'b.md', totals: { runsWithUsage: 1, totalRuns: 1, inputTokens: 20, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.4, durationMs: 0 } },
  ];

  it('costTrendSeries plots cost per drain in order, one point per drain', () => {
    const series = costTrendSeries(drains);
    expect(series).toHaveLength(1);
    expect(series[0].points).toEqual([
      { x: 0, y: 0.1 },
      { x: 1, y: 0.4 },
    ]);
  });

  it('tokenTrendSeries plots total tokens (input+output) per drain', () => {
    const series = tokenTrendSeries(drains);
    expect(series[0].points).toEqual([
      { x: 0, y: 15 },
      { x: 1, y: 35 },
    ]);
  });
});
