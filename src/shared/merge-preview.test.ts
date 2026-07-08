import { describe, it, expect } from 'vitest';
import type { MergeCandidate } from './merge-plan';
import {
  decidePreviews,
  previewNeedsRecompute,
  sequenceVerdicts,
  stampsEqual,
  slugsEqual,
  previewBadge,
  branchPreviewsEqual,
  type BranchPreview,
  type CachedPreview,
  type PreviewStamp,
  type SequenceSimOutcome,
} from './merge-preview';

const a: MergeCandidate = { issueId: 4, slug: '04-a' };
const b: MergeCandidate = { issueId: 7, slug: '07-b' };
const c: MergeCandidate = { issueId: 9, slug: '09-c' };

const stampABC: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7', 't9'] };

const clean: SequenceSimOutcome = {
  steps: [{ kind: 'clean' }, { kind: 'clean' }, { kind: 'clean' }],
};

function cache(stamp: PreviewStamp, slugs: string[], outcome: SequenceSimOutcome): CachedPreview {
  return { stamp, slugs, outcome };
}

describe('slugsEqual', () => {
  it('is true for identical ordered lists', () => {
    expect(slugsEqual(['04-a', '07-b'], ['04-a', '07-b'])).toBe(true);
  });
  it('is false when order differs', () => {
    expect(slugsEqual(['04-a', '07-b'], ['07-b', '04-a'])).toBe(false);
  });
  it('is false when a branch is added or removed', () => {
    expect(slugsEqual(['04-a'], ['04-a', '07-b'])).toBe(false);
    expect(slugsEqual(['04-a', '07-b'], ['04-a'])).toBe(false);
  });
});

describe('stampsEqual', () => {
  it('is true for identical stamps', () => {
    expect(stampsEqual(stampABC, { defaultTip: 'main-aaa', branchTips: ['t4', 't7', 't9'] })).toBe(
      true,
    );
  });
  it('is false when the default tip moved', () => {
    expect(stampsEqual(stampABC, { defaultTip: 'main-bbb', branchTips: ['t4', 't7', 't9'] })).toBe(
      false,
    );
  });
  it('is false when a branch tip moved (a re-run)', () => {
    expect(stampsEqual(stampABC, { defaultTip: 'main-aaa', branchTips: ['t4', 'NEW', 't9'] })).toBe(
      false,
    );
  });
  it('is false when the branch set changed size (a new/discarded finished branch)', () => {
    expect(stampsEqual(stampABC, { defaultTip: 'main-aaa', branchTips: ['t4', 't7'] })).toBe(false);
  });
});

describe('sequenceVerdicts — the sequential badge mapping (issue 105)', () => {
  it('a clean chain badges every branch clean', () => {
    expect(sequenceVerdicts([a, b, c], clean)).toEqual([
      { kind: 'clean' },
      { kind: 'clean' },
      { kind: 'clean' },
    ]);
  });

  it('conflict-on-first: first conflicts, all later blocked behind it', () => {
    const outcome: SequenceSimOutcome = { steps: [{ kind: 'conflict', files: ['x.ts'] }] };
    expect(sequenceVerdicts([a, b, c], outcome)).toEqual([
      { kind: 'conflicts', files: ['x.ts'] },
      { kind: 'blocked', behindIssueId: 4 },
      { kind: 'blocked', behindIssueId: 4 },
    ]);
  });

  it('mid-sequence conflict: earlier clean, the conflicting one named, later blocked', () => {
    const outcome: SequenceSimOutcome = {
      steps: [{ kind: 'clean' }, { kind: 'conflict', files: ['shared.txt'] }],
    };
    expect(sequenceVerdicts([a, b, c], outcome)).toEqual([
      { kind: 'clean' },
      { kind: 'conflicts', files: ['shared.txt'] },
      { kind: 'blocked', behindIssueId: 7 },
    ]);
  });

  it('conflict-on-last: everything before clean, the last conflicts, nothing blocked', () => {
    const outcome: SequenceSimOutcome = {
      steps: [{ kind: 'clean' }, { kind: 'clean' }, { kind: 'conflict', files: ['z.ts'] }],
    };
    expect(sequenceVerdicts([a, b, c], outcome)).toEqual([
      { kind: 'clean' },
      { kind: 'clean' },
      { kind: 'conflicts', files: ['z.ts'] },
    ]);
  });

  it('a single clean branch badges clean', () => {
    expect(sequenceVerdicts([a], { steps: [{ kind: 'clean' }] })).toEqual([{ kind: 'clean' }]);
  });
});

