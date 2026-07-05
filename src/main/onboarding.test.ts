/**
 * Integration check for the onboarding edge (issue 82, ADR-0016): real fs +
 * real git against a throwaway temp "home" (with a `Workbench/` git repo
 * inside), asserting the acceptance criteria end to end at module level —
 * a correct workbench project + active registry entries + ONE commit, MC
 * resolution by workbench dir AND by member-repo path, collisions refused,
 * non-git warned but allowed, and dry runs writing nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchProject } from './onboarding';
import { resolveProjectIdentity } from './project-resolver';

const exec = promisify(execFile);

let home: string;
let workbench: string;
let repoA: string;
let repoB: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function commitCount(): Promise<number> {
  return Number((await git(workbench, 'rev-list', '--count', 'HEAD')).trim());
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-onboard-home-'));
  workbench = join(home, 'Workbench');
  await mkdir(workbench, { recursive: true });
  await git(workbench, 'init', '-q');
  await git(workbench, 'config', 'user.email', 'mc@test.local');
  await git(workbench, 'config', 'user.name', 'MC Test');
  // A pre-existing project + registry, so appends have something to preserve.
  await mkdir(join(workbench, 'existing-proj', 'issues'), { recursive: true });
  await writeFile(join(workbench, 'existing-proj', 'CONFIG.md'), '---\nrepos:\n  app: ~/code/existing\ndefault_repo: app\n---\n');
  await writeFile(
    join(workbench, 'registry.md'),
    '# Registry\n\n## Entries\n\n- repo: ~/code/existing\n  project: existing-proj\n  status: active\n',
  );
  await git(workbench, 'add', '-A');
  await git(workbench, 'commit', '-q', '-m', 'seed');

  // Two code repos under the temp home: one git, one plain directory.
  repoA = join(home, 'Developer', 'acme-api');
  repoB = join(home, 'Developer', 'acme-docs');
  await mkdir(repoA, { recursive: true });
  await git(repoA, 'init', '-q');
  await mkdir(repoB, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('createWorkbenchProject (issue 82)', () => {
  it('creates the project, appends active registry entries, and lands ONE boring commit', async () => {
    const before = await commitCount();
    const res = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Acme Platform',
      repos: [
        { key: 'api', path: repoA },
        { key: 'docs', path: repoB },
      ],
    });

    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.dirName).toBe('acme-platform');
    expect(res.workbenchDir).toBe(join(workbench, 'acme-platform'));
    // repoB is a plain directory: warned, allowed.
    expect(res.warnings.join(' ')).toMatch(/not a git repo/i);

    // ADR-0015 layout: CONFIG + empty issues/ + completions/ + memory skeleton
    // with an EMPTY CORE.md.
    const root = join(workbench, 'acme-platform');
    expect((await stat(join(root, 'issues'))).isDirectory()).toBe(true);
    expect((await stat(join(root, 'completions'))).isDirectory()).toBe(true);
    expect(await readFile(join(root, 'memory', 'CORE.md'), 'utf8')).toBe('');
    const config = await readFile(join(root, 'CONFIG.md'), 'utf8');
    expect(config).toContain(`api: ~/Developer/acme-api`);
    expect(config).toContain('default_repo: api');

    // Registry: previous entries intact, two new active ones appended.
    const registry = await readFile(join(workbench, 'registry.md'), 'utf8');
    expect(registry).toContain('project: existing-proj');
    expect(registry).toContain('project: acme-platform');

    // ONE commit, boring message, clean tree after.
    expect(await commitCount()).toBe(before + 1);
    expect((await git(workbench, 'log', '-1', '--format=%s')).trim()).toBe(
      'acme-platform: project onboarded',
    );
    expect((await git(workbench, 'status', '--porcelain')).trim()).toBe('');
  });

  it('resolves the new project by workbench dir AND by any member-repo path', async () => {
    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Acme Platform',
      repos: [
        { key: 'api', path: repoA },
        { key: 'docs', path: repoB },
      ],
    });

    // The same resolution every open/Continue/Worker-session lookup performs.
    const byDir = await resolveProjectIdentity(join(workbench, 'acme-platform'), { homeDir: home });
    expect(byDir.kind).toBe('workbench');
    expect(byDir.key).toBe(join(workbench, 'acme-platform'));
    expect(byDir.defaultRepoPath).toBe(repoA);

    for (const repo of [repoA, join(repoB, 'nested', 'dir')]) {
      const identity = await resolveProjectIdentity(repo, { homeDir: home });
      expect(identity.kind).toBe('workbench');
      expect(identity.key).toBe(join(workbench, 'acme-platform'));
    }
  });

  it('refuses a name collision and an already-registered repo, saying which project holds it', async () => {
    const before = await commitCount();

    const nameClash = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Existing Proj',
      repos: [{ key: 'app', path: repoA }],
    });
    expect(nameClash.ok).toBe(false);
    expect(nameClash.errors.join(' ')).toContain('existing-proj');

    const repoClash = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Fresh Name',
      repos: [{ key: 'app', path: join(home, 'code', 'existing') }],
    });
    expect(repoClash.ok).toBe(false);
    expect(repoClash.errors.join(' ')).toContain('already registered to project "existing-proj"');

    // Refusals write and commit NOTHING.
    expect(await commitCount()).toBe(before);
    expect((await git(workbench, 'status', '--porcelain')).trim()).toBe('');
    await expect(stat(join(workbench, 'fresh-name'))).rejects.toThrow();
  });

  it('dryRun validates (errors AND warnings) without writing anything', async () => {
    const before = await commitCount();
    const res = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Acme Platform',
      repos: [{ key: 'docs', path: repoB }],
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/not a git repo/i);
    await expect(stat(join(workbench, 'acme-platform'))).rejects.toThrow();
    expect(await commitCount()).toBe(before);
    expect(await readFile(join(workbench, 'registry.md'), 'utf8')).not.toContain('acme-platform');
  });

  it('reports a missing workbench root instead of inventing one', async () => {
    const res = await createWorkbenchProject({
      workbenchRoot: join(home, 'NoSuchWorkbench'),
      homeDir: home,
      name: 'X Y',
      repos: [{ key: 'app', path: repoA }],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/workbench/i);
  });

  it('never throws on garbage input', async () => {
    const res = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: '',
      repos: [],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
