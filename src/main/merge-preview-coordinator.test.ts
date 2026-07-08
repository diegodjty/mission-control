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

describe('preview coordinator — artifact supersession through the cache (issue 106)', () => {
  it('surfaces the artifact verdict for the offender and clean for siblings once the recompute lands', async () => {
    const simulate = vi.fn(
      async (): Promise<SequenceSimOutcome> => ({
        steps: [{ kind: 'clean' }, { kind: 'clean' }],
        artifactPaths: [[], ['node_modules']],
      }),
    );
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });
    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    const out = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    expect(out).toEqual([
      { issueId: 4, slug: '04-a', verdict: { kind: 'clean' } },
      { issueId: 7, slug: '07-b', verdict: { kind: 'artifact', paths: ['node_modules'] } },
    ]);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('re-queues within one tick when the offender tip moves, then shows the recomputed real verdict', async () => {
    // First recompute flags b as an offender; the second (after its tip moves)
    // finds the artifact gone — the freshness stamp carries the artifact fact.
    const outcomes: SequenceSimOutcome[] = [
      { steps: [{ kind: 'clean' }, { kind: 'clean' }], artifactPaths: [[], ['node_modules']] },
      { steps: [{ kind: 'clean' }, { kind: 'clean' }], artifactPaths: [[], []] },
    ];
    let call = 0;
    const simulate = vi.fn(async (): Promise<SequenceSimOutcome> => outcomes[call++]);
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(
      coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: stampAB })[1]
        .verdict,
    ).toEqual({ kind: 'artifact', paths: ['node_modules'] });

    // b amended → its tip moved → stale → recalculating + a second recompute.
    const movedB: PreviewStamp = { defaultTip: 'main-aaa', branchTips: ['t4', 'AMENDED'] };
    const stale = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: movedB });
    expect(stale.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);

    const fresh = coord.read({ serializerKey: KEY, repoPath: KEY, candidates: [a, b], currentStamp: movedB });
    expect(fresh[1].verdict).toEqual({ kind: 'clean' });
  });
});

describe('preview coordinator — per-repo independence (issue 108)', () => {
  const KEY_A = '/repo/a';
  const KEY_B = '/repo/b';

  it('invalidating both repos queues ONE recompute EACH, running in parallel on distinct keys', async () => {
    const gateA = deferred<SequenceSimOutcome>();
    const gateB = deferred<SequenceSimOutcome>();
    const started: string[] = [];
    const simulate = vi.fn((repoPath: string) => {
      started.push(repoPath);
      return repoPath === KEY_A ? gateA.promise : gateB.promise;
    });
    const serializer = createRepoSerializer();
    const coord = createPreviewCoordinator({ serializer, isSupported: () => true, simulate });

    // Invalidate BOTH repos (cold cache) in the same tick — as a scan spanning
    // two member repos does when both have a stale batch.
    coord.read({ serializerKey: KEY_A, repoPath: KEY_A, candidates: [a, b], currentStamp: stampAB });
    coord.read({ serializerKey: KEY_B, repoPath: KEY_B, candidates: [a, b], currentStamp: stampAB });

    // One pending recompute EACH — not one shared, not two queued on one key.
    expect(coord.pending(KEY_A)).toBe(true);
    expect(coord.pending(KEY_B)).toBe(true);

    await tick();
    // BOTH simulations are in flight AT ONCE — distinct serializer keys don't
    // serialize against each other, so the two repos recompute in parallel.
    expect(started.sort()).toEqual([KEY_A, KEY_B]);
    expect(serializer.activeKeys()).toBe(2);
    expect(simulate).toHaveBeenCalledTimes(2);

    // Resolve A with a conflict, B clean — each repo caches its OWN outcome.
    gateA.resolve({ steps: [{ kind: 'clean' }, { kind: 'conflict', files: ['a.txt'] }] });
    gateB.resolve(cleanChain2);
    await tick();

    const outA = coord.read({ serializerKey: KEY_A, repoPath: KEY_A, candidates: [a, b], currentStamp: stampAB });
    const outB = coord.read({ serializerKey: KEY_B, repoPath: KEY_B, candidates: [a, b], currentStamp: stampAB });
    // Repo A's conflict verdict never touched repo B's clean verdicts.
    expect(outA.map((p) => p.verdict)).toEqual([
      { kind: 'clean' },
      { kind: 'conflicts', files: ['a.txt'] },
    ]);
    expect(outB.map((p) => p.verdict)).toEqual([{ kind: 'clean' }, { kind: 'clean' }]);
    // Still exactly one simulation per repo (coalesced) — the fresh reads recompute nothing.
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('a stale repo A recomputes without disturbing repo B’s fresh cache', async () => {
    const simulate = vi.fn(async (repoPath: string): Promise<SequenceSimOutcome> =>
      repoPath === KEY_A
        ? { steps: [{ kind: 'clean' }, { kind: 'clean' }] }
        : { steps: [{ kind: 'clean' }, { kind: 'clean' }] },
    );
    const coord = createPreviewCoordinator({
      serializer: createRepoSerializer(),
      isSupported: () => true,
      simulate,
    });

    // Warm both repos.
    coord.read({ serializerKey: KEY_A, repoPath: KEY_A, candidates: [a, b], currentStamp: stampAB });
    coord.read({ serializerKey: KEY_B, repoPath: KEY_B, candidates: [a, b], currentStamp: stampAB });
    await tick();
    expect(simulate).toHaveBeenCalledTimes(2);

    // Only repo A's main moves → only repo A re-queues; repo B stays fresh.
    const staleA = coord.read({
      serializerKey: KEY_A,
      repoPath: KEY_A,
      candidates: [a, b],
      currentStamp: stampAB_movedMain,
    });
    expect(staleA.every((p) => p.verdict?.kind === 'recalculating')).toBe(true);
    const freshB = coord.read({ serializerKey: KEY_B, repoPath: KEY_B, candidates: [a, b], currentStamp: stampAB });
    expect(freshB.every((p) => p.verdict?.kind === 'clean')).toBe(true);
    expect(coord.pending(KEY_A)).toBe(true);
    expect(coord.pending(KEY_B)).toBe(false); // repo B untouched by A's staleness

    await tick();
    // One extra simulation — repo A's — never repo B's.
    expect(simulate).toHaveBeenCalledTimes(3);
    expect(simulate.mock.calls.filter((c) => c[0] === KEY_B)).toHaveLength(1);
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
