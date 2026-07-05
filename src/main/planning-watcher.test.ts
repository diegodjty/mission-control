import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningWatcher } from './planning-watcher';
import type { PlanningDoc } from '../shared/planning-model';

/**
 * Exercises the real watcher against real temp planning roots — the headless
 * verification that the Planning view's preview updates within a debounce
 * beat and orders most-recently-changed first (issue 83 acceptance).
 */

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for watcher push');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const watchers: PlanningWatcher[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.closeAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A workbench project dir + a repo dir with the planning doc locations. */
async function makeRoots(): Promise<{ workbenchDir: string; repoPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mc-planning-'));
  dirs.push(root);
  const workbenchDir = join(root, 'wb');
  const repoPath = join(root, 'repo');
  await mkdir(join(workbenchDir, 'issues'), { recursive: true });
  await mkdir(join(workbenchDir, 'completions'), { recursive: true });
  await mkdir(join(repoPath, 'docs', 'adr'), { recursive: true });
  await writeFile(join(workbenchDir, 'PRD.md'), '# PRD\n');
  await writeFile(join(workbenchDir, 'issues', '01-first.md'), '---\nstatus: open\n---\n\n# 01\n');
  await writeFile(join(repoPath, 'CONTEXT.md'), '# Context\n');
  await writeFile(join(repoPath, 'docs', 'adr', '0001-choice.md'), '# ADR 1\n');
  return { workbenchDir, repoPath };
}

function newWatcher(): PlanningWatcher {
  const w = new PlanningWatcher({ debounceMs: 20 });
  watchers.push(w);
  return w;
}

describe('PlanningWatcher (real filesystem)', () => {
  it('pushes the initial ordered doc set on watch', async () => {
    const roots = await makeRoots();
    const pushes: PlanningDoc[][] = [];
    newWatcher().watch('k', roots, (docs) => pushes.push(docs));

    await waitFor(() => pushes.length >= 1);
    const labels = pushes[0].map((d) => d.label).sort();
    expect(labels).toEqual([
      'CONTEXT.md',
      'PRD.md',
      'docs/adr/0001-choice.md',
      'issues/01-first.md',
    ]);
  });

  it('a doc edit pushes an update with that doc floated to the top', async () => {
    const roots = await makeRoots();
    // Age everything so the edited file's fresh mtime clearly wins.
    const past = new Date(Date.now() - 60_000);
    for (const p of [
      join(roots.workbenchDir, 'PRD.md'),
      join(roots.workbenchDir, 'issues', '01-first.md'),
      join(roots.repoPath, 'CONTEXT.md'),
      join(roots.repoPath, 'docs', 'adr', '0001-choice.md'),
    ]) {
      await utimes(p, past, past);
    }
    const pushes: PlanningDoc[][] = [];
    newWatcher().watch('k', roots, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    const before = pushes.length;

    await writeFile(join(roots.workbenchDir, 'PRD.md'), '# PRD\n\nnow with content\n');
    await waitFor(() => pushes.length > before);
    expect(pushes[pushes.length - 1][0].label).toBe('PRD.md');
  });

  it('a new issue file and an ADR edit each surface; completions churn does not', async () => {
    const roots = await makeRoots();
    const pushes: PlanningDoc[][] = [];
    newWatcher().watch('k', roots, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);

    let count = pushes.length;
    await writeFile(join(roots.workbenchDir, 'issues', '02-second.md'), '# 02\n');
    await waitFor(() => pushes.length > count);
    expect(pushes[pushes.length - 1].some((d) => d.label === 'issues/02-second.md')).toBe(true);

    count = pushes.length;
    await writeFile(join(roots.repoPath, 'docs', 'adr', '0002-next.md'), '# ADR 2\n');
    await waitFor(() =>
      pushes.some((p) => p.some((d) => d.label === 'docs/adr/0002-next.md')),
    );

    // A Receipt landing in completions/ must not re-push (irrelevant churn).
    count = pushes.length;
    await writeFile(join(roots.workbenchDir, 'completions', '01-first.md'), 'receipt\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(pushes.length).toBe(count);
  });

  it('unwatch stops pushes and drops the entry; rootsFor reflects the live watch', async () => {
    const roots = await makeRoots();
    const w = newWatcher();
    const pushes: PlanningDoc[][] = [];
    w.watch('k', roots, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    expect(w.rootsFor('k')).toEqual(roots);
    expect(w.size).toBe(1);

    w.unwatch('k');
    expect(w.rootsFor('k')).toBeNull();
    expect(w.size).toBe(0);
    const count = pushes.length;
    await writeFile(join(roots.workbenchDir, 'PRD.md'), '# changed\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(pushes.length).toBe(count);
  });

  it('survives roots with no docs dir and no CONTEXT.md (empty scan, no throw)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mc-planning-bare-'));
    dirs.push(root);
    const workbenchDir = join(root, 'wb');
    const repoPath = join(root, 'repo');
    await mkdir(join(workbenchDir, 'issues'), { recursive: true });
    await mkdir(repoPath, { recursive: true });

    const pushes: PlanningDoc[][] = [];
    newWatcher().watch('k', { workbenchDir, repoPath }, (docs) => pushes.push(docs));
    await waitFor(() => pushes.length >= 1);
    expect(pushes[0]).toEqual([]);
  });
});
