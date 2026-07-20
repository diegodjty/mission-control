import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocsWatcher } from './docs-watcher';
import type { DocEntry } from '../shared/docs-model';

/**
 * Exercises the real watcher against a real temp repo — the headless
 * verification that the Docs tab's picker updates within a debounce beat
 * (issue 182 acceptance: "editing a doc on disk refreshes the view").
 */

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for watcher push');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const watchers: DocsWatcher[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.closeAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A repo dir with the Docs-tab doc locations already populated. */
async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'mc-docs-'));
  dirs.push(repoPath);
  await mkdir(join(repoPath, 'docs', 'adr'), { recursive: true });
  await writeFile(join(repoPath, 'docs', 'ARCHITECTURE.md'), '# Architecture\n');
  await writeFile(join(repoPath, 'CONTEXT.md'), '# Context\n');
  await writeFile(join(repoPath, 'docs', 'adr', '0001-choice.md'), '# ADR 1\n');
  return repoPath;
}

function newWatcher(): DocsWatcher {
  const w = new DocsWatcher({ debounceMs: 20 });
  watchers.push(w);
  return w;
}

describe('DocsWatcher (real filesystem)', () => {
  it('pushes the initial ordered doc set on watch', async () => {
    const repoPath = await makeRepo();
    const pushes: DocEntry[][] = [];
    newWatcher().watch('k', { repoPath }, (docs) => pushes.push(docs));

    await waitFor(() => pushes.length >= 1);
    expect(pushes[0].map((d) => d.label)).toEqual([
      'ARCHITECTURE.md',
      'CONTEXT.md',
      'docs/adr/0001-choice.md',
    ]);
  });

  it('an ARCHITECTURE.md edit pushes an update', async () => {
    const repoPath = await makeRepo();
    const pushes: DocEntry[][] = [];
    newWatcher().watch('k', { repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    const before = pushes.length;

    await writeFile(join(repoPath, 'docs', 'ARCHITECTURE.md'), '# Architecture\n\nnow with more\n');
    await waitFor(() => pushes.length > before);
    expect(pushes[pushes.length - 1].map((d) => d.label)).toContain('ARCHITECTURE.md');
  });

  it('a new ADR surfaces; an unrelated docs/ file does not', async () => {
    const repoPath = await makeRepo();
    const pushes: DocEntry[][] = [];
    newWatcher().watch('k', { repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);

    const count = pushes.length;
    await writeFile(join(repoPath, 'docs', 'adr', '0002-next.md'), '# ADR 2\n');
    await waitFor(() => pushes.some((p) => p.some((d) => d.label === 'docs/adr/0002-next.md')));
    expect(pushes.length).toBeGreaterThan(count);

    const count2 = pushes.length;
    await mkdir(join(repoPath, 'docs', 'design'), { recursive: true });
    await writeFile(join(repoPath, 'docs', 'design', 'mock.png'), 'not a doc');
    await new Promise((r) => setTimeout(r, 150));
    expect(pushes.length).toBe(count2);
  });

  it('unwatch stops pushes and drops the entry; rootsFor reflects the live watch', async () => {
    const repoPath = await makeRepo();
    const w = newWatcher();
    const pushes: DocEntry[][] = [];
    w.watch('k', { repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    expect(w.rootsFor('k')).toEqual({ repoPath });
    expect(w.size).toBe(1);

    w.unwatch('k');
    expect(w.rootsFor('k')).toBeNull();
    expect(w.size).toBe(0);
    const count = pushes.length;
    await writeFile(join(repoPath, 'CONTEXT.md'), '# changed\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(pushes.length).toBe(count);
  });

  it('survives a repo with no docs/ dir at all (empty scan, no throw)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'mc-docs-bare-'));
    dirs.push(repoPath);

    const pushes: DocEntry[][] = [];
    newWatcher().watch('k', { repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    expect(pushes[0]).toEqual([]);
  });

  it('docs/ appearing later still gets picked up (ARCHITECTURE.md added after watch starts)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'mc-docs-late-'));
    dirs.push(repoPath);

    const pushes: DocEntry[][] = [];
    newWatcher().watch('k', { repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    expect(pushes[0]).toEqual([]);

    await mkdir(join(repoPath, 'docs'), { recursive: true });
    await writeFile(join(repoPath, 'docs', 'ARCHITECTURE.md'), '# Architecture\n');
    await waitFor(() => pushes.some((p) => p.some((d) => d.label === 'ARCHITECTURE.md')));
  });
});