describe('previewNeedsRecompute — whole-sequence invalidation (issue 105)', () => {
  const cached = cache(stampABC, ['04-a', '07-b', '09-c'], clean);

  it('needs recompute with no cache (cold)', () => {
    expect(previewNeedsRecompute(null, ['04-a', '07-b', '09-c'], stampABC)).toBe(true);
  });

  it('does NOT need recompute when fresh (same batch + stamp)', () => {
    expect(previewNeedsRecompute(cached, ['04-a', '07-b', '09-c'], stampABC)).toBe(false);
  });

  it('needs recompute when a NEW finished branch appears (batch grew)', () => {
    const grownStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7', 't9', 't11'] };
    expect(previewNeedsRecompute(cached, ['04-a', '07-b', '09-c', '11-d'], grownStamp)).toBe(true);
  });

  it('needs recompute when a branch is DISCARDED (batch shrank)', () => {
    const shrunkStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7'] };
    expect(previewNeedsRecompute(cached, ['04-a', '07-b'], shrunkStamp)).toBe(true);
  });

  it('needs recompute when a re-run moves a branch tip (same batch, moved tip)', () => {
    const rerunStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 'NEW', 't9'] };
    expect(previewNeedsRecompute(cached, ['04-a', '07-b', '09-c'], rerunStamp)).toBe(true);
  });

  it('needs recompute when the default tip moved (a merge landed on main)', () => {
    const movedMain: PreviewStamp = { defaultTip: 'main-bbb', branchTips: ['t4', 't7', 't9'] };
    expect(previewNeedsRecompute(cached, ['04-a', '07-b', '09-c'], movedMain)).toBe(true);
  });
});

describe('decidePreviews — full-batch sequential verdicts (issue 105)', () => {
  it('emits nothing for an empty batch', () => {
    expect(decidePreviews({ candidates: [], currentStamp: stampABC, cached: null })).toEqual([]);
  });

  it('shows recalculating for EVERY branch on a cold cache', () => {
    const out = decidePreviews({ candidates: [a, b, c], currentStamp: stampABC, cached: null });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'recalculating' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'recalculating' } },
      { issueId: 9, slug: '09-c', verdict: { kind: 'recalculating' } },
    ]);
  });

  it('a clean batch of 3 branches badges every branch clean when fresh', () => {
    const out = decidePreviews({
      candidates: [a, b, c],
      currentStamp: stampABC,
      cached: cache(stampABC, ['04-a', '07-b', '09-c'], clean),
    });
    expect(out.map((p) => p.verdict)).toEqual([
      { kind: 'clean' },
      { kind: 'clean' },
      { kind: 'clean' },
    ]);
  });

  it('a mid-sequence conflict badges clean / conflicts / blocked-behind in order', () => {
    const outcome: SequenceSimOutcome = {
      steps: [{ kind: 'clean' }, { kind: 'conflict', files: ['shared.txt'] }],
    };
    const out = decidePreviews({
      candidates: [a, b, c],
      currentStamp: stampABC,
      cached: cache(stampABC, ['04-a', '07-b', '09-c'], outcome),
    });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'clean' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'conflicts', files: ['shared.txt'] } },
      { issueId: 9, slug: '09-c', verdict: { kind: 'blocked', behindIssueId: 7 } },
    ]);
  });

  it('shows recalculating (never a stale verdict) when a branch tip moved', () => {
    const rerun: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 'NEW', 't9'] };
    const out = decidePreviews({
      candidates: [a, b, c],
      currentStamp: rerun,
      cached: cache(stampABC, ['04-a', '07-b', '09-c'], clean),
    });
    expect(out.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
  });

  it('shows recalculating for the whole batch when a new branch appears (batch mutation)', () => {
    const grownStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7', 't9', 't11'] };
    const d: MergeCandidate = { issueId: 11, slug: '11-d' };
    const out = decidePreviews({
      candidates: [a, b, c, d],
      currentStamp: grownStamp,
      // cache is for the OLD 3-branch batch → invalidated by the 4th appearing.
      cached: cache(stampABC, ['04-a', '07-b', '09-c'], clean),
    });
    expect(out).toHaveLength(4);
    expect(out.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
  });
});

