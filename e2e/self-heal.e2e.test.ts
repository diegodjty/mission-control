/**
 * E2E self-heal harness (issue 95, ADR-0017) — a git repo APPEARING under a
 * project's workspace root surfaces an Inbox `new-repo-candidate`, one-click
 * confirm registers it (CONFIG repos entry + registry line + ONE boring
 * commit), and a subsequent Run against that repo resolves its cwd. Real
 * modules over real infrastructure: a temp workbench git repo, the real
 * `AttentionWatcher` with its real fs-watches + debounce (no polling), the real
 * `registerAppearedRepo` edge, the real identity layer. No LLM anywhere. Runs
 * beside the drain/guides/workbench harnesses in the same `npm run test:e2e`.
 *
 * The fixture is the ADR-0017 multi-repo drain shape ("01 creates api, 02
 * creates web"): a project with `api` already registered — so it is a
 * `status: active` registry project the attention watch tracks — whose CONFIG
 * declares a `workspace_root`. A SECOND repo (`web`) then `git init`s under that
 * workspace root, and self-heal offers to register it.
 *
 * (Discovery note: the attention watch keys on active registry entries, issue
 * 79 — so a project with ZERO registry entries, a brand-new repo-less project,
 * is not yet in the watched set. Self-heal covers the appear-alongside case
 * here; the never-registered bootstrap is a separate discovery gap, flagged in
 * the issue-95 completion.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionWatcher } from '../src/main/attention-watcher';
import { registerAppearedRepo } from '../src/main/register-repo';
import { detectAppearedRepos } from '../src/shared/self-heal';
import { resolveOpenedProject } from '../src/shared/project-identity';
import { parseProjectConfig, repoPathForIssue } from '../src/shared/workbench-model';
import type { AttentionSnapshot } from '../src/shared/ipc-contract';
import { git, sleep, waitFor } from './sandbox';

/** Short debounce — real timers, kept snappy for the suite. */
const DEBOUNCE = 40;

interface SelfHealFixture {
  scratch: string;
  /** The workbench git root (`~/Workbench/` in real life). */
  workbenchRoot: string;
  /** The project's workbench dir (`<workbenchRoot>/demo`). */
  projectRoot: string;
  /** The project's declared workspace root — where its repos live / appear. */
  workspaceRoot: string;
  /** The already-registered first repo (`<workspaceRoot>/api`). */
  apiRepo: string;
}

let fx: SelfHealFixture;

/** `git init` a real repo directory, with an initial commit. */
async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.email', 'e2e@example.com');
  await git(path, 'config', 'user.name', 'MC Self-Heal E2E');
  await git(path, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'README.md'), '# scaffolded by the drain\n');
  await git(path, 'add', '.');
  await git(path, 'commit', '-m', 'initial: scaffold');
}

/**
 * Seed a workbench holding a `demo` project whose `api` repo is registered
 * (so the attention watch tracks it) and whose CONFIG declares a workspace
 * root. `web` does NOT exist yet — the drain will scaffold it under the
 * workspace root during the test.
 */
async function seedSelfHealWorkbench(scratch: string): Promise<SelfHealFixture> {
  const workbenchRoot = join(scratch, 'workbench');
  const projectRoot = join(workbenchRoot, 'demo');
  const workspaceRoot = join(scratch, 'code', 'demo');
  const apiRepo = join(workspaceRoot, 'api');
  await mkdir(join(projectRoot, 'issues'), { recursive: true });
  await mkdir(join(projectRoot, 'memory', 'journal'), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await initRepo(apiRepo); // the first repo, already a project member

  const configContent = [
    '---',
    `workspace_root: ${workspaceRoot}`,
    'repos:',
    `  api: ${apiRepo}`,
    'default_repo: api',
    '---',
    '',
    '# demo — project CONFIG',
    '',
    '## Test commands',
    '',
    'Not established yet.',
    '',
  ].join('\n');
  await writeFile(join(projectRoot, 'CONFIG.md'), configContent);
  await writeFile(join(projectRoot, 'memory', 'CORE.md'), '- demo core fact\n');

  const registryContent =
    `# Registry\n\n- repo: ${apiRepo}\n  project: demo\n  status: active\n`;
  await writeFile(join(workbenchRoot, 'registry.md'), registryContent);

  await git(workbenchRoot, 'init', '-b', 'main');
  await git(workbenchRoot, 'config', 'user.email', 'e2e@example.com');
  await git(workbenchRoot, 'config', 'user.name', 'MC Self-Heal E2E');
  await git(workbenchRoot, 'config', 'commit.gpgsign', 'false');
  await git(workbenchRoot, 'add', '.');
  await git(workbenchRoot, 'commit', '-m', 'initial: seeded demo with api registered');

  return { scratch, workbenchRoot, projectRoot, workspaceRoot, apiRepo };
}

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mc-self-heal-e2e-'));
  fx = await seedSelfHealWorkbench(scratch);
});

