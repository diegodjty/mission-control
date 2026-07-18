import { describe, expect, it } from 'vitest';
import {
  decideAutoMergeLane,
  mainIdleHold,
  mergeableInFinishOrder,
  receiptBackedInFinishOrder,
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
    expect(decision).toEqual({ kind: 'merge', issueId: 5, slug: '05-live-map-updates', skipped: [] });
  });

  it('names the branch it would merge (issueId + slug) so the executor targets it', () => {
    const decision = decideAutoMergeLane({
      branches: [branch({ issueId: 8, slug: '08-merge-runs' })],
      main: idle(),
    });
    expect(decision).toEqual({ kind: 'merge', issueId: 8, slug: '08-merge-runs', skipped: [] });
  });
});

describe('decideAutoMergeLane — a non-idle main always holds (issue 145)', () => {
  it('holds on a dirty working tree (never merges onto uncommitted changes)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ cleanTree: false }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'main-dirty', skipped: [] });
  });

  it('holds on a mid-merge main (a prior conflict must be resolved/aborted first)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ midMerge: true }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'mid-merge', skipped: [] });
  });

  it('holds while a solo Run is live on main (merging would collide with its tree)', () => {
    const decision = decideAutoMergeLane({ branches: [branch()], main: idle({ liveSoloRun: true }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'live-solo-run', skipped: [] });
  });

  it('reports mid-merge (not dirty) when a mid-merge left the tree dirty too — the most specific cause', () => {
    const decision = decideAutoMergeLane({
      branches: [branch()],
      main: idle({ cleanTree: false, midMerge: true }),
    });
    expect(decision).toEqual({ kind: 'hold', reason: 'mid-merge', skipped: [] });
  });

  it('does not walk (no skips reported) when main is not idle, even with an artifact offender present', () => {
    const offender = branch({ issueId: 9, slug: '09-artifact', verdict: { kind: 'artifact', paths: ['node_modules'] } });
    const decision = decideAutoMergeLane({ branches: [offender], main: idle({ cleanTree: false }) });
    expect(decision).toEqual({ kind: 'hold', reason: 'main-dirty', skipped: [] });
  });
});

describe('decideAutoMergeLane — a branch with no Receipt is never a merge action (issue 145)', () => {
  it('holds on a stray (finished-unmerged, clean, but no Receipt) — MC cannot vouch for it', () => {
    const stray = branch({ receiptBacked: false });
    const decision = decideAutoMergeLane({ branches: [stray], main: idle() });
    expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch', skipped: [] });
  });

  it('picks the Receipt-backed branch and ignores a stray sibling', () => {
    const stray = branch({ issueId: 6, slug: '06-stray', receiptBacked: false });
    const backed = branch({ issueId: 7, slug: '07-backed', receiptBacked: true });
    const decision = decideAutoMergeLane({ branches: [stray, backed], main: idle() });
    expect(decision).toEqual({ kind: 'merge', issueId: 7, slug: '07-backed', skipped: [] });
  });

  it('a stray that would conflict never pauses the lane — it is not in the lane at all', () => {
    // A stray with a `conflicts` verdict must NOT gate: strays are outside the lane.
    const strayConflict = branch({
      issueId: 6,
      slug: '06-stray',
      receiptBacked: false,
      verdict: { kind: 'conflicts', files: ['src/app.ts'] },
    });
    const clean = branch({ issueId: 7, slug: '07-backed', finished: '2026-07-03T13:00:00.000Z' });
    const decision = decideAutoMergeLane({ branches: [strayConflict, clean], main: idle() });
    expect(decision).toEqual({ kind: 'merge', issueId: 7, slug: '07-backed', skipped: [] });
  });
});

describe('decideAutoMergeLane — only a clean verdict authorizes a merge (issue 145/146)', () => {
  it('holds when the only branch has no verdict yet (null)', () => {
    const decision = decideAutoMergeLane({ branches: [branch({ verdict: null })], main: idle() });
    expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch', skipped: [] });
  });

  for (const verdict of [{ kind: 'recalculating' }, { kind: 'suspended' }] as MergePreviewVerdict[]) {
    it(`holds (no merge past it) when the only branch's verdict is the transient '${verdict.kind}'`, () => {
      const decision = decideAutoMergeLane({ branches: [branch({ verdict })], main: idle() });
      expect(decision).toEqual({ kind: 'hold', reason: 'no-clean-branch', skipped: [] });
    });
  }

  it('holds when there are no finished-unmerged branches at all', () => {
    expect(decideAutoMergeLane({ branches: [], main: idle() })).toEqual({
      kind: 'hold',
      reason: 'no-clean-branch',
      skipped: [],
    });
  });
});

