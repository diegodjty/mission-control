import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionLastSeenStore } from './attention-last-seen';

/**
 * The briefing's last-seen stamps persist in app userData (issue 80,
 * ADR-0016) — app-level state, never workbench data — and survive a restart
 * (a fresh store instance reads the same file back).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-last-seen-'));
  dirs.push(dir);
  return dir;
}

describe('AttentionLastSeenStore', () => {
  it('starts empty (everything unseen) when no file exists', async () => {
    const store = new AttentionLastSeenStore(await tempDir());
    await store.load();
    expect(store.get('alpha')).toBeNull();
  });

  it('marks projects seen and a NEW instance reads the stamps back (restart persistence)', async () => {
    const dir = await tempDir();
    const store = new AttentionLastSeenStore(dir);
    await store.load();
    const result = await store.markAll(['alpha', 'beta'], '2026-07-05T12:00:00Z');
    expect(result).toEqual({
      alpha: '2026-07-05T12:00:00Z',
      beta: '2026-07-05T12:00:00Z',
    });
    expect(store.get('alpha')).toBe('2026-07-05T12:00:00Z');

    const reopened = new AttentionLastSeenStore(dir);
    await reopened.load();
    expect(reopened.get('alpha')).toBe('2026-07-05T12:00:00Z');
    expect(reopened.get('beta')).toBe('2026-07-05T12:00:00Z');
    expect(reopened.get('gamma')).toBeNull();
  });

  it('a later view advances stamps; unlisted projects keep theirs', async () => {
    const dir = await tempDir();
    const store = new AttentionLastSeenStore(dir);
    await store.load();
    await store.markAll(['alpha', 'beta'], '2026-07-05T12:00:00Z');
    await store.markAll(['alpha'], '2026-07-05T13:00:00Z');
    expect(store.get('alpha')).toBe('2026-07-05T13:00:00Z');
    expect(store.get('beta')).toBe('2026-07-05T12:00:00Z');
  });

  it('degrades a corrupt file to the empty map, never a throw', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'attention-last-seen.json'), 'not json at all', 'utf8');
    const store = new AttentionLastSeenStore(dir);
    await store.load();
    expect(store.get('alpha')).toBeNull();
    // ...and a mark after the corrupt load persists a clean file.
    await store.markAll(['alpha'], '2026-07-05T12:00:00Z');
    const content = await readFile(join(dir, 'attention-last-seen.json'), 'utf8');
    expect(JSON.parse(content)).toEqual({ alpha: '2026-07-05T12:00:00Z' });
  });
});
