import { describe, expect, it } from 'vitest';
import {
  laneBranchesFrom,
  sweepAutoMergeLane,
  type AutoMergeLaneScan,
  type AutoMergeLaneSweepDeps,
} from './auto-merge-lane-executor';
import { createRepoSerializer, type RepoSerializer } from '../shared/repo-serializer';
import type { AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview, MergePreviewVerdict } from '../shared/merge-preview';
import type { MergeRunsResult, RunLogRecord } from '../shared/ipc-contract';

/**
 * Exercises the auto-merge lane EXECUTOR (issue 145) with injected fakes — the
 * pure lane's verdict → a real merge under the per-repo serializer, or a hold.
 * The real git/afk-merge path is exercised in the e2e drain harness; here we
 * assert the wiring: clean+idle → merge under the serializer, non-idle → hold and
 * NO merge, a stray → never merged, and the clean result classifies to the passive
 * `merge` note (not a gate).
 */

/** A finished-unmerged `afk/` branch fact (committed done, not merged). */
function finishedUnmerged(issueId: number, slug: string): AfkBranchFacts {
  return {
    issueId,
    slug,
    hasWorktree: true,
    committedStatus: 'done',
    worktreeStatus: 'done',
    mergedIntoMain: false,
  };
}

/** A Run-log Receipt record for the given issue (id embeds `finished`, ADR-0013). */
function receipt(issueId: number, slug: string, finished: string): RunLogRecord {
  return {
    id: `receipt:${slug}:${finished}`,
    capturedAt: finished,
    issue: `${issueId} — ${slug}`,
    issueId,
    slug,
    title: slug,
    whatChanged: 'did a thing',
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed',
  };
}

function preview(issueId: number, slug: string, verdict: MergePreviewVerdict | null): BranchPreview {
  return { issueId, slug, verdict };
}

/** A clean afk-merge result for one slug; override per case. */
function mergeOk(slug: string, overrides: Partial<MergeRunsResult> = {}): MergeRunsResult {
  return {
    ok: true,
    conflicted: false,
    midMerge: false,
    merged: [slug],
    adopted: [],
    message: `Merged 1 branch into main and cleaned up its worktree.`,
    output: '',
    ...overrides,
  };
}

/** A serializer that records the keys it ran under, wrapping the real one. */
function spySerializer(): { serializer: RepoSerializer; keys: string[] } {
  const real = createRepoSerializer();
  const keys: string[] = [];
  return {
    keys,
    serializer: {
      run: (key, task) => {
        keys.push(key);
        return real.run(key, task);
      },
      activeKeys: () => real.activeKeys(),
    },
  };
}

/** Assemble sweep deps for one repo; override per case. Records every merge call. */
function deps(
  overrides: Partial<AutoMergeLaneSweepDeps> & {
    scanResult?: AutoMergeLaneScan;
    mergeResult?: MergeRunsResult;
    mergeCalls?: string[][];
  } = {},
): { deps: AutoMergeLaneSweepDeps; keys: string[]; mergeCalls: string[][] } {
  const { serializer, keys } = spySerializer();
  const mergeCalls = overrides.mergeCalls ?? [];
  const scanResult: AutoMergeLaneScan = overrides.scanResult ?? {
    branches: [finishedUnmerged(5, '05-live-map-updates')],
    previews: [preview(5, '05-live-map-updates', { kind: 'clean' })],
    midMerge: false,
  };
  const resolved: AutoMergeLaneSweepDeps = {
    scan: overrides.scan ?? (async () => scanResult),
    isCleanTree: overrides.isCleanTree ?? (async () => true),
    hasLiveSoloRun: overrides.hasLiveSoloRun ?? (() => false),
    runLog: overrides.runLog ?? [receipt(5, '05-live-map-updates', '2026-07-03T12:00:00.000Z')],
    merge:
      overrides.merge ??
      (async (slugs) => {
        mergeCalls.push(slugs);
        return overrides.mergeResult ?? mergeOk(slugs[0]);
      }),
    serializer,
    serializerKey: overrides.serializerKey ?? 'repo-a',
  };
  return { deps: resolved, keys, mergeCalls };
}

