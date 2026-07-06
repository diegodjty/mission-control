/**
 * Integration check for workbench project discovery (issue 99): real fs against
 * a throwaway temp "home", driving the ACTUAL create→list seam. The bug was a
 * repo-less project (ADR-0017) that New project created — its ~/Workbench/<dir>
 * skeleton exists, so re-creating it is refused as a collision — yet it showed
 * in no Launcher list, because listing read only the registry (which a
 * repo-less project deliberately never touches). These tests create projects
 * the real way (`createWorkbenchProject`) and assert `listWorkbenchProjectNames`
 * surfaces every one of them, repo-less included.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchProject } from './onboarding';
import { removeRegistryProject } from '../shared/workbench-model';
import { listWorkbenchProjectNames, repolessProjectDirNames } from './workbench-projects';

const exec = promisify(execFile);

let home: string;
let workbench: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-wbproj-home-'));
  workbench = join(home, 'Workbench');
  await mkdir(workbench, { recursive: true });
  await git(workbench, 'init', '-q');
  await git(workbench, 'config', 'user.email', 'mc@test.local');
  await git(workbench, 'config', 'user.name', 'MC Test');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('listWorkbenchProjectNames (issue 99)', () => {
  it('lists a just-created repo-less project even though it wrote no registry entry', async () => {
    const res = await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Repoless QA',
      repos: [], // repo-less: name + workspace root, no code yet
    });
    expect(res.ok).toBe(true);
    expect(res.dirName).toBe('repoless-qa');

    // The whole point: the project the registry never mentions still appears.
    expect(await listWorkbenchProjectNames(workbench)).toContain('repoless-qa');
  });

  it('unions a repo-full (registry) project with a repo-less (directory-only) one', async () => {
    const repo = join(home, 'Developer', 'acme-api');
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q');

    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Acme Platform',
      repos: [{ key: 'api', path: repo }],
    });
    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Repoless QA',
      repos: [],
    });

    expect(await listWorkbenchProjectNames(workbench)).toEqual(['acme-platform', 'repoless-qa']);
  });

  it('skips a non-project directory that has no CONFIG.md', async () => {
    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Repoless QA',
      repos: [],
    });
    // A stray directory (no CONFIG.md) — not a project, must not be listed.
    await mkdir(join(workbench, 'scratch-notes'), { recursive: true });
    await writeFile(join(workbench, 'scratch-notes', 'README.md'), 'not a project');

    const names = await listWorkbenchProjectNames(workbench);
    expect(names).toContain('repoless-qa');
    expect(names).not.toContain('scratch-notes');
  });

  it('repolessProjectDirNames degrades to [] on an unreadable root', async () => {
    expect(await repolessProjectDirNames(join(home, 'NoSuchWorkbench'))).toEqual([]);
  });

  it('does NOT resurrect a removed repo-full project (removal is registry-only)', async () => {
    // A repo-full project: has an active registry entry AND a CONFIG that names
    // its repos.
    const repo = join(home, 'Developer', 'acme-api');
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q');
    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'Acme Platform',
      repos: [{ key: 'api', path: repo }],
    });
    expect(await listWorkbenchProjectNames(workbench)).toContain('acme-platform');

    // Remove it the way the ProjectRemove handler does: rewrite registry.md
    // only, leaving the workbench directory (and its populated repos: map) on
    // disk. It must NOT reappear — its CONFIG still names repos, so it is not
    // repo-less.
    const registryPath = join(workbench, 'registry.md');
    const removal = removeRegistryProject(await readFile(registryPath, 'utf8'), 'acme-platform');
    expect(removal.removed).toBeGreaterThan(0);
    await writeFile(registryPath, removal.content, 'utf8');

    expect(await listWorkbenchProjectNames(workbench)).not.toContain('acme-platform');
  });

  it('lists a repo-less project even when no registry.md exists yet (first project ever)', async () => {
    // Fresh workbench with no registry.md at all — the repo-less project is the
    // very first thing created, so a registry-only list would return nothing.
    await createWorkbenchProject({
      workbenchRoot: workbench,
      homeDir: home,
      name: 'First One',
      repos: [],
    });
    expect(await listWorkbenchProjectNames(workbench)).toEqual(['first-one']);
  });
});
