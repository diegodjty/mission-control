import { describe, expect, it } from 'vitest';
import {
  decideAutoMergeLane,
  mainIdleHold,
  mergeableInFinishOrder,
  type LaneBranch,
  type MainIdle,
} from './auto-merge-lane';
import type { MergePreviewVerdict } from './merge-preview';

/** An idle main (clean tree, not mid-merge, no live solo Run); override per case. */
function idle(overrides: Partial<MainIdle> = {}): MainIdle {
  return { cleanTree: true, midMerge: false, liveSoloRun: false, ...overrides };
}

/** A clean, Receipt-backed finished branch; override per case. */
function branch(overrides: Partial<LaneBranch> = {}): LaneBranch {
  return {
    issueId: 5,
    slug: '05-live-map-updates',
    receiptBacked: true,
    finished: '2026-07-03T12:00:00.000Z',
    verdict: { kind: 'clean' },
    ...overrides,
  };
}

describe('decideAutoMergeLane — a clean, Receipt-backed branch on an idle main (issue 145)', () => {
  it('merges the clean branch when main is idle', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle() });
    expect(decision).toEqual({ kind: 'merge', issueId: 5, slug: '05-live-map-updates' });
  });

  it('names the branch it would merge (issueId + slug) so the executor targets it', () => {
    const decision = decideAutoMergeLane({
      branches: [branch({ issueId: 8, slug: '08-merge-runs' })],
      main: idle(),
    });
    expect(decision).toEqual({ kind: 'merge', issueId: 8, slug: '08-merge-runs' });
  });
});

describe('decideAutoMergeLane — a non-idle main always holds (issue 145)', () => {
  it('holds on a dirty working tree (never merges onto uncommitted changes)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ cleanTree: false }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'main-dirty' });
  });

  it('holds on a mid-merge main (a prior conflict must be resolved/aborted first)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ midMerge: true }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'mid-merge' });
  });

  it('holds while a solo Run is live on main (merging would collide with its tree)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ liveSoloRun: true }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'live-solo-run' });
  });

  it('reports mid-merge (not dirty) when a mid-merge left the tree dirty too — the most specific cause', () => {
    const decision = decideAutoMergeLane({
      branches: [branch()],
      main: idle({ cleanTree: false, midMerge: true }),
    });
    expect(decision).toEqual({ kind: 'hold', reason: 'mid-merge' });
  });
});

describe('decideAutoMergeLane — a branch with no Receipt is never a merge action (issue 145)', () => {
  it('holds on a stray (finished-unmerged, clean, but no Receipt) — MC cannot vouch for it', () => {
    const stray = branch({ receiptBacked: false });
    const decision = decideAutoMergeLane({ branches: [stray], main: idle() });
    expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch' });
  });

  it('picks the Receipt-backed branch and ignores a stray sibling', () => {
    const stray = branch({ issueId: 6, slug: '06-stray', receiptBacked: false });
    const backed = branch({ issueId: 7, slug: '07-backed', receiptBacked: true });
    const decision = decideAutoMergeLane({ branches: [stray, backed], main: idle() });
    expect(decision).toEqual({ kind: 'merge', issueId: 7, slug: '07-backed' });
  });
});

describe('decideAutoMergeLane — only a clean verdict authorizes a merge (issue 145)', () => {
  const nonClean: MergePreviewVerdict[] = [
    { kind: 'conflicts', files: ['src/app.ts'] },
    { kind: 'blocked', behindIssueId: 4 },
    { kind: 'artifact', paths: ['node_modules'] },
    { kind: 'recalculating' },
    { kind: 'suspended' },
  ];
  for (const verdict of nonClean) {
    it(`holds when the only branch's verdict is '${verdict.kind}'`, () => {
      const decision = decideAutoMergeLane({ branches: [branch({ verdict })], main: idle() });
      expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch' });
    });
  }

  it('holds when the branch has no verdict yet (null)', () => {
    const decision = decideAutoMergeLane({ branches: [branch({ verdict: null })], main: idle() });
    expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch' });
  });

  it('holds when there are no finished-unmerged branches at all', () => {
    expect(decideAutoMergeLane({ branches: [], main: idle() })).toEqual({
      kind: 'hold',
      reason: 'no-clean-branch',
    });
  });
});

describe('mergeableInFinishOrder — finish order seeds issue 146 ordering (issue 145)', () => {
  it('takes the earliest-finished clean Receipt-backed branch first', () => {
    const later = branch({ issueId: 6, slug: '06-later', finished: '2026-07-03T15:00:00.000Z' });
    const earlier = branch({ issueId: 8, slug: '08-earlier', finished: '2026-07-03T09:00:00.000Z' });
    // Higher issue id finished FIRST — finish order (not id order) must win.
    const ordered = mergeableInFinishOrder([later, earlier]);
    expect(ordered.map((b) => b.slug)).toEqual(['08-earlier', '06-later']);
    // And the whole decision picks that earliest-finished branch.
    expect(decideAutoMergeLane({ branches: [later, earlier], main: idle() })).toEqual({
      kind: 'merge',
      issueId: 8,
      slug: '08-earlier',
    });
  });

  it('sorts a null finish timestamp last, and breaks ties by ascending issue id', () => {
    const noStamp = branch({ issueId: 3, slug: '03-nostamp', finished: null });
    const tieB = branch({ issueId: 5, slug: '05-tie', finished: '2026-07-03T10:00:00.000Z' });
    const tieA = branch({ issueId: 4, slug: '04-tie', finished: '2026-07-03T10:00:00.000Z' });
    const ordered = mergeableInFinishOrder([noStamp, tieB, tieA]);
    expect(ordered.map((b) => b.slug)).toEqual(['04-tie', '05-tie', '03-nostamp']);
  });

  it('filters out strays and non-clean verdicts before ordering', () => {
    const kept = branch({ issueId: 2, slug: '02-clean', finished: '2026-07-03T08:00:00.000Z' });
    const stray = branch({ issueId: 3, slug: '03-stray', receiptBacked: false });
    const conflicting = branch({ issueId: 4, slug: '04-conflict', verdict: { kind: 'conflicts', files: [] } });
    expect(mergeableInFinishOrder([kept, stray, conflicting]).map((b) => b.slug)).toEqual(['02-clean']);
  });
});

describe('mainIdleHold — the idle gate in isolation (issue 145)', () => {
  it('returns null when main is idle', () => {
    expect(mainIdleHold(idle())).toBeNull();
  });

  it('returns the blocking fact, most-specific first', () => {
    expect(mainIdleHold(idle({ midMerge: true }))).toBe('mid-merge');
    expect(mainIdleHold(idle({ cleanTree: false }))).toBe('main-dirty');
    expect(mainIdleHold(idle({ liveSoloRun: true }))).toBe('live-solo-run');
  });
});
