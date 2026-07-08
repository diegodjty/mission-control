import { describe, it, expect } from 'vitest';
import type { MergeCandidate } from './merge-plan';
import {
  decidePreviews,
  previewNeedsRecompute,
  verdictFromSimulation,
  stampsEqual,
  previewBadge,
  branchPreviewsEqual,
  type BranchPreview,
  type CachedPreview,
  type PreviewStamp,
} from './merge-preview';

const first: MergeCandidate = { issueId: 4, slug: '04-first' };
const second: MergeCandidate = { issueId: 7, slug: '07-second' };

const stampA: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['b4-aaa'] };

function cleanCache(stamp: PreviewStamp, firstSlug: string): CachedPreview {
  return { stamp, firstSlug, verdict: { kind: 'clean' } };
}

describe('verdictFromSimulation', () => {
  it('maps a clean simulation to a clean verdict', () => {
    expect(verdictFromSimulation({ kind: 'clean' })).toEqual({ kind: 'clean' });
  });

  it('maps a conflict to a conflicts verdict carrying the files', () => {
    expect(verdictFromSimulation({ kind: 'conflict', files: ['a.ts', 'b.ts'] })).toEqual({
      kind: 'conflicts',
      files: ['a.ts', 'b.ts'],
    });
  });
});

describe('stampsEqual', () => {
  it('is true for identical stamps', () => {
    expect(stampsEqual(stampA, { defaultTip: 'main-aaa', branchTips: ['b4-aaa'] })).toBe(true);
  });

  it('is false when the default tip moved', () => {
    expect(stampsEqual(stampA, { defaultTip: 'main-bbb', branchTips: ['b4-aaa'] })).toBe(false);
  });

  it('is false when a branch tip moved', () => {
    expect(stampsEqual(stampA, { defaultTip: 'main-aaa', branchTips: ['b4-bbb'] })).toBe(false);
  });

  it('is false when the branch set changed size (a new finished branch appeared)', () => {
    expect(stampsEqual(stampA, { defaultTip: 'main-aaa', branchTips: ['b4-aaa', 'b7-aaa'] })).toBe(
      false,
    );
  });
});

describe('previewNeedsRecompute', () => {
  it('needs recompute with no cache (cold)', () => {
    expect(previewNeedsRecompute(null, '04-first', stampA)).toBe(true);
  });

  it('needs recompute when the cached first branch differs', () => {
    expect(previewNeedsRecompute(cleanCache(stampA, '02-other'), '04-first', stampA)).toBe(true);
  });

  it('needs recompute when the stamp moved (stale)', () => {
    const moved: PreviewStamp = { defaultTip: 'main-bbb', branchTips: ['b4-aaa'] };
    expect(previewNeedsRecompute(cleanCache(stampA, '04-first'), '04-first', moved)).toBe(true);
  });

  it('does NOT need recompute when fresh (same first branch, matching stamp)', () => {
    expect(previewNeedsRecompute(cleanCache(stampA, '04-first'), '04-first', stampA)).toBe(false);
  });
});

describe('decidePreviews — the tracer verdict matrix (issue 104)', () => {
  it('emits nothing for an empty batch', () => {
    expect(decidePreviews({ candidates: [], currentStamp: stampA, cached: null })).toEqual([]);
  });

  it('shows recalculating for a single branch with a cold cache', () => {
    const out = decidePreviews({ candidates: [first], currentStamp: stampA, cached: null });
    expect(out).toEqual([{ issueId: 4, slug: '04-first', verdict: { kind: 'recalculating' } }]);
  });

  it('shows the cached CLEAN verdict for a single branch when fresh', () => {
    const out = decidePreviews({
      candidates: [first],
      currentStamp: stampA,
      cached: cleanCache(stampA, '04-first'),
    });
    expect(out).toEqual([{ issueId: 4, slug: '04-first', verdict: { kind: 'clean' } }]);
  });

  it('shows the cached CONFLICTS verdict (with files) for a single branch when fresh', () => {
    const cached: CachedPreview = {
      stamp: stampA,
      firstSlug: '04-first',
      verdict: { kind: 'conflicts', files: ['src/x.ts'] },
    };
    const out = decidePreviews({ candidates: [first], currentStamp: stampA, cached });
    expect(out[0].verdict).toEqual({ kind: 'conflicts', files: ['src/x.ts'] });
  });

  it('shows recalculating (never a stale verdict) when the stamp moved', () => {
    const moved: PreviewStamp = { defaultTip: 'main-bbb', branchTips: ['b4-aaa'] };
    const out = decidePreviews({
      candidates: [first],
      currentStamp: moved,
      cached: cleanCache(stampA, '04-first'),
    });
    expect(out[0].verdict).toEqual({ kind: 'recalculating' });
  });

  it('in a TWO-branch batch, only the first branch gets a verdict; the second shows NONE (deferred to 105)', () => {
    const twoStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['b4-aaa', 'b7-aaa'] };
    const out = decidePreviews({
      candidates: [first, second],
      currentStamp: twoStamp,
      cached: { stamp: twoStamp, firstSlug: '04-first', verdict: { kind: 'clean' } },
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ issueId: 4, slug: '04-first', verdict: { kind: 'clean' } });
    // Explicitly asserted: the second branch carries NO verdict in this slice.
    expect(out[1]).toEqual({ issueId: 7, slug: '07-second', verdict: null });
  });
});

describe('branchPreviewsEqual — the scan no-change guard (issue 104)', () => {
  const clean: BranchPreview = { issueId: 4, slug: '04-first', verdict: { kind: 'clean' } };

  it('is true for identical lists', () => {
    expect(branchPreviewsEqual([clean], [{ ...clean }])).toBe(true);
  });

  it('is false when a verdict flips (recalculating → clean must refresh the badge)', () => {
    const recalc: BranchPreview = { ...clean, verdict: { kind: 'recalculating' } };
    expect(branchPreviewsEqual([recalc], [clean])).toBe(false);
  });

  it('is false when a conflict file list changes', () => {
    const a: BranchPreview = { ...clean, verdict: { kind: 'conflicts', files: ['x.ts'] } };
    const b: BranchPreview = { ...clean, verdict: { kind: 'conflicts', files: ['x.ts', 'y.ts'] } };
    expect(branchPreviewsEqual([a], [b])).toBe(false);
  });

  it('is false when the branch set changes length', () => {
    expect(branchPreviewsEqual([clean], [])).toBe(false);
  });

  it('treats a null verdict (later branch) as equal only to another null', () => {
    const nullV: BranchPreview = { issueId: 7, slug: '07-x', verdict: null };
    expect(branchPreviewsEqual([nullV], [{ ...nullV }])).toBe(true);
    expect(branchPreviewsEqual([nullV], [{ ...nullV, verdict: { kind: 'clean' } }])).toBe(false);
  });
});

describe('previewBadge — the pure display mapping', () => {
  it('labels a clean verdict', () => {
    expect(previewBadge({ kind: 'clean' })).toEqual({
      label: 'merges clean',
      title: expect.stringContaining('cleanly'),
      tone: 'clean',
    });
  });

  it('names the conflicting files in a conflicts verdict', () => {
    const badge = previewBadge({ kind: 'conflicts', files: ['a.ts', 'b.ts'] });
    expect(badge.label).toBe('conflicts (a.ts, b.ts)');
    expect(badge.title).toContain('a.ts');
    expect(badge.tone).toBe('conflicts');
  });

  it('labels a recalculating verdict', () => {
    expect(previewBadge({ kind: 'recalculating' }).tone).toBe('recalculating');
  });
});
