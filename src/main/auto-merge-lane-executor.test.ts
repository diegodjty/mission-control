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
import { classifyAuthority } from '../shared/action-authority';

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
    usage: null,
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
    expect(outcome).toEqual({ kind: 'hold', reason: 'main-dirty', skipped: [] });
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
    expect(outcome).toEqual({ kind: 'hold', reason: 'mid-merge', skipped: [] });
    expect(mergeCalls).toEqual([]);
  });

  it('holds (live-solo-run) while a solo Run is live on main', async () => {
    const { deps: d, mergeCalls } = deps({ hasLiveSoloRun: () => true });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'live-solo-run', skipped: [] });
    expect(mergeCalls).toEqual([]);
  });
});

describe('sweepAutoMergeLane — Receipt-backing and verdict gate the merge (issue 145)', () => {
  it('never merges a stray branch (finished-unmerged, clean, but no Receipt in the log)', async () => {
    const { deps: d, mergeCalls } = deps({ runLog: [] }); // no Receipt for issue 5
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({ kind: 'hold', reason: 'no-clean-branch', skipped: [] });
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
    expect(outcome).toEqual({ kind: 'hold', reason: 'no-clean-branch', skipped: [] });
    expect(mergeCalls).toEqual([]);
  });
});

describe('sweepAutoMergeLane — an ACTUAL conflict from a merge leaves main mid-merge and gates (issue 145/146)', () => {
  it('classifies a conflicting merge as a gate — the mid-merge it leaves pauses the lane on the next sweep', async () => {
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

describe('sweepAutoMergeLane — a PREDICTED conflict pauses the lane, never touching git (issue 146)', () => {
  it('returns `paused` with the blocking merge-conflict approval and runs NO merge', async () => {
    const { deps: d, mergeCalls, keys } = deps({
      scanResult: {
        branches: [finishedUnmerged(6, '06-conflict')],
        previews: [preview(6, '06-conflict', { kind: 'conflicts', files: ['src/app.ts'] })],
        midMerge: false,
      },
      runLog: [receipt(6, '06-conflict', '2026-07-03T09:00:00.000Z')],
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({
      kind: 'paused',
      issueId: 6,
      slug: '06-conflict',
      action: 'merge-conflict',
      reason: expect.stringContaining('src/app.ts'),
      skipped: [],
    });
    // No git touch on a mere prediction — main is left untouched, no serializer use.
    expect(mergeCalls).toEqual([]);
    expect(keys).toEqual([]);
    // The pause rides the ADR-0011 blocking list — the SAME merge-conflict action, no new one.
    if (outcome.kind === 'paused') expect(classifyAuthority(outcome.action)).toBe('blocking');
  });

  it('pauses even when a later clean sibling exists — the conflict queues the whole lane', async () => {
    const { deps: d, mergeCalls } = deps({
      scanResult: {
        branches: [finishedUnmerged(6, '06-conflict'), finishedUnmerged(7, '07-clean')],
        previews: [
          preview(6, '06-conflict', { kind: 'conflicts', files: ['shared.ts'] }),
          preview(7, '07-clean', { kind: 'clean' }),
        ],
        midMerge: false,
      },
      // 06 finished FIRST, so it is finish-first — its conflict pauses before 07 is reached.
      runLog: [
        receipt(6, '06-conflict', '2026-07-03T09:00:00.000Z'),
        receipt(7, '07-clean', '2026-07-03T11:00:00.000Z'),
      ],
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome.kind).toBe('paused');
    if (outcome.kind !== 'paused') throw new Error('unreachable');
    expect(outcome.slug).toBe('06-conflict');
    expect(mergeCalls).toEqual([]); // 07 queued, never merged
  });
});

describe('sweepAutoMergeLane — an artifact offender is skipped while siblings keep merging (issue 106/146)', () => {
  it('skips the offender, merges a later clean sibling, and reports the skip', async () => {
    const { deps: d, mergeCalls } = deps({
      scanResult: {
        branches: [finishedUnmerged(6, '06-artifact'), finishedUnmerged(7, '07-clean')],
        previews: [
          preview(6, '06-artifact', { kind: 'artifact', paths: ['node_modules'] }),
          preview(7, '07-clean', { kind: 'clean' }),
        ],
        midMerge: false,
      },
      runLog: [
        receipt(6, '06-artifact', '2026-07-03T09:00:00.000Z'),
        receipt(7, '07-clean', '2026-07-03T11:00:00.000Z'),
      ],
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome.kind).toBe('swept');
    if (outcome.kind !== 'swept') throw new Error('unreachable');
    expect(outcome.slug).toBe('07-clean'); // the innocent sibling merged
    expect(mergeCalls).toEqual([['07-clean']]);
    expect(outcome.decision.kind).toBe('auto'); // clean sibling → passive note, not a gate
    expect(outcome.skipped).toEqual([{ issueId: 6, slug: '06-artifact', paths: ['node_modules'] }]);
  });

  it('holds when the only Receipt-backed branch is an artifact offender, still reporting the skip', async () => {
    const { deps: d, mergeCalls } = deps({
      scanResult: {
        branches: [finishedUnmerged(6, '06-artifact')],
        previews: [preview(6, '06-artifact', { kind: 'artifact', paths: ['dist'] })],
        midMerge: false,
      },
      runLog: [receipt(6, '06-artifact', '2026-07-03T09:00:00.000Z')],
    });
    const outcome = await sweepAutoMergeLane(d);
    expect(outcome).toEqual({
      kind: 'hold',
      reason: 'no-clean-branch',
      skipped: [{ issueId: 6, slug: '06-artifact', paths: ['dist'] }],
    });
    expect(mergeCalls).toEqual([]);
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
