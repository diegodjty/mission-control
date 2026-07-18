import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChecklistStateStore } from './checklist-state-store';

/**
 * The HITL checklist's checked flags persist in app userData (issue 156) —
 * app-level ephemeral state, never a workbench commit — and survive a
 * restart (a fresh store instance reads the same file back) and a project
 * switch (a different project key is just a different entry in the same map).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-checklist-state-'));
  dirs.push(dir);
  return dir;
}

describe('ChecklistStateStore', () => {
  it('starts empty (everything unchecked) when no file exists', async () => {
    const store = new ChecklistStateStore(await tempDir());
    await store.load();
    expect(store.get('proj', '42-example.md', 3)).toEqual([false, false, false]);
  });

  it('toggling persists and a NEW instance reads it back (restart persistence)', async () => {
    const dir = await tempDir();
    const store = new ChecklistStateStore(dir);
    await store.load();
    await store.toggle('proj', '42-example.md', 1, 3);
    expect(store.get('proj', '42-example.md', 3)).toEqual([false, true, false]);

    const reopened = new ChecklistStateStore(dir);
    await reopened.load();
    expect(reopened.get('proj', '42-example.md', 3)).toEqual([false, true, false]);
  });

  it('keys state by project so switching projects keeps each issue separate', async () => {
    const dir = await tempDir();
    const store = new ChecklistStateStore(dir);
    await store.load();
    await store.toggle('proj-a', '42-example.md', 0, 2);
    expect(store.get('proj-a', '42-example.md', 2)).toEqual([true, false]);
    expect(store.get('proj-b', '42-example.md', 2)).toEqual([false, false]);
  });

  it('toggling twice flips back to unchecked', async () => {
    const store = new ChecklistStateStore(await tempDir());
    await store.load();
    await store.toggle('proj', '42-example.md', 0, 1);
    const flags = await store.toggle('proj', '42-example.md', 0, 1);
    expect(flags).toEqual([false]);
  });

  it('degrades a corrupt file to the empty map, never a throw', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'checklist-state.json'), 'not json at all', 'utf8');
    const store = new ChecklistStateStore(dir);
    await store.load();
    expect(store.get('proj', '42-example.md', 2)).toEqual([false, false]);
    // ...and a toggle after the corrupt load persists a clean file.
    await store.toggle('proj', '42-example.md', 0, 2);
    const content = await readFile(join(dir, 'checklist-state.json'), 'utf8');
    expect(JSON.parse(content)).toEqual({ 'proj::42-example.md': [true, false] });
  });
});
