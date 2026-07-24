import { describe, it, expect } from 'vitest';
import {
  contentFingerprint,
  isReceiptPath,
  shouldIngest,
  toReceiptRunLogRecord,
} from './receipt-ingest';

const RECEIPT = `---
issue: 56
slug: receipt-capture-edge-watch-debounce-dedupe
outcome: completed
finished: 2026-07-03T10:00:00Z
---

## Completed issue 56 — receipt-capture-edge-watch-debounce-dedupe

**What changed** — The capture edge now reads Receipts.

**Try it yourself** — Write a Receipt file and watch the card appear.

**Verified** — Watcher integration test.

**Bookkeeping** — files touched.

**Doc drift** — none.
`;

describe('isReceiptPath', () => {
  it('accepts a .md file directly under completions/', () => {
    expect(isReceiptPath('completions/56-some-slug.md')).toBe(true);
  });

  it('rejects issue files at the issues/ root (the backlog itself)', () => {
    expect(isReceiptPath('56-some-slug.md')).toBe(false);
  });

  it('rejects nested paths, non-md files, dotfiles, and null', () => {
    expect(isReceiptPath('completions/deep/56-x.md')).toBe(false);
    expect(isReceiptPath('completions/notes.txt')).toBe(false);
    expect(isReceiptPath('completions/.56-x.md.swp')).toBe(false);
    expect(isReceiptPath('completions')).toBe(false);
    expect(isReceiptPath(null)).toBe(false);
  });

  it('tolerates Windows-style separators', () => {
    expect(isReceiptPath('completions\\56-some-slug.md')).toBe(true);
  });
});

describe('toReceiptRunLogRecord', () => {
  it('maps a declared Receipt to a RunLogRecord keyed by issue + finished', () => {
    const rec = toReceiptRunLogRecord(RECEIPT, '56-receipt-capture-edge-watch-debounce-dedupe.md', '2026-07-03T10:00:05Z');
    expect(rec.id).toBe('receipt:56-receipt-capture-edge-watch-debounce-dedupe:2026-07-03T10:00:00Z');
    expect(rec.issueId).toBe(56);
    expect(rec.slug).toBe('56-receipt-capture-edge-watch-debounce-dedupe');
    expect(rec.outcome).toBe('completed');
    expect(rec.capturedAt).toBe('2026-07-03T10:00:05Z');
    expect(rec.whatChanged).toContain('capture edge now reads Receipts');
    expect(rec.tryIt).toContain('watch the card appear');
    expect(rec.title).toBeNull();
  });

  it('falls back to the file name for identity when frontmatter is missing', () => {
    const rec = toReceiptRunLogRecord('just some text', '07-fix-thing.md', '2026-07-03T10:00:05Z');
    expect(rec.issueId).toBe(7);
    expect(rec.slug).toBe('07-fix-thing');
    // No finished stamp declared: the id still exists, marked undated.
    expect(rec.id).toBe('receipt:07-fix-thing:undated');
  });

  it('a re-run (same file, new finished stamp) yields a DIFFERENT record id', () => {
    const a = toReceiptRunLogRecord(RECEIPT, '56-x.md', '2026-07-03T10:00:05Z');
    const b = toReceiptRunLogRecord(
      RECEIPT.replace('2026-07-03T10:00:00Z', '2026-07-03T11:30:00Z'),
      '56-x.md',
      '2026-07-03T11:30:05Z',
    );
    expect(a.id).not.toBe(b.id);
  });
});

describe('shouldIngest (dedupe by issue + finished)', () => {
  const id = 'receipt:56-x:2026-07-03T10:00:00Z';
  const fp = contentFingerprint(RECEIPT);

  it('ingests a never-seen id', () => {
    expect(shouldIngest(new Map(), id, fp)).toBe(true);
  });

  it('drops a re-scan of the same id + same content', () => {
    expect(shouldIngest(new Map([[id, fp]]), id, fp)).toBe(false);
  });

  it('drops an id seeded from the persisted log (restart), content unknown', () => {
    expect(shouldIngest(new Map([[id, null]]), id, fp)).toBe(false);
  });

  it('re-ingests when the same id arrives with CHANGED content (supersede)', () => {
    expect(shouldIngest(new Map([[id, contentFingerprint('older draft')]]), id, fp)).toBe(true);
  });
});

describe('contentFingerprint', () => {
  it('is stable for equal text and differs across texts', () => {
    expect(contentFingerprint(RECEIPT)).toBe(contentFingerprint(RECEIPT));
    expect(contentFingerprint(RECEIPT)).not.toBe(contentFingerprint(RECEIPT + ' '));
  });
});

describe('toReceiptRunLogRecord — usage frontmatter (issue 210)', () => {
  it('populates the record usage from a Receipt that carries usage_* keys', () => {
    const receipt = `---
issue: 56
slug: receipt-capture-edge
outcome: completed
finished: 2026-07-03T10:00:00Z
usage_input_tokens: 100
usage_output_tokens: 20
usage_duration_ms: 5000
usage_cost_usd: 0.12
usage_tier: sonnet
---

## Completed issue 56 — receipt-capture-edge

**What changed** — x.`;
    const rec = toReceiptRunLogRecord(receipt, '56-receipt-capture-edge.md', '2026-07-23T00:00:00Z');
    expect(rec.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, durationMs: 5000, costUsd: 0.12, tier: 'sonnet' });
  });

  it('leaves usage null for a Receipt with no usage_* keys (the pre-hook shape)', () => {
    const rec = toReceiptRunLogRecord(RECEIPT, '56-receipt-capture-edge-watch-debounce-dedupe.md', '2026-07-23T00:00:00Z');
    expect(rec.usage).toBeNull();
  });
});