afterEach(async () => {
  await rm(fx.scratch, { recursive: true, force: true });
});

describe('e2e self-heal — an appeared repo surfaces, confirms, and resolves', () => {
  it('workspace-root repo → Inbox candidate → confirm registers it → a Run resolves its cwd', async () => {
    const pushes: AttentionSnapshot[] = [];
    const watcher = new AttentionWatcher({
      workbenchRoot: fx.workbenchRoot,
      debounceMs: DEBOUNCE,
      onChange: (s) => pushes.push(s),
      homeDir: '/nonexistent-home', // the fixture uses absolute paths, no `~/`
    });
    const items = () => watcher.snapshot.items;
    const candidate = () => items().find((i) => i.kind === 'new-repo-candidate');

    try {
      watcher.start();
      await waitFor(() => watcher.watchedProjects.includes('demo'), 'the demo watch attached');
      await sleep(DEBOUNCE * 4); // let the initial derive + workspace-watch attach settle

      // `api` is a member already → no candidate for it.
      expect(candidate()).toBeUndefined();

      // The drain scaffolds a SECOND repo under the workspace root — the
      // debounced fs-watch on the workspace root (no polling) re-derives and
      // the candidate surfaces as one Inbox item for the demo project.
      const webRepo = join(fx.workspaceRoot, 'web');
      await initRepo(webRepo);
      await waitFor(() => candidate() !== undefined, 'the new-repo-candidate to surface');

      const item = candidate()!;
      expect(item.project).toBe('demo');
      expect(item.id).toBe('demo:new-repo-candidate:web');
      expect(item.candidate).toEqual({ path: webRepo, name: 'web', suggestedKey: 'web' });
      expect(item.text).toContain('web');
      // Only `web` — the registered `api` never re-surfaces.
      expect(items().filter((i) => i.kind === 'new-repo-candidate')).toHaveLength(1);

      const commitsBefore = Number(
        (await git(fx.workbenchRoot, 'rev-list', '--count', 'HEAD')).trim(),
      );

      // One-click confirm: the ADR-0015 registration path.
      const outcome = await registerAppearedRepo({
        workbenchRoot: fx.workbenchRoot,
        homeDir: '/nonexistent-home', // temp fixture lives outside home → paths stay absolute
        project: item.project,
        repoPath: item.candidate!.path,
        key: item.candidate!.suggestedKey,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.errors).toEqual([]);
      expect(outcome.key).toBe('web');

      // The CONFIG gained the `web` entry; `api` stays the default (unchanged).
      const configContent = await readFile(join(fx.projectRoot, 'CONFIG.md'), 'utf8');
      const config = parseProjectConfig(configContent);
      expect(config.repos).toEqual({ api: fx.apiRepo, web: webRepo });
      expect(config.defaultRepo).toBe('api'); // not the new repo — untouched
      expect(config.workspaceRoot).toBe(fx.workspaceRoot);

      // The registry gained one active entry for `web` (alongside `api`).
      const registryContent = await readFile(join(fx.workbenchRoot, 'registry.md'), 'utf8');
      expect(registryContent).toContain(`- repo: ${webRepo}`);
      expect(registryContent.match(/project: demo/g)?.length).toBe(2); // api + web

      // ONE boring commit, scoped to the project dir + registry.md.
      expect(Number((await git(fx.workbenchRoot, 'rev-list', '--count', 'HEAD')).trim())).toBe(
        commitsBefore + 1,
      );
      expect((await git(fx.workbenchRoot, 'log', '-1', '--pretty=%s')).trim()).toBe(
        'demo: repo web registered',
      );
      const touched = (
        await git(fx.workbenchRoot, 'show', '--name-only', '--pretty=format:', 'HEAD')
      )
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(touched.every((p) => p.startsWith('demo/') || p === 'registry.md')).toBe(true);
      expect(touched).toContain('demo/CONFIG.md');
      expect(touched).toContain('registry.md');
      expect((await git(fx.workbenchRoot, 'status', '--porcelain')).trim()).toBe('');

      // The CONFIG edit is a watched change → the candidate item clears (a
      // registered repo never re-surfaces).
      await waitFor(() => candidate() === undefined, 'the candidate to clear after registering');

      // The detector agrees directly: the now-registered repo is no candidate.
      expect(
        detectAppearedRepos({
          workspaceRoot: fx.workspaceRoot,
          entries: [
            { name: 'api', isGit: true },
            { name: 'web', isGit: true },
          ],
          repos: config.repos,
          registryContent,
          homeDir: null,
        }),
      ).toEqual([]);

      // A subsequent Run against the appeared repo resolves its cwd correctly:
      // an issue targeting `repo: web` resolves to the appeared repo's path…
      expect(repoPathForIssue(config, 'web')).toEqual({ ok: true, key: 'web', path: webRepo });

      // …and a Worker whose cwd is inside `web` resolves back to the demo
      // project (the registry now maps it), through the same identity layer the
      // open flow uses.
      const byRepo = resolveOpenedProject(
        {
          openedPath: webRepo,
          registryContent,
          workbenchRoot: fx.workbenchRoot,
          homeDir: '/nonexistent-home',
        },
        configContent,
      );
      expect(byRepo.kind).toBe('workbench');
      expect(byRepo.key).toBe(fx.projectRoot);
      expect(byRepo.repos).toEqual({ api: fx.apiRepo, web: webRepo });
    } finally {
      watcher.close();
    }
    expect(watcher.size).toBe(0); // clean teardown — no watcher leaks
  });

  it('a repo OUTSIDE the workspace root is never a candidate (self-heal is scoped)', async () => {
    const watcher = new AttentionWatcher({
      workbenchRoot: fx.workbenchRoot,
      debounceMs: DEBOUNCE,
      onChange: () => {},
      homeDir: '/nonexistent-home',
    });
    const candidate = () =>
      watcher.snapshot.items.find((i) => i.kind === 'new-repo-candidate');
    try {
      watcher.start();
      await waitFor(() => watcher.watchedProjects.includes('demo'), 'the demo watch attached');
      await sleep(DEBOUNCE * 4);

      // A repo elsewhere on disk (a sibling of the workspace root, not under
      // it) is legal but never auto-detected — it must be registered through
      // the normal add-repo path.
      const outsideRepo = join(fx.scratch, 'code', 'unrelated');
      await initRepo(outsideRepo);
      await sleep(DEBOUNCE * 6); // give any spurious watch/derive time to fire
      expect(candidate()).toBeUndefined();
    } finally {
      watcher.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Manual-only — the renderer half needs the live Electron shell. Declared here
// (as a named, skipped spec) so the coverage gap is explicit, never silent: the
// pipeline (detect → surface → confirm → register → resolve) is asserted above
// against real modules; only the Inbox button's click is shell-bound.
// -----------------------------------------------------------------------------
describe('manual-only — self-heal renderer (needs the live shell)', () => {
  it.skip('manual-only: the Inbox renders a `new repo` item and its click calls registerRepo, clearing the item on the CONFIG re-derive — reason: Electron shell + renderer; the detector, derivation, watch surfacing, registration edit, commit, and resolution are all asserted above and in the unit suites', () => {});
});
