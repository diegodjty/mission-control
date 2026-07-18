import { describe, it, expect } from 'vitest';
import {
  CORE_MEMORY_CHAR_CAP,
  CORE_MEMORY_LABEL,
  CORE_TRUNCATION_MARKER,
  buildJournalEntry,
  capCoreMemory,
  coreMemorySection,
  isNotableDrainActivity,
  journalFileName,
} from './workbench-memory';
import type { RunLogRecord } from './ipc-contract';

function record(over: Partial<RunLogRecord>): RunLogRecord {
  return {
    id: `receipt:${over.slug ?? 'xx-slug'}:2026-07-04T10:00:00.000Z`,
    capturedAt: '2026-07-04T10:00:00.000Z',
    slug: '02-second-step',
    title: 'Second step',
    issue: '02 — second-step',
    issueId: 2,
    whatChanged: 'The app now does the thing.',
    tryIt: 'Run it.',
    verified: 'Exercised the thing.',
    bookkeeping: 'files',
    docDrift: 'none',
    detail: null,
    outcome: 'completed',
    usage: null,
    ...over,
  };
}

describe('capCoreMemory', () => {
  it('passes content at/under the ~1.5k-token cap through verbatim', () => {
    const content = 'a'.repeat(CORE_MEMORY_CHAR_CAP);
    expect(capCoreMemory(content)).toEqual({ text: content, truncated: false });
  });

  it('cuts oversized content at the cap with an explicit truncation marker', () => {
    const capped = capCoreMemory('b'.repeat(CORE_MEMORY_CHAR_CAP + 500));
    expect(capped.truncated).toBe(true);
    expect(capped.text).toContain(CORE_TRUNCATION_MARKER);
    // Bounded: the capped body plus the marker line, nothing unbounded.
    expect(capped.text.length).toBeLessThanOrEqual(
      CORE_MEMORY_CHAR_CAP + CORE_TRUNCATION_MARKER.length + 1,
    );
  });
});

describe('coreMemorySection', () => {
  it('labels the content as project memory from CORE.md', () => {
    const section = coreMemorySection('Diego prefers self-hosted tools.');
    expect(section).toContain(CORE_MEMORY_LABEL);
    expect(section).toContain('Diego prefers self-hosted tools.');
  });

  it('injects NOTHING for a missing/empty/whitespace CORE (or junk input)', () => {
    expect(coreMemorySection(null)).toBe('');
    expect(coreMemorySection(undefined)).toBe('');
    expect(coreMemorySection('')).toBe('');
    expect(coreMemorySection('   \n\t  ')).toBe('');
    expect(coreMemorySection(42)).toBe('');
  });

  it('caps oversized content with the truncation marker', () => {
    const section = coreMemorySection('c'.repeat(CORE_MEMORY_CHAR_CAP * 3));
    expect(section).toContain(CORE_TRUNCATION_MARKER);
    expect(section.length).toBeLessThan(CORE_MEMORY_CHAR_CAP * 2);
  });
});

describe('journalFileName', () => {
  it('names the entry after the drain-end date', () => {
    expect(journalFileName('2026-07-04T18:30:00.000Z', [])).toBe('2026-07-04.md');
  });

  it('gives a second drain the same day its OWN entry — no clobber', () => {
    expect(journalFileName('2026-07-04T20:00:00.000Z', ['2026-07-04.md'])).toBe(
      '2026-07-04-2.md',
    );
    expect(
      journalFileName('2026-07-04T22:00:00.000Z', ['2026-07-04.md', '2026-07-04-2.md']),
    ).toBe('2026-07-04-3.md');
  });

  it('ignores other days\' entries and degrades a junk timestamp to undated', () => {
    expect(journalFileName('2026-07-04T08:00:00.000Z', ['2026-07-03.md'])).toBe(
      '2026-07-04.md',
    );
    expect(journalFileName('not a date', [])).toBe('undated.md');
  });
});