describe('sweepAutoMergeLane — a clean, Receipt-backed branch on an idle main (issue 145)', () => {
  it('merges the branch under the per-repo serializer and classifies it as a passive auto-merge note', async () => {
    const { deps: d, keys, mergeCalls } = deps();
    const outcome = await sweepAutoMergeLane(d);

    expect(outcome.kind).toBe('swept');
    if (outcome.kind !== 'swept') throw new Error('unreachable');
    expect(outcome.slug).toBe('05-live-map-updates');
    expect(outcome.issueId).toBe(5);
    // The merge ran, targeting exactly the chosen branch…
    expect(mergeCalls).toEqual([['05-live-map-updates']]);
    // …under the repo's serializer key (ADR-0021: merges serialize per repo).
    expect(keys).toEqual(['repo-a']);
    // Clean result → the passive `merge` note (silent + note), never a blocking gate.
    expect(outcome.decision).toEqual({
      kind: 'auto',
      action: 'merge',
      note: outcome.result.message,
    });
  });
});

describe('sweepAutoMergeLane — a non-idle main holds and never merges (issue 145)', () => {
  it('holds (main-dirty) on a dirty tree — no merge, no serializer use', async () => {
    const { deps: d, keys, mergeCalls } = deps({ isCleanTree: async () => false });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'main-dirty' });
    expect(mergeCalls).toEqual([]);
    expect(keys).toEqual([]);
  });

  it('holds (mid-merge) when the scan reports the repo mid-merge', async () => {
    const { deps: d, mergeCalls } = deps({
      scanResult: {
        branches: [finishedUnmerged(5, '05-live-map-updates')],
        previews: [preview(5, '05-live-map-updates', { kind: 'clean' })],
        midMerge: true,
      },
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'mid-merge' });
    expect(mergeCalls).toEqual([]);
  });

  it('holds (live-solo-run) while a solo Run is live on main', async () => {
    const { deps: d, mergeCalls } = deps({ hasLiveSoloRun: () => true });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'live-solo-run' });
    expect(mergeCalls).toEqual([]);
  });
});

describe('sweepAutoMergeLane — Receipt-backing and verdict gate the merge (issue 145)', () => {
  it('never merges a stray branch (finished-unmerged, clean, but no Receipt in the log)', async () => {
    const { deps: d, mergeCalls } = deps({ runLog: [] }); // no Receipt for issue 5
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'no-clean-branch' });
    expect(mergeCalls).toEqual([]);
  });

  it('holds when the branch has no clean verdict yet (recalculating)', async () => {
    const { deps: d, mergeCalls } = deps({
      scanResult: {
        branches: [finishedUnmerged(5, '05-live-map-updates')],
        previews: [preview(5, '05-live-map-updates', { kind: 'recalculating' })],
        midMerge: false,
      },
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'no-clean-branch' });
    expect(mergeCalls).toEqual([]);
  });
});

describe('sweepAutoMergeLane — result classification surfaces a conflict as a gate (issue 145)', () => {
  it('classifies a conflicting merge as a gate (lane-pause is issue 146; this slice only classifies)', async () => {
    const conflict = mergeOk('05-live-map-updates', {
      ok: false,
      conflicted: true,
      midMerge: true,
      merged: [],
      conflictingFiles: ['src/app.ts'],
      message: 'Hit a conflict on 05-live-map-updates in src/app.ts — main is now mid-merge.',
    });
    const { deps: d } = deps({ mergeResult: conflict });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome.kind).toBe('swept');
    if (outcome.kind !== 'swept') throw new Error('unreachable');
    expect(outcome.decision).toEqual({
      kind: 'gate',
      action: 'merge-conflict',
      reason: conflict.message,
    });
  });
});

describe('laneBranchesFrom — assembles the pure lane candidates (issue 145)', () => {
  it('annotates each finished-unmerged branch with Receipt-backing, finish time, and verdict', () => {
    const scan: AutoMergeLaneScan = {
      branches: [finishedUnmerged(6, '06-a'), finishedUnmerged(7, '07-b')],
      previews: [preview(6, '06-a', { kind: 'clean' }), preview(7, '07-b', { kind: 'conflicts', files: [] })],
      midMerge: false,
    };
    const runLog = [receipt(6, '06-a', '2026-07-03T10:00:00.000Z')]; // only 06 has a Receipt
    const branches = laneBranchesFrom(scan, runLog);
    expect(branches).toEqual([
      {
        issueId: 6,
        slug: '06-a',
        receiptBacked: true,
        finished: '2026-07-03T10:00:00.000Z',
        verdict: { kind: 'clean' },
      },
      {
        issueId: 7,
        slug: '07-b',
        receiptBacked: false,
        finished: null,
        verdict: { kind: 'conflicts', files: [] },
      },
    ]);
  });
});
