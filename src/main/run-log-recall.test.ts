/**
 * Integration check for on-demand recall from the durable Run log — issue 39,
 * ADR-0009 acceptance criterion: "the Dispatcher can retrieve an earlier
 * Completion block from the Run log on demand (a late issue referencing an early
 * one works)."
 *
 * The rolling-synthesis fold (pure) is what DROPS an early block from the
 * Dispatcher's bounded active context; the durable `RunLogStore` (adapter,
 * issue 34) is what keeps it. This test wires the two together against a
 * throwaway scratch dir — never the real userData dir — and proves the block a
 * long drain folded out of active context is still recallable from disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogStore } from './run-log-store';
import type { RunLogRecord } from '../shared/ipc-contract';
import { toCompletionEvent } from '../shared/dispatcher-input-contract';
import {
  emptyState,
  foldEvents,
  recallBlock,
} from '../shared/dispatcher-rolling-synthesis';

let base: string;

function record(over: Partial<RunLogRecord> = {}): RunLogRecord {
  return {
    id: 'sess',
    capturedAt: '2026-07-02T10:00:00.000Z',
    slug: '01-thing',
    title: '01 — Thing',
    issue: '1 — thing',
    issueId: 1,
    whatChanged: 'Did a thing.',
    tryIt: 'Try it.',
    verified: 'Ran it.',
    bookkeeping: 'Touched a file.',
    docDrift: 'none',
    detail: null,
    outcome: 'completed',
    usage: null,
    ...over,
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mc-recall-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('on-demand recall from the Run log after a fold', () => {
  it('a block dropped from bounded active context is still recallable from disk', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'repoA');

    // A drain finishes 12 clean issues; every one is persisted to the Run log.
    const records: RunLogRecord[] = [];
    for (let i = 1; i <= 12; i++) {
      const rec = record({
        id: `s${i}`,
        issueId: i,
        capturedAt: `2026-07-02T10:${String(i).padStart(2, '0')}:00.000Z`,
        whatChanged: `Change from issue ${i}.`,
      });
      await store.append(projectPath, rec);
      records.push(rec);
    }

    // The Dispatcher folds the same stream through its bounded active context
    // (recent window of 3). Early issues age out — dropped from verbatim.
    const events = records.map((r) => toCompletionEvent({ id: r.id, record: r }));
    const state = foldEvents(emptyState(), events, { recentWindow: 3 });

    // Issue 1 is NOT in active context any more (bounded working memory)...
    const inActive =
      state.recentBlocks.some((e) => e.issueId === 1) ||
      state.openThreads.some((e) => e.issueId === 1);
    expect(inActive).toBe(false);
    expect(state.recentBlocks.length).toBe(3);

    // ...but a late issue references it, so the Dispatcher re-reads it from the
    // durable Run log on disk — full detail intact.
    const persisted = await store.read(projectPath);
    const recalled = recallBlock(persisted, 1);
    expect(recalled).not.toBeNull();
    expect(recalled?.issueId).toBe(1);
    expect(recalled?.whatChanged).toBe('Change from issue 1.');
    expect(recalled?.tryIt).toBe('Try it.'); // full block, not just the folded highlight
  });

  it('recall is per-Project isolated — another Project cannot see the block', async () => {
    const store = new RunLogStore(base);
    const projA = join(base, 'repoA');
    const projB = join(base, 'repoB');
    await store.append(projA, record({ id: 'a1', issueId: 5 }));

    expect(recallBlock(await store.read(projA), 5)?.id).toBe('a1');
    expect(recallBlock(await store.read(projB), 5)).toBeNull();
  });
});