describe('decideAutoMergeLane — multiple clean branches merge in finish order (issue 146)', () => {
  it('merges the earliest-finished branch first even when it has the higher issue id', () => {
    const later = branch({ issueId: 6, slug: '06-later', finished: '2026-07-03T15:00:00.000Z' });
    const earlier = branch({ issueId: 8, slug: '08-earlier', finished: '2026-07-03T09:00:00.000Z' });
    expect(decideAutoMergeLane({ branches: [later, earlier], main: idle() })).toEqual({
      kind: 'merge',
      issueId: 8,
      slug: '08-earlier',
      skipped: [],
    });
  });

  it('takes the next branch in finish order once the earliest has merged (drops out of the set)', () => {
    // Sweep 2 sees only the branches still unmerged — the lane merges one per sweep.
    const a = branch({ issueId: 4, slug: '04-a', finished: '2026-07-03T08:00:00.000Z' });
    const b = branch({ issueId: 6, slug: '06-b', finished: '2026-07-03T09:00:00.000Z' });
    const c = branch({ issueId: 5, slug: '05-c', finished: '2026-07-03T10:00:00.000Z' });
    // First sweep picks 04 (earliest). After it merges, the remaining set…
    expect(decideAutoMergeLane({ branches: [a, b, c], main: idle() }).kind).toBe('merge');
    // …merges 06 next (second-earliest), NOT 05 (id order would have taken 05).
    expect(decideAutoMergeLane({ branches: [b, c], main: idle() })).toEqual({
      kind: 'merge',
      issueId: 6,
      slug: '06-b',
      skipped: [],
    });
  });
});

describe('decideAutoMergeLane — a predicted conflict pauses the whole lane (issue 146)', () => {
  it('pauses on a `conflicts` branch and merges nothing past it — later clean branches queue', () => {
    const conflicting = branch({
      issueId: 6,
      slug: '06-conflict',
      finished: '2026-07-03T09:00:00.000Z',
      verdict: { kind: 'conflicts', files: ['src/app.ts'] },
    });
    const laterClean = branch({ issueId: 7, slug: '07-clean', finished: '2026-07-03T11:00:00.000Z' });
    const decision = decideAutoMergeLane({ branches: [conflicting, laterClean], main: idle() });
    expect(decision).toEqual({
      kind: 'pause',
      issueId: 6,
      slug: '06-conflict',
      verdict: { kind: 'conflicts', files: ['src/app.ts'] },
      skipped: [],
    });
  });

  it('merges the earlier clean branch, then pauses on the next (finish order) conflict', () => {
    const cleanFirst = branch({ issueId: 5, slug: '05-clean', finished: '2026-07-03T08:00:00.000Z' });
    const conflicting = branch({
      issueId: 6,
      slug: '06-conflict',
      finished: '2026-07-03T09:00:00.000Z',
      verdict: { kind: 'conflicts', files: ['shared.ts'] },
    });
    const laterClean = branch({ issueId: 4, slug: '04-clean', finished: '2026-07-03T10:00:00.000Z' });
    // Sweep 1: earliest clean (05) merges.
    expect(decideAutoMergeLane({ branches: [cleanFirst, conflicting, laterClean], main: idle() })).toEqual({
      kind: 'merge',
      issueId: 5,
      slug: '05-clean',
      skipped: [],
    });
    // Sweep 2 (05 gone): the conflict (06) is now finish-first → pause; 04 queues.
    expect(decideAutoMergeLane({ branches: [conflicting, laterClean], main: idle() })).toEqual({
      kind: 'pause',
      issueId: 6,
      slug: '06-conflict',
      verdict: { kind: 'conflicts', files: ['shared.ts'] },
      skipped: [],
    });
  });

  it('pauses on a `blocked` branch too (it has no clean verdict — must not merge past it)', () => {
    const blocked = branch({ issueId: 7, slug: '07-blocked', verdict: { kind: 'blocked', behindIssueId: 6 } });
    const decision = decideAutoMergeLane({ branches: [blocked], main: idle() });
    expect(decision).toEqual({
      kind: 'pause',
      issueId: 7,
      slug: '07-blocked',
      verdict: { kind: 'blocked', behindIssueId: 6 },
      skipped: [],
    });
  });

  it('resumes (re-derives a merge) once the conflicting branch leaves the set — resolved or aborted', () => {
    const laterClean = branch({ issueId: 7, slug: '07-clean', finished: '2026-07-03T11:00:00.000Z' });
    // With the conflicting 06 gone (aborted/resolved), the queued 07 merges — no stored pause state.
    expect(decideAutoMergeLane({ branches: [laterClean], main: idle() })).toEqual({
      kind: 'merge',
      issueId: 7,
      slug: '07-clean',
      skipped: [],
    });
  });
});

