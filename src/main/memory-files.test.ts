import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCoreMemory, writeDrainJournal } from './memory-files';
import type { RunLogRecord } from '../shared/ipc-contract';

let memoryRoot: string;

beforeEach(async () => {
  memoryRoot = await mkdtemp(join(tmpdir(), 'mc-memory-'));
});

afterEach(async () => {
  await rm(memoryRoot, { recursive: true, force: true });
});

function record(over: Partial<RunLogRecord>): RunLogRecord {
  return {
    id: 'receipt:02-second-step:2026-07-04T10:00:00.000Z',
    capturedAt: '2026-07-04T10:00:00.000Z',
    slug: '02-second-step',
    title: 'Second step',
    issue: '02 — second-step',
    issueId: 2,
    whatChanged: 'The thing works now.',
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed',
    usage: null,
    ...over,
  };
}

describe('readCoreMemory', () => {
  it('reads memory/CORE.md content', async () => {
    await writeFile(join(memoryRoot, 'CORE.md'), '- Node 22 via nvm.\n', 'utf8');
    expect(await readCoreMemory(memoryRoot)).toBe('- Node 22 via nvm.\n');
  });

  it('resolves null for a missing CORE (or a missing memory dir entirely)', async () => {
    expect(await readCoreMemory(memoryRoot)).toBeNull();
    expect(await readCoreMemory(join(memoryRoot, 'nope'))).toBeNull();
  });
});

describe('writeDrainJournal', () => {
  it('writes ONE dated entry naming every Run and its outcome', async () => {
    const outcome = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-04T18:30:00.000Z',
      reason: 'Drain complete: nothing eligible remains.',
      records: [
        record({}),
        record({
          id: 'receipt:05-manual-check:x',
          slug: '05-manual-check',
          issueId: 5,
          outcome: 'needs-verification',
          whatChanged: null,
          detail: 'Ready for manual verification.',
        }),
      ],
    });
    expect(outcome.written).toBe(true);
    expect(outcome.fileName).toBe('2026-07-04.md');
    expect(outcome.error).toBeNull();
    const entries = await readdir(join(memoryRoot, 'journal'));
    expect(entries).toEqual(['2026-07-04.md']);
    const content = await readFile(outcome.path!, 'utf8');
    expect(content).toContain('02-second-step: completed');
    expect(content).toContain('05-manual-check: parked (needs manual verification)');
    expect(content).toContain('Drain complete: nothing eligible remains.');
  });

  it('gives a second drain the same day its own entry — the first is untouched', async () => {
    const first = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-04T12:00:00.000Z',
      reason: 'first',
      records: [record({})],
    });
    const second = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-04T20:00:00.000Z',
      reason: 'second',
      records: [],
    });
    expect(first.fileName).toBe('2026-07-04.md');
    expect(second.fileName).toBe('2026-07-04-2.md');
    expect(await readFile(first.path!, 'utf8')).toContain('- Reason: first');
    expect(await readFile(second.path!, 'utf8')).toContain('- Reason: second');
  });

  it('creates the journal dir when the memory skeleton lacks it', async () => {
    // memoryRoot exists (a workbench memory dir) but journal/ does not yet.
    const outcome = await writeDrainJournal({
      memoryRoot: join(memoryRoot, 'memory'),
      endedAt: '2026-07-04T12:00:00.000Z',
      reason: 'r',
      records: [],
    });
    expect(outcome.written).toBe(true);
    expect(await readdir(join(memoryRoot, 'memory', 'journal'))).toEqual(['2026-07-04.md']);
  });

  it('reports (never throws) when the journal root cannot be created', async () => {
    // A FILE where the journal dir should be makes mkdir fail.
    await mkdir(join(memoryRoot, 'memory'), { recursive: true });
    await writeFile(join(memoryRoot, 'memory', 'journal'), 'not a dir', 'utf8');
    const outcome = await writeDrainJournal({
      memoryRoot: join(memoryRoot, 'memory'),
      endedAt: '2026-07-04T12:00:00.000Z',
      reason: 'r',
      records: [],
    });
    expect(outcome.written).toBe(false);
    expect(outcome.error).toBeTruthy();
  });
});
