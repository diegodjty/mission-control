import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordTimeoutSalvage,
  resolveTimeoutSalvage,
  readTimeoutSalvageRecord,
  TIMEOUT_SALVAGE_FILE_NAME,
} from './timeout-salvage-store';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeCompletionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mc-timeout-salvage-'));
  dirs.push(root);
  return join(root, 'completions');
}

const RECORD = {
  project: 'demo',
  issueId: 61,
  slug: '61-refactor',
  worktreePath: '/tmp/.afk-worktrees/61-refactor',
  timedOutAt: '2026-07-19T12:00:00.000Z',
};

describe('timeout-salvage-store (issue 170)', () => {
  it('records a strand and persists it as JSON beside the Receipts', async () => {
    const completionsRoot = await makeCompletionsRoot();
    await recordTimeoutSalvage(completionsRoot, RECORD);

    const raw = await readFile(join(completionsRoot, TIMEOUT_SALVAGE_FILE_NAME), 'utf8');
    expect(JSON.parse(raw)).toEqual([RECORD]);

    const found = await readTimeoutSalvageRecord(completionsRoot, RECORD.project, RECORD.issueId);
    expect(found).toEqual(RECORD);
  });

  it('creates the completions dir if it does not yet exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mc-timeout-salvage-'));
    dirs.push(root);
    const completionsRoot = join(root, 'nested', 'completions');
    await recordTimeoutSalvage(completionsRoot, RECORD);
    const found = await readTimeoutSalvageRecord(completionsRoot, RECORD.project, RECORD.issueId);
    expect(found).toEqual(RECORD);
  });

  it('resolveTimeoutSalvage clears exactly the named record', async () => {
    const completionsRoot = await makeCompletionsRoot();
    const other = { ...RECORD, issueId: 62 };
    await recordTimeoutSalvage(completionsRoot, RECORD);
    await recordTimeoutSalvage(completionsRoot, other);

    await resolveTimeoutSalvage(completionsRoot, RECORD.project, RECORD.issueId);

    expect(await readTimeoutSalvageRecord(completionsRoot, RECORD.project, RECORD.issueId)).toBeNull();
    expect(await readTimeoutSalvageRecord(completionsRoot, other.project, other.issueId)).toEqual(
      other,
    );
  });

  it('readTimeoutSalvageRecord returns null for an unreadable/missing store', async () => {
    const completionsRoot = await makeCompletionsRoot();
    expect(await readTimeoutSalvageRecord(completionsRoot, 'demo', 1)).toBeNull();
  });

  it('re-recording the same project+issue replaces rather than duplicates', async () => {
    const completionsRoot = await makeCompletionsRoot();
    await recordTimeoutSalvage(completionsRoot, RECORD);
    const retimedOut = { ...RECORD, timedOutAt: '2026-07-19T13:00:00.000Z' };
    await recordTimeoutSalvage(completionsRoot, retimedOut);

    const raw = await readFile(join(completionsRoot, TIMEOUT_SALVAGE_FILE_NAME), 'utf8');
    expect(JSON.parse(raw)).toEqual([retimedOut]);
  });
});
