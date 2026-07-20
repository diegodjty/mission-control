/**
 * Unit tests for the pending-usage stash and the sticky ingest merge (issue
 * 143, hardened by issue 177 — a re-ingest of an already-telemetered Receipt
 * must never clobber `usage` back to null). Runs against a real `RunLogStore`
 * over a throwaway scratch dir, like `run-log-store.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogStore } from './run-log-store';
import { applyRunUsage, PendingRunUsageStash, stickyIngestUsage } from './run-usage-pending';
import type { RunLogRecord } from '../shared/ipc-contract';
import type { RunUsage } from '../shared/run-telemetry';

let base: string;

function record(over: Partial<RunLogRecord> = {}): RunLogRecord {
  return {
    id: 'receipt:03-slug:2026-07-19T00:00:00.000Z',
    capturedAt: '2026-07-19T00:00:00.000Z',
    slug: '03-slug',
    title: null,
    issue: '3 — slug',
    issueId: 3,
    whatChanged: 'Did the thing.',
    tryIt: 'Try it.',
    verified: 'Verified it.',
    bookkeeping: 'Touched files.',
    docDrift: 'none',
    detail: null,
    outcome: 'completed',
    usage: null,
    ...over,
  };
}

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    durationMs: 5000,
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    tier: 'sonnet',
    ...over,
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mc-run-usage-pending-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('PendingRunUsageStash', () => {
  it('take() consumes (reads + deletes) a stashed value', () => {
    const stash = new PendingRunUsageStash();
    stash.set('/repo', 3, usage());
    expect(stash.take('/repo', 3)).toEqual(usage());
    expect(stash.take('/repo', 3)).toBeUndefined();
  });

  it('keys by normalized project path + issue id, independent of trailing slash', () => {
    const stash = new PendingRunUsageStash();
    stash.set('/repo/', 3, usage());
    expect(stash.take('/repo', 3)).toEqual(usage());
  });
});

describe('applyRunUsage', () => {
  it('patches usage into the latest usage-less record for the issue', async () => {
    const store = new RunLogStore(base);
    const stash = new PendingRunUsageStash();
    const projectPath = join(base, 'projA');
    await store.append(projectPath, record());

    const patched = await applyRunUsage(store, stash, projectPath, 3, usage());
    expect(patched?.usage).toEqual(usage());
    const back = await store.read(projectPath);
    expect(back[0].usage).toEqual(usage());
  });

  it('stashes the usage when no record for the issue exists yet (process exits before the Receipt)', async () => {
    const store = new RunLogStore(base);
    const stash = new PendingRunUsageStash();
    const projectPath = join(base, 'projA');

    const patched = await applyRunUsage(store, stash, projectPath, 3, usage());
    expect(patched).toBeNull();
    expect(stash.take(projectPath, 3)).toEqual(usage());
  });
});

describe('stickyIngestUsage (issue 177)', () => {
  it('applies the pending usage onto a fresh Receipt record', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    const finalRecord = await stickyIngestUsage(store, projectPath, record(), usage());
    expect(finalRecord.usage).toEqual(usage());
  });

  it('falls back to the already-persisted usage when pending is gone (the double-read case)', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    // First ingest applied usage and persisted it.
    await store.append(projectPath, record({ usage: usage() }));

    // A second ingest of the SAME Receipt (stability double-read, another
    // Window's independent watch, a restart re-scan): pending is already
    // consumed, so a naive merge would null out the usage just persisted.
    const finalRecord = await stickyIngestUsage(store, projectPath, record({ usage: null }), undefined);
    expect(finalRecord.usage).toEqual(usage());
  });

  it('stays null when there is neither a pending nor a persisted usage', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    const finalRecord = await stickyIngestUsage(store, projectPath, record(), undefined);
    expect(finalRecord.usage).toBeNull();
  });
});