describe('mid-merge suspension (issue 107, ADR-0018)', () => {
  it('suspends EVERY branch while mid-merge — never a verdict, never recalculating', () => {
    const out = decidePreviews({
      candidates: [a, b, c],
      currentStamp: stampABC,
      cached: null,
      midMerge: true,
    });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'suspended' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'suspended' } },
      { issueId: 9, slug: '09-c', verdict: { kind: 'suspended' } },
    ]);
  });

  it('suspends even when the cache is otherwise FRESH (a mid-merge repo can’t be pressed)', () => {
    const out = decidePreviews({
      candidates: [a, b, c],
      currentStamp: stampABC,
      cached: cache(stampABC, ['04-a', '07-b', '09-c'], clean), // would be all-clean if fresh
      midMerge: true,
    });
    expect(out.every((p) => p.verdict?.kind === 'suspended')).toBe(true);
  });

  it('emits nothing for an empty batch even mid-merge', () => {
    expect(decidePreviews({ candidates: [], currentStamp: stampABC, cached: null, midMerge: true })).toEqual(
      [],
    );
  });

  // Exit path 1 — Abort returns main to a settled tip (different from the
  // pre-merge one it was cached against). The first clean tick sees the moved
  // stamp, so the batch recalculates (never a stale verdict), then the recompute
  // for the new tip lands and fresh verdicts appear.
  it('Abort → clean main: the moved tip recalculates, then the fresh verdict lands', () => {
    const afterAbort: PreviewStamp = { defaultTip: 'main-post-abort', branchTips: ['t4', 't7', 't9'] };
    const preMergeCache = cache(stampABC, ['04-a', '07-b', '09-c'], clean);
    // tick right after mid-merge clears: main moved → recalculating for all.
    const tick1 = decidePreviews({ candidates: [a, b, c], currentStamp: afterAbort, cached: preMergeCache });
    expect(tick1.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    expect(previewNeedsRecompute(preMergeCache, ['04-a', '07-b', '09-c'], afterAbort)).toBe(true);
    // recompute for the new tip lands → fresh verdicts.
    const freshCache = cache(afterAbort, ['04-a', '07-b', '09-c'], clean);
    const tick2 = decidePreviews({ candidates: [a, b, c], currentStamp: afterAbort, cached: freshCache });
    expect(tick2.map((p) => p.verdict)).toEqual([{ kind: 'clean' }, { kind: 'clean' }, { kind: 'clean' }]);
  });

  // Exit path 2 — the human resolves the conflict and commits, advancing main to
  // the merge commit; the earlier-conflicting branch (04-a) is now merged, so the
  // batch shrinks and the fresh verdict reflects the NEWLY-MERGED main.
  it('resolve + commit → fresh verdicts reflect the newly-merged main', () => {
    const afterResolve: PreviewStamp = { defaultTip: 'main-resolved', branchTips: ['t7', 't9'] };
    const preMergeCache = cache(stampABC, ['04-a', '07-b', '09-c'], clean);
    // batch shrank (04-a merged) AND main moved → recalculating for the remaining two.
    const tick1 = decidePreviews({ candidates: [b, c], currentStamp: afterResolve, cached: preMergeCache });
    expect(tick1.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    expect(previewNeedsRecompute(preMergeCache, ['07-b', '09-c'], afterResolve)).toBe(true);
    // recompute against the resolved main surfaces a fresh conflict on 07-b.
    const conflictOnB: SequenceSimOutcome = { steps: [{ kind: 'conflict', files: ['shared.txt'] }] };
    const freshCache = cache(afterResolve, ['07-b', '09-c'], conflictOnB);
    const tick2 = decidePreviews({ candidates: [b, c], currentStamp: afterResolve, cached: freshCache });
    expect(tick2).toEqual([
      { issueId: 7, slug: '07-b', verdict: { kind: 'conflicts', files: ['shared.txt'] } },
      { issueId: 9, slug: '09-c', verdict: { kind: 'blocked', behindIssueId: 7 } },
    ]);
  });
});

