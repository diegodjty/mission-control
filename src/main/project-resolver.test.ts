import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectIdentity } from './project-resolver';

/**
 * Exercises the resolver against a real temp "home": a Workbench with a
 * registry + project CONFIG, plus code repos outside it (issue 71 acceptance:
 * a workbench project opens identically by workbench dir or member-repo path;
 * a plain repo stays legacy).
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeHome(): Promise<{
  home: string;
  project: string;
  repoA: string;
  repoB: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'mc-home-'));
  dirs.push(home);

  const repoA = join(home, 'code', 'repo-a');
  const repoB = join(home, 'code', 'repo-b');
  const project = join(home, 'Workbench', 'proj');
  await mkdir(join(repoA, 'src'), { recursive: true });
  await mkdir(repoB, { recursive: true });
  await mkdir(join(project, 'issues'), { recursive: true });

  await writeFile(
    join(home, 'Workbench', 'registry.md'),
    `# Registry\n\n- repo: ${repoA}\n  project: proj\n  status: active\n` +
      `- repo: ${repoB}\n  project: proj\n  status: active\n`,
  );
  await writeFile(
    join(project, 'CONFIG.md'),
    `---\nrepos:\n  a: ${repoA}\n  b: ${repoB}\ndefault_repo: a\n---\n\n# proj\n`,
  );

  return { home, project, repoA, repoB };
}

describe('resolveProjectIdentity (real filesystem)', () => {
  it('resolves a registered repo path to its workbench project', async () => {
    const { home, project, repoA } = await makeHome();
    const id = await resolveProjectIdentity(repoA, { homeDir: home });
    expect(id.kind).toBe('workbench');
    expect(id.key).toBe(project);
    expect(id.issuesRoot).toBe(join(project, 'issues'));
    expect(id.completionsRoot).toBe(join(project, 'completions'));
    expect(id.defaultRepoPath).toBe(repoA);
    expect(id.repoPaths).toEqual([repoA, join(home, 'code', 'repo-b')]);
  });

  it('resolves the workbench dir and a member repo to the SAME identity', async () => {
    const { home, project, repoB } = await makeHome();
    const byDir = await resolveProjectIdentity(project, { homeDir: home });
    const byRepo = await resolveProjectIdentity(repoB, { homeDir: home });
    expect(byDir.key).toBe(byRepo.key);
    expect(byDir.issuesRoot).toBe(byRepo.issuesRoot);
    expect(byRepo.key).toBe(project);
  });

  it('resolves a subdirectory of a member repo to the same project', async () => {
    const { home, project, repoA } = await makeHome();
    const id = await resolveProjectIdentity(join(repoA, 'src'), { homeDir: home });
    expect(id.key).toBe(project);
  });

  it('leaves an unregistered repo legacy — the QA-sandbox path, unchanged', async () => {
    const { home } = await makeHome();
    const sandbox = join(home, 'sandbox-repo');
    await mkdir(join(sandbox, 'issues'), { recursive: true });
    const id = await resolveProjectIdentity(sandbox, { homeDir: home });
    expect(id).toEqual({
      key: sandbox,
      kind: 'legacy',
      label: 'sandbox-repo',
      issuesRoot: join(sandbox, 'issues'),
      completionsRoot: join(sandbox, 'issues', 'completions'),
      defaultRepoPath: sandbox,
      workspaceRoot: null, // legacy projects declare no workspace root (ADR-0017)
      repoPaths: [sandbox],
      repos: {},
    });
  });

  it('treats every path as legacy when there is no ~/Workbench at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mc-nohome-'));
    dirs.push(home);
    const repo = join(home, 'some-repo');
    await mkdir(repo, { recursive: true });
    const id = await resolveProjectIdentity(repo, { homeDir: home });
    expect(id.kind).toBe('legacy');
    expect(id.key).toBe(repo);
  });

  it('degrades a workbench project whose CONFIG is missing (key-rooted default repo)', async () => {
    const { home, project } = await makeHome();
    await rm(join(project, 'CONFIG.md'));
    const id = await resolveProjectIdentity(project, { homeDir: home });
    expect(id.kind).toBe('workbench');
    expect(id.defaultRepoPath).toBe(project);
  });
});
