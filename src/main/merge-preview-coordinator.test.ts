import { describe, it, expect, vi } from 'vitest';
import { createRepoSerializer } from '../shared/repo-serializer';
import { createPreviewCoordinator } from './merge-preview-coordinator';
import type { MergeCandidate, PreviewStamp, RawSimOutcome } from '../shared/merge-preview';

const KEY = '/repo/a';
const first: MergeCandidate = { issueId: 4, slug: '04-first' };
const second: MergeCandidate = { issueId: 7, slug: '07-second' };

const stampA: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['b4-aaa'] };
const stampB: PreviewStamp = { defaultTip: 'main-bbb', branchTips: ['b4-aaa'] };

/** A promise whose resolve is exposed so a test can hold a simulation open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('preview coordinator — git-floor gate (issue 104)', () => {
  it('returns no previews and never simulates when git is below the floor', () => {
    const simulate = vi.fn<(repoPath: string, stamp: PreviewStamp) => Promise<RawSimOutcome>>();
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => false,
      simulate,
    });
    expect(coord.supported).toBe(false);
    expect(
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA }),
    ).toEqual([]);
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe('preview coordinator — cache read + recompute (issue 104)', () => {
  it('shows recalculating on a cold cache, then the fresh verdict once the recompute lands', async () => {
    const simulate = vi.fn(async (): Promise<RawSimOutcome> => ({ kind: 'clean' }));
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    const cold = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first],
      currentStamp: stampA,
    });
    expect(cold).toEqual([{ issueId: 4, slug: '04-first', verdict: { kind: 'recalculating' } }]);
    expect(coord.pending(KEY)).toBe(true);

    await tick();
    expect(coord.pending(KEY)).toBe(false);

    const fresh = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first],
      currentStamp: stampA,
    });
    expect(fresh).toEqual([{ issueId: 4, slug: '04-first', verdict: { kind: 'clean' } }]);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('surfaces a conflict verdict with the offending files', async () => {
    const simulate = vi.fn(
      async (): Promise<RawSimOutcome> => ({ kind: 'conflict', files: ['src/x.ts'] }),
    );
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA });
    await tick();
    const out = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first],
      currentStamp: stampA,
    });
    expect(out[0].verdict).toEqual({ kind: 'conflicts', files: ['src/x.ts'] });
  });

  it('coalesces a burst of invalidations into ONE pending recompute per repo', async () => {
    const gate = deferred<RawSimOutcome>();
    const simulate = vi.fn(() => gate.promise);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    // First read queues the recompute; ten more while it is pending queue nothing.
    for (let i = 0; i < 10; i++) {
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA });
    }
    expect(coord.pending(KEY)).toBe(true);

    // The serializer runs the ONE queued task on a microtask; let it start. It
    // then blocks on the (unresolved) gate, so pending stays true and no burst
    // read queued a second simulation.
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(coord.pending(KEY)).toBe(true);

    gate.resolve({ kind: 'clean' });
    await tick();
    expect(coord.pending(KEY)).toBe(false);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('re-checks the stamp on completion: a moved tip re-queues, a stable one does not', async () => {
    const simulate = vi.fn(async (): Promise<RawSimOutcome> => ({ kind: 'clean' }));
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA });
    await tick();
    // Same stamp → fresh, no new recompute.
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(1);

    // main moved (stampB) → recalculating + a second recompute.
    const stale = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first],
      currentStamp: stampB,
    });
    expect(stale[0].verdict).toEqual({ kind: 'recalculating' });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('in a two-branch batch, only the first branch is simulated / badged', async () => {
    const simulate = vi.fn(async (): Promise<RawSimOutcome> => ({ kind: 'clean' }));
    const twoStamp: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['b4-aaa', 'b7-aaa'] };
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first, second],
      currentStamp: twoStamp,
    });
    await tick();
    const out = coord.read({
      serializerKey: KEY,
      repoPath: KEY,
      candidates: [first, second],
      currentStamp: twoStamp,
    });
    expect(out[0].verdict).toEqual({ kind: 'clean' });
    expect(out[1].verdict).toBeNull();
    // Only one simulation ran for the whole batch — the first branch's.
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});

describe('preview coordinator — serializer discipline (issue 104)', () => {
  it('a real action queued during a burst waits behind AT MOST the one in-flight preview task', async () => {
    const serializer = createRepoSerializer();
    const gate = deferred<RawSimOutcome>();
    const order: string[] = [];
    const simulate = vi.fn(async () => {
      order.push('preview-start');
      const v = await gate.promise;
      order.push('preview-end');
      return v;
    });
    const coord = createPreviewCoordinator({ serializer, isSupported: () => true, simulate });

    // Queue the preview recompute, then a burst that must coalesce (no extra tasks).
    for (let i = 0; i < 5; i++) {
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [first], currentStamp: stampA });
    }
    // A real Merge/commit queued on the SAME serializer key afterwards.
    const merge = serializer.run(KEY, () => {
      order.push('merge');
    });

    // The merge cannot run until the single in-flight preview finishes.
    await tick();
    expect(order).toEqual(['preview-start']);

    gate.resolve({ kind: 'clean' });
    await merge;
    // Exactly one preview ran (coalesced), and the merge ran right after it —
    // never queued behind a backlog of preview tasks.
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['preview-start', 'preview-end', 'merge']);
  });
});