describe('buildJournalEntry', () => {
  it('names every Run with its declared outcome, one line each', () => {
    const entry = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'Drain complete: nothing eligible remains.',
      records: [
        record({}),
        record({
          id: 'receipt:05-manual-check:x',
          slug: '05-manual-check',
          issueId: 5,
          outcome: 'needs-verification',
          whatChanged: null,
          detail: 'Ready for manual verification: click the button.',
        }),
        record({
          id: 'receipt:04-independent:x',
          slug: '04-independent',
          issueId: 4,
          outcome: 'blocked',
          whatChanged: null,
          detail: 'Blocked: acceptance criteria ambiguous.',
        }),
      ],
    });
    expect(entry).toContain('# Drain journal — 2026-07-04');
    expect(entry).toContain('- Reason: Drain complete: nothing eligible remains.');
    expect(entry).toContain('- 02-second-step: completed — The app now does the thing.');
    expect(entry).toContain(
      '- 05-manual-check: parked (needs manual verification) — Ready for manual verification: click the button.',
    );
    expect(entry).toContain('- 04-independent: blocked — Blocked: acceptance criteria ambiguous.');
    // Sorted by issue id, so the entry reads like the backlog.
    expect(entry.indexOf('02-second-step')).toBeLessThan(entry.indexOf('04-independent'));
    expect(entry.indexOf('04-independent')).toBeLessThan(entry.indexOf('05-manual-check'));
  });

  it('carries a per-Run telemetry suffix and a per-drain totals line (issue 143)', () => {
    const entry = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'done',
      records: [
        record({
          id: 'receipt:02-second-step:x',
          usage: {
            durationMs: 192_000,
            inputTokens: 1200,
            outputTokens: 340,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.02,
            tier: 'sonnet',
          },
        }),
        record({
          id: 'receipt:03-pane-run:x',
          slug: '03-pane-run',
          issueId: 3,
          usage: {
            durationMs: 60_000,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            costUsd: null,
            tier: null,
          },
        }),
      ],
    });
    expect(entry).toContain(
      '- 02-second-step: completed — The app now does the thing. (sonnet · 1.2k in / 340 out tok · $0.02 · 3:12)',
    );
    // Pane Run: time-only — no tier, no tokens, no cost.
    expect(entry).toContain('- 03-pane-run: completed — The app now does the thing. (1:00)');
    expect(entry).toContain('## Totals');
    expect(entry).toContain('- 2/2 Runs with telemetry — 1.2k in / 340 out tok · $0.02 · 4:12');
  });

  it('omits the Totals section entirely when nothing carries telemetry', () => {
    const entry = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'done',
      records: [record({})],
    });
    expect(entry).not.toContain('## Totals');
  });

  it('flags real doc drift and omits the section when every Run says none', () => {
    const drifted = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'done',
      records: [record({ docDrift: 'PRD says X; the code holds Y.' })],
    });
    expect(drifted).toContain('## Doc drift');
    expect(drifted).toContain('- 02-second-step: PRD says X; the code holds Y.');

    const clean = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'done',
      records: [record({ docDrift: 'none' })],
    });
    expect(clean).not.toContain('## Doc drift');
  });

  it('records notable events and skips unknown-outcome records', () => {
    const entry = buildJournalEntry({
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'stopped by you',
      records: [record({ outcome: 'unknown', id: 'ghost' })],
      notables: ['Adopted stray Receipt(s) on main: 06-parallel-a.md', '   '],
    });
    expect(entry).toContain('- (no Run reported a Receipt this drain)');
    expect(entry).toContain('## Notable events');
    expect(entry).toContain('- Adopted stray Receipt(s) on main: 06-parallel-a.md');
    expect(entry).not.toContain('ghost');
  });

  it('degrades malformed records instead of throwing', () => {
    const entry = buildJournalEntry({
      endedAt: 'junk',
      reason: '',
      records: [record({ slug: null, issueId: null, whatChanged: null, detail: null })],
    });
    expect(entry).toContain('- Reason: (none given)');
    expect(entry).toContain('- unknown issue: completed');
  });
});

describe('isNotableDrainActivity', () => {
  it('matches adoption and finished-without-receipt notes, nothing else', () => {
    expect(isNotableDrainActivity('receipt-adopt:solo:06.md')).toBe(true);
    expect(isNotableDrainActivity('finished-without-receipt:missing-receipt-4')).toBe(true);
    expect(isNotableDrainActivity('delivery:narrative:receipt:x')).toBe(false);
    expect(isNotableDrainActivity('doc-drift:receipt:x')).toBe(false);
  });
});