describe('decideAutoMergeLane — an artifact offender is skipped per-offender (issue 106/146)', () => {
  it('skips a lone artifact offender and holds (nothing else to merge), reporting the skip', () => {
    const offender = branch({
      issueId: 6,
      slug: '06-artifact',
      verdict: { kind: 'artifact', paths: ['node_modules', 'dist'] },
    });
    const decision = decideAutoMergeLane({ branches: [offender], main: idle() });
    expect(decision).toEqual({
      kind: 'hold',
      reason: 'no-clean-branch',
      skipped: [{ issueId: 6, slug: '06-artifact', paths: ['node_modules', 'dist'] }],
    });
  });

  it('skips the offender and MERGES a later clean sibling — one bad branch never stalls the lane', () => {
    const offender = branch({
      issueId: 6,
      slug: '06-artifact',
      finished: '2026-07-03T09:00:00.000Z',
      verdict: { kind: 'artifact', paths: ['node_modules'] },
    });
    const cleanSibling = branch({ issueId: 7, slug: '07-clean', finished: '2026-07-03T11:00:00.000Z' });
    const decision = decideAutoMergeLane({ branches: [offender, cleanSibling], main: idle() });
    expect(decision).toEqual({
      kind: 'merge',
      issueId: 7,
      slug: '07-clean',
      skipped: [{ issueId: 6, slug: '06-artifact', paths: ['node_modules'] }],
    });
  });

  it('skips offenders BEFORE a conflict and still pauses on the conflict (both reported)', () => {
    const offender = branch({
      issueId: 4,
      slug: '04-artifact',
      finished: '2026-07-03T08:00:00.000Z',
      verdict: { kind: 'artifact', paths: ['out'] },
    });
    const conflicting = branch({
      issueId: 6,
      slug: '06-conflict',
      finished: '2026-07-03T09:00:00.000Z',
      verdict: { kind: 'conflicts', files: ['a.ts'] },
    });
    const decision = decideAutoMergeLane({ branches: [offender, conflicting], main: idle() });
    expect(decision).toEqual({
      kind: 'pause',
      issueId: 6,
      slug: '06-conflict',
      verdict: { kind: 'conflicts', files: ['a.ts'] },
      skipped: [{ issueId: 4, slug: '04-artifact', paths: ['out'] }],
    });
  });
});

describe('receiptBackedInFinishOrder — the ordering the whole walk marches down (issue 146)', () => {
  it('keeps every verdict (clean, conflict, artifact) but drops strays, in finish order', () => {
    const clean = branch({ issueId: 2, slug: '02-clean', finished: '2026-07-03T08:00:00.000Z' });
    const stray = branch({ issueId: 3, slug: '03-stray', receiptBacked: false });
    const conflicting = branch({ issueId: 4, slug: '04-conflict', finished: '2026-07-03T09:00:00.000Z', verdict: { kind: 'conflicts', files: [] } });
    const artifact = branch({ issueId: 5, slug: '05-artifact', finished: '2026-07-03T07:00:00.000Z', verdict: { kind: 'artifact', paths: ['x'] } });
    expect(receiptBackedInFinishOrder([clean, stray, conflicting, artifact]).map((b) => b.slug)).toEqual([
      '05-artifact', // earliest finished
      '02-clean',
      '04-conflict',
    ]);
  });
});

describe('mergeableInFinishOrder — finish order of the CLEAN candidates (issue 145)', () => {
  it('takes the earliest-finished clean Receipt-backed branch first', () => {
    const later = branch({ issueId: 6, slug: '06-later', finished: '2026-07-03T15:00:00.000Z' });
    const earlier = branch({ issueId: 8, slug: '08-earlier', finished: '2026-07-03T09:00:00.000Z' });
    const ordered = mergeableInFinishOrder([later, earlier]);
    expect(ordered.map((b) => b.slug)).toEqual(['08-earlier', '06-later']);
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
