import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AttentionWatcher, isAttentionRelevant } from './attention-watcher';
import type { AttentionSnapshot } from '../shared/ipc-contract';

const run = promisify(execFile);

/**
 * The background cross-project attention watch (issue 79, ADR-0016) against
 * REAL temp workbenches: items surface within a debounce beat and disappear on
 * resolution (acceptance a), registry edits reconcile the watch set without a
 * restart and teardown leaks nothing (acceptance b), and a full derive cycle
 * performs zero writes to any workbench (acceptance c, asserted via git).
 */

const DEBOUNCE = 40;

const dirs: string[] = [];
const watchers: AttentionWatcher[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `predicate` is true or time out. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A temp workbench root with a registry and per-project artifact dirs. */
async function makeWorkbench(projects: { name: string; active: boolean }[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mc-attn-watch-'));
  dirs.push(root);
  await writeRegistry(root, projects);
  for (const p of projects) {
    await mkdir(join(root, p.name, 'issues'), { recursive: true });
    await mkdir(join(root, p.name, 'completions'), { recursive: true });
    await mkdir(join(root, p.name, 'memory', 'journal'), { recursive: true });
  }
  return root;
}

async function writeRegistry(
  root: string,
  projects: { name: string; active: boolean }[],
): Promise<void> {
  const body = projects
    .map(
      (p) =>
        `- repo: /fake/repos/${p.name}\n  project: ${p.name}\n  status: ${p.active ? 'active' : 'inactive'}\n`,
    )
    .join('');
  await writeFile(join(root, 'registry.md'), `# Registry\n\n${body}`);
}

/** Park an HITL issue: a wip `hitl: true` issue + a needs-verification Receipt. */
async function parkHitl(root: string, project: string): Promise<void> {
  await writeFile(
    join(root, project, 'issues', '05-manual-check.md'),
    '---\nstatus: wip\ndepends_on: []\nhitl: true\n---\n\n# 05 — manual check\n',
  );
  await writeFile(
    join(root, project, 'completions', '05-manual-check.md'),
    '---\nissue: 5\nslug: manual-check\noutcome: needs-verification\nfinished: 2026-07-01T10:00:00Z\n---\n\nReady for manual verification.\n',
  );
}

function newWatcher(root: string): { watcher: AttentionWatcher; pushes: AttentionSnapshot[] } {
  const pushes: AttentionSnapshot[] = [];
  const watcher = new AttentionWatcher({
    workbenchRoot: root,
    debounceMs: DEBOUNCE,
    onChange: (s) => pushes.push(s),
  });
  watchers.push(watcher);
  return { watcher, pushes };
}

const ids = (w: AttentionWatcher): string[] => w.snapshot.items.map((i) => i.id);

describe('AttentionWatcher (real temp workbenches)', () => {
  it('acceptance (a): planted artifacts in two unopened projects surface within a debounce beat and clear on resolution', async () => {
    const root = await makeWorkbench([
      { name: 'alpha', active: true },
      { name: 'beta', active: true },
    ]);
    const { watcher } = newWatcher(root);
    watcher.start();
    await waitFor(() => watcher.size === 2, 'both project watches');
    await sleep(DEBOUNCE * 3); // let the initial (empty) derives settle

    // Plant a curator proposal in alpha and park an HITL issue in beta —
    // neither project is "open" anywhere; the background watch alone reacts.
    await writeFile(join(root, 'alpha', 'memory', 'CORE.proposed.md'), '# proposed\n');
    await waitFor(
      () => ids(watcher).includes('alpha:curator-proposal'),
      'the curator-proposal item',
    );

    await parkHitl(root, 'beta');
    await waitFor(() => ids(watcher).includes('beta:hitl-park:5'), 'the hitl-park item');
    // Aggregate order: projects ascending, each project's items in model order.
    expect(ids(watcher)).toEqual(['alpha:curator-proposal', 'beta:hitl-park:5']);

    // Resolving each removes its item: same inputs → same ids, gone means gone.
    await unlink(join(root, 'alpha', 'memory', 'CORE.proposed.md'));
    await waitFor(
      () => !ids(watcher).includes('alpha:curator-proposal'),
      'the proposal item to clear',
    );

    await writeFile(
      join(root, 'beta', 'issues', '05-manual-check.md'),
      '---\nstatus: done\ndepends_on: []\nhitl: true\n---\n\n# 05 — manual check\n',
    );
    await waitFor(() => ids(watcher).length === 0, 'the park item to clear');
  });

  it('acceptance (a): a blocked Receipt and a gating HUMAN-SETUP box also surface', async () => {
    const root = await makeWorkbench([{ name: 'alpha', active: true }]);
    await writeFile(
      join(root, 'alpha', 'issues', '07-api-sync.md'),
      '---\nstatus: open\ndepends_on: []\n---\n\n# 07 — api sync\n',
    );
    await writeFile(join(root, 'alpha', 'HUMAN-SETUP.md'), '- [ ] Create the API token. Unblocks: 07\n');
    const { watcher } = newWatcher(root);
    watcher.start();
    await waitFor(() => ids(watcher).length === 1, 'the setup-gate item');
    expect(watcher.snapshot.items[0].kind).toBe('setup-gate');

    await writeFile(
      join(root, 'alpha', 'completions', '07-api-sync.md'),
      '---\nissue: 7\nslug: api-sync\noutcome: blocked\nfinished: 2026-07-01T11:00:00Z\n---\n\nBlocked: missing token.\n',
    );
    await waitFor(() => ids(watcher).includes('alpha:blocked-run:7'), 'the blocked-run item');
  });

  it('acceptance (b): registry edits start/stop project watches without a restart; close() leaks nothing', async () => {
    const root = await makeWorkbench([
      { name: 'alpha', active: true },
      { name: 'beta', active: false },
    ]);
    // beta already has attention-worthy state on disk — but it is inactive.
    await writeFile(join(root, 'beta', 'memory', 'CORE.proposed.md'), '# proposed\n');
    await writeFile(join(root, 'alpha', 'memory', 'CORE.proposed.md'), '# proposed\n');

    const { watcher } = newWatcher(root);
    watcher.start();
    await waitFor(() => ids(watcher).includes('alpha:curator-proposal'), 'alpha items');
    expect(watcher.size).toBe(1); // beta is inactive: not watched, no items
    expect(ids(watcher)).not.toContain('beta:curator-proposal');

    // Activate beta by editing the registry — the SAME instance reconciles.
    await writeRegistry(root, [
      { name: 'alpha', active: true },
      { name: 'beta', active: true },
    ]);
    await waitFor(() => ids(watcher).includes('beta:curator-proposal'), 'beta activation');
    expect(watcher.size).toBe(2);

    // Deactivate alpha: its watch stops and its items disappear.
    await writeRegistry(root, [
      { name: 'alpha', active: false },
      { name: 'beta', active: true },
    ]);
    await waitFor(() => !ids(watcher).includes('alpha:curator-proposal'), 'alpha deactivation');
    expect(watcher.size).toBe(1);

    // beta's watch is genuinely live after all that churn.
    await parkHitl(root, 'beta');
    await waitFor(() => ids(watcher).includes('beta:hitl-park:5'), 'beta still watched');

    // Clean teardown: no watches, no further pushes even if files change.
    watcher.close();
    expect(watcher.size).toBe(0);
    const pushed = ids(watcher).length;
    await writeFile(join(root, 'beta', 'memory', 'journal', '2026-07-04.md'), '# drain\n');
    await sleep(DEBOUNCE * 4);
    expect(ids(watcher).length).toBe(pushed);
  });

  it('acceptance (c): a full derive cycle performs zero writes to any workbench', async () => {
    const root = await makeWorkbench([
      { name: 'alpha', active: true },
      { name: 'beta', active: true },
    ]);
    await parkHitl(root, 'alpha');
    await writeFile(join(root, 'beta', 'memory', 'CORE.proposed.md'), '# proposed\n');
    await writeFile(join(root, 'beta', 'HUMAN-SETUP.md'), '- [ ] token. Unblocks: 05\n');
    await writeFile(join(root, 'beta', 'memory', 'journal', '2026-07-01.md'), '# drain\n- Reason: x\n');

    // The workbench is one git repo (ADR-0015); commit everything so ANY write
    // — new file, edit, even an mtime-only touch via content change — shows.
    const git = (...args: string[]) => run('git', ['-C', root, ...args]);
    await git('init', '-q');
    await git('add', '-A');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');

    const { watcher } = newWatcher(root);
    watcher.start();
    // A full cycle: initial reconcile + derive over every artifact kind.
    await waitFor(() => ids(watcher).length >= 3, 'a full derivation');
    await sleep(DEBOUNCE * 4); // let any (wrong) deferred write land

    const { stdout } = await git('status', '--porcelain');
    expect(stdout.trim()).toBe('');
  });

  it('stays inert (no throw, empty snapshot) when the workbench root does not exist', async () => {
    const { watcher, pushes } = newWatcher(join(tmpdir(), 'mc-attn-does-not-exist'));
    watcher.start();
    await sleep(DEBOUNCE * 3);
    expect(watcher.size).toBe(0);
    expect(watcher.snapshot).toEqual({ items: [], notes: [] });
    expect(pushes).toEqual([]);
  });

  it('pushes only on real change — a no-op rewrite of the same state is silent', async () => {
    const root = await makeWorkbench([{ name: 'alpha', active: true }]);
    await writeFile(join(root, 'alpha', 'memory', 'CORE.proposed.md'), '# proposed\n');
    const { watcher, pushes } = newWatcher(root);
    watcher.start();
    await waitFor(() => ids(watcher).includes('alpha:curator-proposal'), 'the initial derive');
    const count = pushes.length;

    // Rewrite the same content: the derive re-runs, but the aggregate is
    // identical, so nothing is pushed to renderers.
    await writeFile(join(root, 'alpha', 'memory', 'CORE.proposed.md'), '# proposed\n');
    await sleep(DEBOUNCE * 5);
    expect(pushes.length).toBe(count);
  });
});

describe('isAttentionRelevant', () => {
  it('accepts the artifact surfaces and rejects noise', () => {
    expect(isAttentionRelevant('issues/05-x.md')).toBe(true);
    expect(isAttentionRelevant('completions/05-x.md')).toBe(true);
    expect(isAttentionRelevant('memory/CORE.proposed.md')).toBe(true);
    expect(isAttentionRelevant('memory/journal/2026-07-04.md')).toBe(true);
    expect(isAttentionRelevant('HUMAN-SETUP.md')).toBe(true);
    expect(isAttentionRelevant(null)).toBe(true); // unknown → re-derive, safe

    expect(isAttentionRelevant('CONFIG.md')).toBe(false);
    expect(isAttentionRelevant('.git/index')).toBe(false);
    expect(isAttentionRelevant('scratch/notes.md')).toBe(false);
  });
});
