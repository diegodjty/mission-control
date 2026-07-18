/**
 * Integration check for the Run log store (ADAPTER) — PRD-dispatcher Testing
 * Decisions: adapters are verified by integration runs against a throwaway
 * scratch dir, never the real userData dir. Proves the three durability
 * guarantees the acceptance criteria call for: persist/read round-trips,
 * per-Project isolation, and survival across a simulated app restart (a fresh
 * store instance over the same base dir reads back what a prior one wrote).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogStore } from './run-log-store';
import type { RunLogRecord } from '../shared/ipc-contract';

let base: string;

function record(over: Partial<RunLogRecord> = {}): RunLogRecord {
  return {
    id: 'session-1',
    capturedAt: '2026-07-02T10:00:00.000Z',
    slug: '03-run-issue-in-pane',
    title: '03 — Run one issue in a Pane',
    issue: '3 — run-issue-in-pane',
    issueId: 3,
    whatChanged: 'Runs now open in a Pane.',
    tryIt: 'Click Run on an eligible issue.',
    verified: 'Loaded the Map and clicked Run.',
    bookkeeping: 'Touched Pane.tsx.',
    docDrift: 'none',
    detail: null,
    outcome: 'completed',
    usage: null,
    ...over,
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mc-runlog-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('RunLogStore — persist and read', () => {
  it('round-trips a record', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    await store.append(projectPath, record());
    const back = await store.read(projectPath);
    expect(back).toHaveLength(1);
    expect(back[0].issueId).toBe(3);
    expect(back[0].outcome).toBe('completed');
    expect(back[0].whatChanged).toBe('Runs now open in a Pane.');
  });

  it('returns [] for a Project with no log yet', async () => {
    const store = new RunLogStore(base);
    expect(await store.read(join(base, 'never-run'))).toEqual([]);
  });

  it('orders multiple records newest-first', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    await store.append(projectPath, record({ id: 's1', capturedAt: '2026-07-02T10:00:00.000Z', issueId: 1 }));
    await store.append(projectPath, record({ id: 's2', capturedAt: '2026-07-02T11:00:00.000Z', issueId: 2 }));
    const back = await store.read(projectPath);
    expect(back.map((r) => r.issueId)).toEqual([2, 1]);
  });

  it('collapses a re-capture (same id) to the latest version', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    // First capture caught a still-streaming block (unknown); the re-capture
    // caught the finished block (completed) — same session id.
    await store.append(projectPath, record({ id: 'sX', outcome: 'unknown', whatChanged: null, capturedAt: '2026-07-02T10:00:00.000Z' }));
    await store.append(projectPath, record({ id: 'sX', outcome: 'completed', whatChanged: 'final', capturedAt: '2026-07-02T10:00:03.000Z' }));
    const back = await store.read(projectPath);
    expect(back).toHaveLength(1);
    expect(back[0].outcome).toBe('completed');
    expect(back[0].whatChanged).toBe('final');
  });

  it('round-trips usage telemetry, and a later re-append patches it in (issue 143)', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    // A Receipt lands with no telemetry yet (the process hasn't exited).
    await store.append(projectPath, record({ id: 'sT' }));
    let back = await store.read(projectPath);
    expect(back[0].usage).toBeNull();

    // The process exits later; main patches the SAME id with usage.
    await store.append(
      projectPath,
      record({
        id: 'sT',
        usage: {
          durationMs: 12_000,
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.02,
          tier: 'sonnet',
        },
      }),
    );
    back = await store.read(projectPath);
    expect(back).toHaveLength(1);
    expect(back[0].usage).toEqual({
      durationMs: 12_000,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.02,
      tier: 'sonnet',
    });
  });

  it('skips a corrupt trailing line rather than failing the read', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'projA');
    await store.append(projectPath, record({ id: 'good' }));
    // Simulate a crash mid-append leaving a partial JSON line.
    const files = await readdir(join(base, 'run-logs'));
    await writeFile(join(base, 'run-logs', files[0]), '{"id":"broken","capturedAt":', { flag: 'a' });
    const back = await store.read(projectPath);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe('good');
  });
});

describe('RunLogStore — per-Project isolation', () => {
  it('keeps two Projects strictly separate', async () => {
    const store = new RunLogStore(base);
    const projA = join(base, 'repoA');
    const projB = join(base, 'repoB');
    await store.append(projA, record({ id: 'a1', issueId: 11 }));
    await store.append(projB, record({ id: 'b1', issueId: 22 }));

    const a = await store.read(projA);
    const b = await store.read(projB);
    expect(a.map((r) => r.issueId)).toEqual([11]);
    expect(b.map((r) => r.issueId)).toEqual([22]);
  });

  it('treats a trailing-slash path as the same Project (normalised key)', async () => {
    const store = new RunLogStore(base);
    const projectPath = join(base, 'repoA');
    await store.append(projectPath, record({ id: 'a1', issueId: 11 }));
    const back = await store.read(`${projectPath}/`);
    expect(back.map((r) => r.issueId)).toEqual([11]);
  });
});

describe('RunLogStore — survives a simulated restart', () => {
  it('a fresh store instance over the same base dir reads prior records', async () => {
    const projectPath = join(base, 'repoA');
    // "Before restart": one store writes two records.
    const before = new RunLogStore(base);
    await before.append(projectPath, record({ id: 's1', issueId: 1 }));
    await before.append(projectPath, record({ id: 's2', issueId: 2, capturedAt: '2026-07-02T12:00:00.000Z' }));

    // "After restart": a brand-new store (no shared in-memory state) over the
    // same on-disk base dir must see both.
    const after = new RunLogStore(base);
    const back = await after.read(projectPath);
    expect(back.map((r) => r.issueId).sort()).toEqual([1, 2]);
  });
});
