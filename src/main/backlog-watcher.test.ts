import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BacklogWatcher } from './backlog-watcher';
import type { BacklogLoadResult } from '../shared/ipc-contract';

/**
 * Exercises the real file watcher against a real temp `issues/` directory —
 * this is the headless verification that the live-update mechanism actually
 * fires on disk changes (issue 05 acceptance criteria).
 */

function issueFile(id: number, status: string, deps = '[]'): string {
  return `---\nstatus: ${status}\ndepends_on: ${deps}\n---\n\n# ${String(id).padStart(
    2,
    '0',
  )} — issue ${id}\n\n## Parent\n\n\`docs/PRD.md\`\n\nbody\n`;
}

const configFile = '# config\n\n## Active PRD\n\n`docs/PRD.md`\n';

/** Wait until `predicate` is true or time out. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for watcher event');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const watchers: BacklogWatcher[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.closeAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mc-watch-'));
  dirs.push(root);
  const issues = join(root, 'issues');
  await mkdir(issues);
  await writeFile(join(issues, 'CONFIG.md'), configFile);
  await writeFile(join(issues, '01-first.md'), issueFile(1, 'wip'));
  await writeFile(join(issues, '02-second.md'), issueFile(2, 'open', '[1]'));
  return root;
}

function newWatcher(): BacklogWatcher {
  const w = new BacklogWatcher({ debounceMs: 20 });
  watchers.push(w);
  return w;
}

describe('BacklogWatcher (real filesystem)', () => {
  it('pushes an update when an issue file status flips on disk', async () => {
    const root = await makeProject();
    const seen: BacklogLoadResult[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', root, (r) => seen.push(r));

    // Let the seed read settle so the first change diffs against real state.
    await new Promise((r) => setTimeout(r, 100));

    await writeFile(join(root, 'issues', '01-first.md'), issueFile(1, 'done'));

    await waitFor(() => seen.length > 0);
    const last = seen[seen.length - 1];
    expect(last.error).toBeNull();
    expect(last.backlog?.issues.find((i) => i.id === 1)?.status).toBe('done');
  });

  it('pushes an update when an issue file is added', async () => {
    const root = await makeProject();
    const seen: BacklogLoadResult[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', root, (r) => seen.push(r));
    await new Promise((r) => setTimeout(r, 100));

    await writeFile(join(root, 'issues', '03-third.md'), issueFile(3, 'open'));

    await waitFor(() => seen.some((r) => r.backlog?.issues.some((i) => i.id === 3)));
    expect(seen[seen.length - 1].backlog?.issues.length).toBe(3);
  });

  it('pushes an update when an issue file is removed', async () => {
    const root = await makeProject();
    const seen: BacklogLoadResult[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', root, (r) => seen.push(r));
    await new Promise((r) => setTimeout(r, 100));

    await rm(join(root, 'issues', '02-second.md'));

    await waitFor(() => seen.some((r) => !r.backlog?.issues.some((i) => i.id === 2)));
    expect(seen[seen.length - 1].backlog?.issues.map((i) => i.id)).toEqual([1]);
  });

  it('does not leak watchers: unwatch stops further pushes', async () => {
    const root = await makeProject();
    const seen: BacklogLoadResult[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', root, (r) => seen.push(r));
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.size).toBe(1);
    watcher.unwatch('w1');
    expect(watcher.size).toBe(0);

    await writeFile(join(root, 'issues', '01-first.md'), issueFile(1, 'done'));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(0);
  });

  it('replacing a key closes the old watcher (no double-registration)', async () => {
    const root = await makeProject();
    const watcher = newWatcher();
    watcher.watch('w1', root, () => {});
    watcher.watch('w1', root, () => {});
    expect(watcher.size).toBe(1);
    watcher.closeAll();
    expect(watcher.size).toBe(0);
  });
});
