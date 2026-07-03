import { describe, expect, it } from 'vitest';
import {
  detectCrossRunOverlap,
  describeDocDrift,
  extractDocDrift,
  extractSeams,
  groupDocDrift,
  hasSynthesis,
  proposeDocDriftAmendment,
  recordSeams,
  renderCrossRunSynthesis,
  reportsDocDrift,
  synthesizeAcrossRuns,
  type RunFinding,
} from './dispatcher-synthesis';
import type { RunLogRecord } from './ipc-contract';

/** A fully-null Run finding; spread over to set only the fields a test needs. */
function finding(over: Partial<RunFinding> & { id: string }): RunFinding {
  return {
    issueId: null,
    issue: null,
    whatChanged: null,
    bookkeeping: null,
    verified: null,
    docDrift: null,
    detail: null,
    ...over,
  };
}

describe('reportsDocDrift', () => {
  it('is false for absent, empty, or "none"-marker drift lines', () => {
    expect(reportsDocDrift({ docDrift: null })).toBe(false);
    expect(reportsDocDrift({ docDrift: '   ' })).toBe(false);
    expect(reportsDocDrift({ docDrift: 'none' })).toBe(false);
    expect(reportsDocDrift({ docDrift: 'None.' })).toBe(false);
    expect(reportsDocDrift({ docDrift: 'N/A' })).toBe(false);
    expect(reportsDocDrift({ docDrift: 'nothing' })).toBe(false);
    expect(reportsDocDrift({ docDrift: '—' })).toBe(false);
  });

  it('is true for a real contradiction', () => {
    expect(
      reportsDocDrift({
        docDrift: 'PRD §data-retention assumes 13 months; LOGGED holds ~11 days.',
      }),
    ).toBe(true);
  });
});

describe('extractDocDrift', () => {
  it('keeps only the Runs that actually report drift, in input order', () => {
    const records = [
      finding({ id: 'a', issueId: 7, issue: '7 — foo', docDrift: 'PRD says X; reality is Y.' }),
      finding({ id: 'b', issueId: 8, docDrift: 'none' }),
      finding({ id: 'c', issueId: 30, docDrift: 'Field `retries` does not exist.' }),
    ];
    const entries = extractDocDrift(records);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      runId: 'a',
      issueId: 7,
      issue: '7 — foo',
      text: 'PRD says X; reality is Y.',
    });
    expect(entries[1].issueId).toBe(30);
  });

  it('trims the drift body', () => {
    const [entry] = extractDocDrift([finding({ id: 'a', docDrift: '  drift here  ' })]);
    expect(entry.text).toBe('drift here');
  });
});

describe('extractSeams', () => {
  it('pulls file paths (needs a slash — a bare word or version is not a path)', () => {
    const seams = extractSeams('touched src/shared/foo.ts and docs/PRD.md at v4.8');
    expect(seams).toContain('src/shared/foo.ts');
    expect(seams).toContain('docs/prd.md');
    expect(seams).not.toContain('v4.8');
    expect(seams).not.toContain('4.8');
  });

  it('pulls file-ish backticked tokens but not plain inline code words', () => {
    const seams = extractSeams('the `done` flag in `state.ts` and `pkg/mod`');
    expect(seams).toContain('state.ts');
    expect(seams).toContain('pkg/mod');
    expect(seams).not.toContain('done');
  });

  it('pulls named "… seam" phrases the way the PRD phrases them', () => {
    const seams = extractSeams('these Runs all hit the merge seam and the integration seam');
    expect(seams).toContain('merge seam');
    expect(seams).toContain('integration seam');
  });

  it('is empty and safe for null/empty input', () => {
    expect(extractSeams(null)).toEqual([]);
    expect(extractSeams('')).toEqual([]);
    expect(extractSeams('nothing seam-worthy here')).toEqual([]);
  });

  it('de-dupes across fields for one record', () => {
    const seams = recordSeams(
      finding({
        id: 'a',
        whatChanged: 'reworked the merge seam',
        bookkeeping: 'files: src/merge.ts; touched the merge seam again',
      }),
    );
    expect(seams.filter((s) => s === 'merge seam')).toHaveLength(1);
    expect(seams).toContain('src/merge.ts');
  });
});

describe('detectCrossRunOverlap', () => {
  it('surfaces a seam ≥2 distinct Runs touched, most-shared first', () => {
    const records = [
      finding({ id: 'a', issueId: 4, whatChanged: 'hardened the merge seam' }),
      finding({ id: 'b', issueId: 9, verified: 'ran against the merge seam' }),
      finding({ id: 'c', issueId: 12, bookkeeping: 'touched the merge seam' }),
      finding({ id: 'd', issueId: 5, bookkeeping: 'files: src/state.ts' }),
      finding({ id: 'e', issueId: 8, whatChanged: 'edited src/state.ts' }),
    ];
    const overlaps = detectCrossRunOverlap(records);
    expect(overlaps).toHaveLength(2);
    // merge seam (3 Runs) leads over src/state.ts (2 Runs).
    expect(overlaps[0].seam).toBe('merge seam');
    expect(overlaps[0].runs.map((r) => r.issueId)).toEqual([4, 9, 12]);
    expect(overlaps[1].seam).toBe('src/state.ts');
    expect(overlaps[1].runs.map((r) => r.issueId)).toEqual([5, 8]);
  });

  it('does not count one Run touching a seam twice as an overlap', () => {
    const records = [
      finding({ id: 'a', issueId: 4, whatChanged: 'the merge seam', bookkeeping: 'merge seam' }),
    ];
    expect(detectCrossRunOverlap(records)).toEqual([]);
  });

  it('is empty when Runs share nothing', () => {
    const records = [
      finding({ id: 'a', bookkeeping: 'src/a.ts' }),
      finding({ id: 'b', bookkeeping: 'src/b.ts' }),
    ];
    expect(detectCrossRunOverlap(records)).toEqual([]);
  });
});

