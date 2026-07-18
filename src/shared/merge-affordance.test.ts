import { describe, expect, it } from 'vitest';
import { decideMergeAffordance } from './merge-affordance';
import type { AfkBranchFacts } from './worktree-scan';
import type { BranchPreview } from './merge-preview';
import type { RunLogRecord } from './ipc-contract';
import type { RunOutcome } from './completion-parser';
import type { MainIdle } from './auto-merge-lane';

/** A finished-unmerged `afk/` branch; override per case. */
function branch(over: Partial<AfkBranchFacts> & { issueId: number }): AfkBranchFacts {
  const slug = over.slug ?? `${String(over.issueId).padStart(2, '0')}-thing`;
  return {
    slug,
    hasWorktree: false,
    committedStatus: 'done',
    worktreeStatus: 'done',
    mergedIntoMain: false,
    ...over,
  };
}

/** A Run-log Receipt record for the given issue, as the Receipt edge produces it. */
function receiptRecord(over: Partial<RunLogRecord> & { issueId: number }): RunLogRecord {
  const slug = over.slug ?? `${String(over.issueId).padStart(2, '0')}-thing`;
  return {
    issue: `${over.issueId} — ${slug}`,
    whatChanged: 'Did the thing.',
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed' as RunOutcome,
    id: `receipt:${slug}:2026-07-03T10:00:00Z`,
    capturedAt: '2026-07-03T10:00:01.000Z',
    title: null,
    ...over,
    slug,
  };
}

function idle(overrides: Partial<MainIdle> = {}): MainIdle {
  return { cleanTree: true, midMerge: false, liveSoloRun: false, ...overrides };
}

function clean(issueId: number, slug = `${String(issueId).padStart(2, '0')}-thing`): BranchPreview {
  return { issueId, slug, verdict: { kind: 'clean' } };
}

describe('decideMergeAffordance — a healthy lane with no strays recedes (issue 148)', () => {
  it('shows nothing when there is nothing finished-unmerged at all', () => {
    const affordance = decideMergeAffordance({
      branches: [],
      previews: [],
      runLog: [],
      main: idle(),
    });
    expect(affordance).toEqual({ pausedConflict: null, strays: [] });
  });

  it('shows nothing for a Receipt-backed, clean, finished-unmerged branch — the lane merges it on its own', () => {
    const affordance = decideMergeAffordance({
      branches: [branch({ issueId: 5 })],
      previews: [clean(5)],
      runLog: [receiptRecord({ issueId: 5 })],
      main: idle(),
    });
    expect(affordance).toEqual({ pausedConflict: null, strays: [] });
  });
});

describe('decideMergeAffordance — a predicted conflict names the branch (issue 148)', () => {
  it('surfaces the conflicted branch and a human-readable reason', () => {
    const affordance = decideMergeAffordance({
      branches: [branch({ issueId: 7, slug: '07-conflicty' })],
      previews: [{ issueId: 7, slug: '07-conflicty', verdict: { kind: 'conflicts', files: ['a.ts'] } }],
      runLog: [receiptRecord({ issueId: 7, slug: '07-conflicty' })],
      main: idle(),
    });
    expect(affordance.pausedConflict).toEqual({
      issueId: 7,
      slug: '07-conflicty',
      reason: expect.stringContaining('07-conflicty'),
    });
    expect(affordance.strays).toEqual([]);
  });

  it('does not predict a pause while main is not idle (a real mid-merge already gates elsewhere)', () => {
    const affordance = decideMergeAffordance({
      branches: [branch({ issueId: 7 })],
      previews: [{ issueId: 7, slug: '07-conflicty', verdict: { kind: 'conflicts', files: ['a.ts'] } }],
      runLog: [receiptRecord({ issueId: 7 })],
      main: idle({ midMerge: true }),
    });
    expect(affordance.pausedConflict).toBeNull();
  });
});

describe('decideMergeAffordance — strays are separate from lane state (issue 148)', () => {
  it('offers a finished-unmerged branch with no Receipt as a stray', () => {
    const affordance = decideMergeAffordance({
      branches: [branch({ issueId: 9, slug: '09-adopted' })],
      previews: [clean(9)],
      runLog: [],
      main: idle(),
    });
    expect(affordance.pausedConflict).toBeNull();
    expect(affordance.strays).toEqual([{ issueId: 9, slug: '09-adopted' }]);
  });

  it('reports both a paused conflict AND strays at once — independent facts', () => {
    const affordance = decideMergeAffordance({
      branches: [
        branch({ issueId: 7, slug: '07-conflicty' }),
        branch({ issueId: 9, slug: '09-adopted' }),
      ],
      previews: [
        { issueId: 7, slug: '07-conflicty', verdict: { kind: 'conflicts', files: ['a.ts'] } },
        clean(9),
      ],
      runLog: [receiptRecord({ issueId: 7, slug: '07-conflicty' })],
      main: idle(),
    });
    expect(affordance.pausedConflict?.slug).toBe('07-conflicty');
    expect(affordance.strays).toEqual([{ issueId: 9, slug: '09-adopted' }]);
  });
});
