import { describe, expect, it } from 'vitest';
import {
  extractRunUsage,
  timeOnlyUsage,
  sumRunUsage,
  formatTokens,
  formatCostUsd,
  type RunUsage,
} from './run-telemetry';
import type { TerminalResult } from './headless-feed';

function result(over: Partial<TerminalResult> = {}): TerminalResult {
  return {
    subtype: 'success',
    isError: false,
    text: 'done',
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 5 },
    raw: { total_cost_usd: 0.02, num_turns: 3 },
    ...over,
  };
}

describe('extractRunUsage', () => {
  it('maps a result payload to record fields (issue 143 AC1)', () => {
    const usage = extractRunUsage(result(), 12_000, 'sonnet');
    expect(usage).toEqual({
      durationMs: 12_000,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheCreationTokens: null,
      costUsd: 0.02,
      tier: 'sonnet',
    });
  });

  it('tolerates a null result but keeps the measured duration', () => {
    const usage = extractRunUsage(null, 4_000, 'opus');
    expect(usage).toEqual({
      durationMs: 4_000,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      tier: 'opus',
    });
  });

  it('returns null when there is truly nothing to stamp', () => {
    expect(extractRunUsage(null, null)).toBeNull();
  });

  it('ignores non-numeric usage fields rather than throwing', () => {
    const usage = extractRunUsage(
      result({ usage: { input_tokens: 'lots' }, raw: { total_cost_usd: 'free' } }),
      1000,
    );
    expect(usage).toEqual({
      durationMs: 1000,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      tier: null,
    });
  });
});

describe('timeOnlyUsage', () => {
  it('carries a duration with every token/cost field null (Pane Run asymmetry)', () => {
    expect(timeOnlyUsage(5000)).toEqual({
      durationMs: 5000,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      tier: null,
    });
  });

  it('is null when there is no duration at all', () => {
    expect(timeOnlyUsage(null)).toBeNull();
  });
});

describe('sumRunUsage', () => {
  it('sums totals correctly across mixed Runs (headless with usage, Pane time-only)', () => {
    const headless: RunUsage = {
      durationMs: 10_000,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      costUsd: 0.02,
      tier: 'sonnet',
    };
    const pane = timeOnlyUsage(3_000);
    const totals = sumRunUsage([headless, pane, null]);
    expect(totals).toEqual({
      runsWithUsage: 2,
      totalRuns: 3,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      costUsd: 0.02,
      durationMs: 13_000,
    });
  });

  it('is all zero for an empty or all-null set', () => {
    expect(sumRunUsage([])).toEqual({
      runsWithUsage: 0,
      totalRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
    });
    expect(sumRunUsage([null, undefined]).runsWithUsage).toBe(0);
  });
});

describe('formatTokens / formatCostUsd', () => {
  it('formats tokens under and over the k threshold', () => {
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(1234)).toBe('1.2k');
  });

  it('formats cost with extra precision below a cent', () => {
    expect(formatCostUsd(1.234)).toBe('$1.23');
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0)).toBe('$0.00');
  });
});