describe('branchPreviewsEqual — the scan no-change guard', () => {
  const cleanA: BranchPreview = { issueId: 4, slug: '04-a', verdict: { kind: 'clean' } };

  it('is true for identical lists', () => {
    expect(branchPreviewsEqual([cleanA], [{ ...cleanA }])).toBe(true);
  });

  it('is false when a verdict flips (recalculating → clean must refresh the badge)', () => {
    const recalc: BranchPreview = { ...cleanA, verdict: { kind: 'recalculating' } };
    expect(branchPreviewsEqual([recalc], [cleanA])).toBe(false);
  });

  it('is false when a conflict file list changes', () => {
    const x: BranchPreview = { ...cleanA, verdict: { kind: 'conflicts', files: ['x.ts'] } };
    const y: BranchPreview = { ...cleanA, verdict: { kind: 'conflicts', files: ['x.ts', 'y.ts'] } };
    expect(branchPreviewsEqual([x], [y])).toBe(false);
  });

  it('is false when a blocked-behind target changes (the conflict moved upstream)', () => {
    const b4: BranchPreview = { ...cleanA, verdict: { kind: 'blocked', behindIssueId: 4 } };
    const b7: BranchPreview = { ...cleanA, verdict: { kind: 'blocked', behindIssueId: 7 } };
    expect(branchPreviewsEqual([b4], [b7])).toBe(false);
    expect(branchPreviewsEqual([b4], [{ ...b4 }])).toBe(true);
  });

  it('is false when the branch set changes length', () => {
    expect(branchPreviewsEqual([cleanA], [])).toBe(false);
  });

  it('treats a null verdict as equal only to another null', () => {
    const nullV: BranchPreview = { issueId: 7, slug: '07-x', verdict: null };
    expect(branchPreviewsEqual([nullV], [{ ...nullV }])).toBe(true);
    expect(branchPreviewsEqual([nullV], [{ ...nullV, verdict: { kind: 'clean' } }])).toBe(false);
  });

  it('refreshes when suspension lifts (suspended → recalculating/clean must not be dropped)', () => {
    const susp: BranchPreview = { ...cleanA, verdict: { kind: 'suspended' } };
    expect(branchPreviewsEqual([susp], [{ ...susp }])).toBe(true);
    expect(branchPreviewsEqual([susp], [{ ...cleanA, verdict: { kind: 'recalculating' } }])).toBe(false);
    expect(branchPreviewsEqual([susp], [cleanA])).toBe(false);
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

  it('names the blocking branch (NN, zero-padded) in a blocked verdict', () => {
    const badge = previewBadge({ kind: 'blocked', behindIssueId: 7 });
    expect(badge.label).toBe('blocked behind 07');
    expect(badge.title).toContain('07');
    expect(badge.tone).toBe('blocked');
  });

  it('labels a recalculating verdict', () => {
    expect(previewBadge({ kind: 'recalculating' }).tone).toBe('recalculating');
  });

  it('labels a suspended (mid-merge) verdict', () => {
    const badge = previewBadge({ kind: 'suspended' });
    expect(badge.label).toBe('merge in progress');
    expect(badge.tone).toBe('suspended');
    expect(badge.title).toContain('mid-merge');
  });
});