describe('groupDocDrift', () => {
  it('groups doc-drift findings that co-reference the same seam (≥2)', () => {
    const entries = extractDocDrift([
      finding({ id: 'a', issueId: 7, docDrift: 'docs/PRD.md §retention is wrong' }),
      finding({ id: 'b', issueId: 30, docDrift: 'docs/PRD.md field does not exist' }),
      finding({ id: 'c', issueId: 31, docDrift: 'unrelated drift about src/x.ts' }),
    ]);
    const groups = groupDocDrift(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].seam).toBe('docs/prd.md');
    expect(groups[0].entries.map((e) => e.issueId)).toEqual([7, 30]);
  });

  it('returns nothing when each drift references a distinct seam', () => {
    const entries = extractDocDrift([
      finding({ id: 'a', docDrift: 'about src/a.ts' }),
      finding({ id: 'b', docDrift: 'about src/b.ts' }),
    ]);
    expect(groupDocDrift(entries)).toEqual([]);
  });
});

describe('synthesizeAcrossRuns + rendering', () => {
  const records: RunFinding[] = [
    finding({
      id: 'a',
      issueId: 4,
      whatChanged: 'hardened the merge seam',
      docDrift: 'docs/PRD.md §merge is stale',
    }),
    finding({
      id: 'b',
      issueId: 9,
      whatChanged: 'more work on the merge seam',
      docDrift: 'docs/PRD.md also omits the abort path',
    }),
    finding({ id: 'c', issueId: 8, docDrift: 'none' }),
  ];

  it('consolidates drift + overlap into one structure', () => {
    const synth = synthesizeAcrossRuns(records);
    expect(synth.docDrift).toHaveLength(2);
    expect(synth.overlaps.map((o) => o.seam)).toContain('merge seam');
    expect(synth.docDriftGroups.map((g) => g.seam)).toContain('docs/prd.md');
    expect(hasSynthesis(synth)).toBe(true);
  });

  it('renders one plain-text summary naming the Runs', () => {
    const text = renderCrossRunSynthesis(synthesizeAcrossRuns(records));
    expect(text).toContain('Cross-Run synthesis:');
    expect(text).toContain('Doc-drift flagged by 2 Run(s):');
    expect(text).toContain('issue 04');
    expect(text).toContain('issue 09');
    expect(text).toContain('merge seam');
    expect(text).toContain('docs/prd.md');
  });

  it('renders empty string when there is nothing to synthesize', () => {
    const synth = synthesizeAcrossRuns([finding({ id: 'z', docDrift: 'none' })]);
    expect(hasSynthesis(synth)).toBe(false);
    expect(renderCrossRunSynthesis(synth)).toBe('');
  });
});

describe('doc-drift surfacing + approval-gated amendment (acceptance a)', () => {
  const entry = extractDocDrift([
    finding({ id: 'run-1', issueId: 7, docDrift: 'PRD assumes 13 months; reality ~11 days.' }),
  ])[0];

  it('surfaces the finding in plain language, naming the Run', () => {
    expect(describeDocDrift(entry)).toBe(
      'Doc-drift flagged by issue 07: PRD assumes 13 months; reality ~11 days.',
    );
  });

  it('records an amend-plan activity that is non-blocking (ADR-0011: a passive note)', () => {
    const activity = proposeDocDriftAmendment(entry);
    expect(activity.action).toBe('amend-plan');
    // ADR-0011 demotes plan amendment off the blocking list — it no longer gates.
    expect(activity.authority).toBe('passive');
    expect(activity.status).toBe('taken');
    expect(activity.id).toBe('amend-plan:run-1');
  });
});

describe('reuse of the Run-log records (no duplication)', () => {
  it('accepts a RunLogRecord[] directly — it is assignable to RunFinding', () => {
    const record: RunLogRecord = {
      id: 's1',
      capturedAt: '2026-07-02T00:00:00.000Z',
      slug: '07-foo',
      title: 'Foo',
      issue: '7 — foo',
      issueId: 7,
      whatChanged: 'touched the merge seam',
      tryIt: null,
      verified: null,
      bookkeeping: null,
      docDrift: 'docs/PRD.md is stale',
      detail: null,
      outcome: 'completed',
    };
    const synth = synthesizeAcrossRuns([record, record]);
    // Same id twice collapses to one Run — no false overlap from re-capture.
    expect(synth.overlaps).toEqual([]);
    expect(synth.docDrift).toHaveLength(2);
  });
});
