import { describe, it, expect, vi } from 'vitest';
import { createRepoSerializer } from '../shared/repo-serializer';
import { createPreviewCoordinator } from './merge-preview-coordinator';
import type { MergeCandidate, PreviewStamp, SequenceSimOutcome } from '../shared/merge-preview';

const KEY = '/repo/a';
const a: MergeCandidate = { issueId: 4, slug: '04-a' };
const b: MergeCandidate = { issueId: 7, slug: '07-b' };
const c: MergeCandidate = { issueId: 9, slug: '09-c' };

const stampAB: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7'] };
const stampAB_movedMain: PreviewStamp = { defaultTip: 'main-bbb', branchTips: ['t4', 't7'] };
const stampABC: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 't7', 't9'] };

const cleanChain2: SequenceSimOutcome = { steps: [{ kind: 'clean' }, { kind: 'clean' }] };

/** A promise whose resolve is exposed so a test can hold a simulation open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('preview coordinator — git-floor gate', () => {
  it('returns no previews and never simulates when git is below the floor', () => {
    const simulate = vi.fn<(repoPath: string, stamp: PreviewStamp) => Promise<SequenceSimOutcome>>();
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => false,
      simulate,
    });
    expect(coord.supported).toBe(false);
    expect(
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB }),
    ).toEqual([]);
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe('preview coordinator — mid-merge suspension (issue 107)', () => {
  it('suspends every branch and queues NO recompute while mid-merge', () => {
    const simulate = vi.fn<(repoPath: string, stamp: PreviewStamp) => Promise<SequenceSimOutcome>>();
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    const out = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b],
      currentStamp: stampAB,
      midMerge: true,
    });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'suspended' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'suspended' } },
    ]);
    // The whole point of suspension: no task enqueued, nothing computed.
    expect(coord.pending(KEY)).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('does not disturb a cache built before the mid-merge, and resumes on the next clean tick', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => cleanChain2);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    // Warm a fresh cache before the merge.
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // Mid-merge ticks: suspended, and still no new recompute.
    const suspended = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b],
      currentStamp: stampAB,
      midMerge: true,
    });
    expect(suspended.every((p) => p.verdict?.kind === 'suspended')).toBe(true);
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // Abort returned main to exactly the pre-merge tip → the cache is still valid,
    // so previews resume immediately with no recompute (freshness via the stamp).
    const resumed = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    expect(resumed.map((p) => p.verdict)).toEqual([{ kind: 'clean' }, { kind: 'clean' }]);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('resolve + commit moves main → the resumed tick recomputes for the new tip', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => cleanChain2);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // Suspended while mid-merge (no recompute).
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB, midMerge: true });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // Resolve + commit moved main → the pre-merge cache is stale → recalculating +
    // exactly one fresh recompute.
    const resumed = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b],
      currentStamp: stampAB_movedMain,
    });
    expect(resumed.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);
  });
});

describe('preview coordinator — full-batch sequence cache + recompute (issue 105)', () => {
  it('shows recalculating for every branch on a cold cache, then the fresh sequence once it lands', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => cleanChain2);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    const cold = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    expect(cold.map((p) => p.verdict)).toEqual([{ kind: 'recalculating' }, { kind: 'recalculating' }]);
    expect(coord.pending(KEY)).toBe(true);

    await tick();
    expect(coord.pending(KEY)).toBe(false);

    const fresh = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    expect(fresh.map((p) => p.verdict)).toEqual([{ kind: 'clean' }, { kind: 'clean' }]);
    // ONE simulation for the whole batch — not one per branch.
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('a mid-sequence conflict badges clean / conflicts / blocked-behind across the batch', async () => {
    const simulate = vi.fn(
      async (): Promise<SequenceSimOutcome> => ({
        steps: [{ kind: 'clean' }, { kind: 'conflict', files: ['shared.txt'] }],
      }),
    );
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b, c], currentStamp: stampABC });
    await tick();
    const out = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b, c],
      currentStamp: stampABC,
    });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'clean' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'conflicts', files: ['shared.txt'] } },
      { issueId: 9, slug: '09-c', verdict: { kind: 'blocked', behindIssueId: 7 } },
    ]);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of invalidations into ONE pending recompute per repo', async () => {
    const gate = deferred<SequenceSimOutcome>();
    const simulate = vi.fn(() => gate.promise);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    for (let i = 0; i < 10; i++) {
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    }
    expect(coord.pending(KEY)).toBe(true);

    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(coord.pending(KEY)).toBe(true);

    gate.resolve(cleanChain2);
    await tick();
    expect(coord.pending(KEY)).toBe(false);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('re-checks on completion: a moved main tip re-queues, a stable one does not', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => cleanChain2);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    // Same stamp → fresh, no new recompute.
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // main moved → recalculating + a second recompute.
    const stale = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b],
      currentStamp: stampAB_movedMain,
    });
    expect(stale.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('a NEW finished branch appearing invalidates the batch and recomputes within one tick', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => cleanChain2);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // A third finished branch appears → the cached 2-branch sequence is stale.
    const grown = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [a, b, c],
      currentStamp: stampABC,
    });
    expect(grown).toHaveLength(3);
    expect(grown.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('a DISCARDED branch (batch shrank) invalidates and recomputes', async () => {
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => ({ steps: [{ kind: 'clean' }] }));
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    // b discarded → only a remains.
    const stampA: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4'] };
    const out = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a], currentStamp: stampA });
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toEqual({ kind: 'recalculating' });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);
  });
});

describe('preview coordinator — serializer discipline', () => {
  it('a real action queued during a burst waits behind AT MOST the one in-flight preview task', async () => {
    const serializer = createRepoSerializer();
    const gate = deferred<SequenceSimOutcome>();
    const order: string[] = [];
    const simulate = vi.fn(async () => {
      order.push('preview-start');
      const v = await gate.promise;
      order.push('preview-end');
      return v;
    });
    const coord = createPreviewCoordinator({ serializer, isSupported: () => true, simulate });

    for (let i = 0; i < 5; i++) {
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    }
    const merge = serializer.run(KEY, () => {
      order.push('merge');
    });

    await tick();
    expect(order).toEqual(['preview-start']);

    gate.resolve(cleanChain2);
    await merge;
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['preview-start', 'preview-end', 'merge']);
  });
});
