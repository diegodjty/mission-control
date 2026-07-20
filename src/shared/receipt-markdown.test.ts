import { describe, expect, it } from 'vitest';
import { receiptMarkdown } from './receipt-markdown';
import type { RunLogRecord } from './ipc-contract';

function record(overrides: Partial<RunLogRecord>): RunLogRecord {
  return {
    id: 'receipt:180-receipts-tab:2026-07-20T00:00:00Z',
    capturedAt: '2026-07-20T00:00:00Z',
    slug: '180-receipts-tab',
    title: null,
    usage: null,
    issue: null,
    issueId: 180,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed',
    ...overrides,
  };
}

describe('receiptMarkdown', () => {
  it('renders a completed record as a heading plus its named sections, in order', () => {
    const md = receiptMarkdown(
      record({
        whatChanged: 'The app can now do X.',
        tryIt: 'Open the app and click Y.',
        verified: 'npm run test green.',
        bookkeeping: 'Touched Foo.tsx.',
        docDrift: 'None.',
      }),
    );
    expect(md).toBe(
      [
        '## Completed issue 180 — 180-receipts-tab',
        '**What changed.** The app can now do X.',
        '**Try it yourself.** Open the app and click Y.',
        '**Verified.** npm run test green.',
        '**Bookkeeping.** Touched Foo.tsx.',
        '**Doc drift.** None.',
      ].join('\n\n'),
    );
  });

  it('carries a mermaid fence embedded in Doc drift through untouched (the "How it works" gap)', () => {
    const docDrift = [
      'None.',
      '',
      '**How it works.**',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '- a bullet',
    ].join('\n');
    const md = receiptMarkdown(record({ docDrift }));
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('A --> B');
  });

  it('omits absent sections instead of rendering an empty label', () => {
    const md = receiptMarkdown(record({ whatChanged: 'Only this section.' }));
    expect(md).toBe(['## Completed issue 180 — 180-receipts-tab', '**What changed.** Only this section.'].join('\n\n'));
  });

  it('renders a blocked record as its heading plus the free-form detail body, no section labels', () => {
    const md = receiptMarkdown(
      record({
        outcome: 'blocked',
        whatChanged: null,
        detail: 'No AFK-eligible work available. Issue 62 is wip.',
      }),
    );
    expect(md).toBe(
      [
        '## Blocked — issue 180 — 180-receipts-tab',
        'No AFK-eligible work available. Issue 62 is wip.',
      ].join('\n\n'),
    );
  });

  it('renders a needs-verification record with its own heading and detail body', () => {
    const md = receiptMarkdown(
      record({
        outcome: 'needs-verification',
        detail: 'Ready for manual verification — steps: 1. Do X. 2. Confirm Y.',
      }),
    );
    expect(md.startsWith('## Ready for manual verification — issue 180 — 180-receipts-tab')).toBe(
      true,
    );
    expect(md).toContain('Ready for manual verification — steps');
  });

  it('falls back to just the issue id when no slug is known', () => {
    const md = receiptMarkdown(record({ slug: null, whatChanged: 'x' }));
    expect(md.split('\n\n')[0]).toBe('## Completed issue 180');
  });

  it('falls back to the record.issue descriptor when issueId and slug are both absent', () => {
    const md = receiptMarkdown(record({ issueId: null, slug: null, issue: 'mystery — thing' }));
    expect(md.split('\n\n')[0]).toBe('## Completed issue mystery — thing');
  });
});
