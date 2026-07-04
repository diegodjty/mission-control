import { describe, expect, it } from 'vitest';
import {
  locateOpenedProject,
  projectIdentityFor,
  resolveOpenedProject,
  type LocateInput,
} from './project-identity';
import { claimProject, emptyRegistry, registerProject } from './project-registry';

const HOME = '/Users/dev';
const WB = '/Users/dev/Workbench';

const REGISTRY = `# Registry

- repo: ~/code/api
  project: billing
  status: active
- repo: /Users/dev/code/web
  project: billing
  status: active
- repo: ~/code/legacy-app
  project: retired
  status: inactive
`;

const CONFIG = `---
repos:
  api: ~/code/api
  web: /Users/dev/code/web
default_repo: api
---

## Test commands

npm test
`;

function input(openedPath: string, overrides: Partial<LocateInput> = {}): LocateInput {
  return {
    openedPath,
    registryContent: REGISTRY,
    workbenchRoot: WB,
    homeDir: HOME,
    ...overrides,
  };
}

describe('locateOpenedProject', () => {
  it('resolves a registered repo path to its workbench project', () => {
    expect(locateOpenedProject(input('/Users/dev/code/api'))).toEqual({
      kind: 'workbench',
      project: 'billing',
      root: `${WB}/billing`,
    });
  });

  it('resolves a subdirectory of a registered repo to the same project', () => {
    expect(locateOpenedProject(input('/Users/dev/code/api/src/deep'))).toEqual({
      kind: 'workbench',
      project: 'billing',
      root: `${WB}/billing`,
    });
  });

  it('resolves the workbench project dir itself (no registry needed)', () => {
    expect(
      locateOpenedProject(input(`${WB}/billing`, { registryContent: null })),
    ).toEqual({ kind: 'workbench', project: 'billing', root: `${WB}/billing` });
  });

  it('resolves a path INSIDE the workbench project dir to the project', () => {
    expect(locateOpenedProject(input(`${WB}/billing/issues`))).toEqual({
      kind: 'workbench',
      project: 'billing',
      root: `${WB}/billing`,
    });
  });

  it('treats an unregistered repo as legacy — the QA-sandbox path', () => {
    expect(locateOpenedProject(input('/Users/dev/mc-qa-sandbox/repo-a'))).toEqual({
      kind: 'legacy',
      project: null,
      root: '/Users/dev/mc-qa-sandbox/repo-a',
    });
  });

  it('skips inactive registry entries (repo behaves as unregistered)', () => {
    expect(locateOpenedProject(input('/Users/dev/code/legacy-app'))).toEqual({
      kind: 'legacy',
      project: null,
      root: '/Users/dev/code/legacy-app',
    });
  });

  it('treats everything as legacy when there is no workbench at all', () => {
    expect(
      locateOpenedProject(
        input('/Users/dev/code/api', { registryContent: null, workbenchRoot: null }),
      ),
    ).toEqual({ kind: 'legacy', project: null, root: '/Users/dev/code/api' });
  });

  it('opening the workbench root itself names no project → legacy', () => {
    expect(locateOpenedProject(input(WB)).kind).toBe('legacy');
  });

  it('normalizes trailing slashes and whitespace on the opened path', () => {
    expect(locateOpenedProject(input('  /Users/dev/code/api/  '))).toEqual({
      kind: 'workbench',
      project: 'billing',
      root: `${WB}/billing`,
    });
  });

  it('never throws on garbage input', () => {
    expect(
      locateOpenedProject({
        openedPath: undefined as unknown as string,
        registryContent: 42 as unknown as string,
        workbenchRoot: null,
        homeDir: null,
      }).kind,
    ).toBe('legacy');
  });
});

describe('projectIdentityFor', () => {
  it('builds the legacy identity: repo is key, roots under issues/', () => {
    const id = projectIdentityFor(
      { kind: 'legacy', project: null, root: '/repos/repo-a' },
      null,
      HOME,
    );
    expect(id).toEqual({
      key: '/repos/repo-a',
      kind: 'legacy',
      label: 'repo-a',
      issuesRoot: '/repos/repo-a/issues',
      completionsRoot: '/repos/repo-a/issues/completions',
      defaultRepoPath: '/repos/repo-a',
      repoPaths: ['/repos/repo-a'],
      repos: {},
    });
  });

  it('builds the workbench identity from CONFIG: roots, default repo, members', () => {
    const id = projectIdentityFor(
      { kind: 'workbench', project: 'billing', root: `${WB}/billing` },
      CONFIG,
      HOME,
    );
    expect(id).toEqual({
      key: `${WB}/billing`,
      kind: 'workbench',
      label: 'billing',
      issuesRoot: `${WB}/billing/issues`,
      completionsRoot: `${WB}/billing/completions`,
      defaultRepoPath: '/Users/dev/code/api', // tilde-expanded
      repoPaths: ['/Users/dev/code/api', '/Users/dev/code/web'],
      repos: { api: '/Users/dev/code/api', web: '/Users/dev/code/web' },
    });
  });

  it('exposes the keyed repos map, expanded, for issue repo: lookups (issue 72)', () => {
    const id = projectIdentityFor(
      { kind: 'workbench', project: 'billing', root: `${WB}/billing` },
      CONFIG,
      HOME,
    );
    expect(id.repos['api']).toBe('/Users/dev/code/api');
    expect(id.repos['web']).toBe('/Users/dev/code/web');
  });

  it('degrades a missing CONFIG to defaultRepoPath = key (Map still opens)', () => {
    const id = projectIdentityFor(
      { kind: 'workbench', project: 'billing', root: `${WB}/billing` },
      null,
      HOME,
    );
    expect(id.defaultRepoPath).toBe(`${WB}/billing`);
    expect(id.repoPaths).toEqual([]);
    expect(id.issuesRoot).toBe(`${WB}/billing/issues`);
  });

  it('degrades an unknown default_repo key to defaultRepoPath = key', () => {
    const broken = `---\nrepos:\n  api: ~/code/api\ndefault_repo: nope\n---\n`;
    const id = projectIdentityFor(
      { kind: 'workbench', project: 'billing', root: `${WB}/billing` },
      broken,
      HOME,
    );
    expect(id.defaultRepoPath).toBe(`${WB}/billing`);
  });

  it('a single-repo project needs no default_repo', () => {
    const single = `---\nrepos:\n  api: ~/code/api\n---\n`;
    const id = projectIdentityFor(
      { kind: 'workbench', project: 'billing', root: `${WB}/billing` },
      single,
      HOME,
    );
    expect(id.defaultRepoPath).toBe('/Users/dev/code/api');
  });
});

describe('alias convergence — the ownership key', () => {
  it('opening by workbench dir and by member-repo path yields the SAME key', () => {
    const byRepo = resolveOpenedProject(input('/Users/dev/code/web'), CONFIG);
    const byDir = resolveOpenedProject(input(`${WB}/billing`), CONFIG);
    expect(byRepo.key).toBe(byDir.key);
    expect(byRepo.issuesRoot).toBe(byDir.issuesRoot);
  });

  it('two Windows cannot own one Project under different aliases', () => {
    // Window A opens by repo path; Window B opens by workbench dir. Both
    // resolve to one key, so the registry's single-owner rule catches it.
    const keyA = resolveOpenedProject(input('/Users/dev/code/api'), CONFIG).key;
    const keyB = resolveOpenedProject(input(`${WB}/billing/`), CONFIG).key;
    expect(keyA).toBe(keyB);

    let reg = emptyRegistry();
    const registered = registerProject(reg, keyA);
    expect(registered.ok).toBe(true);
    reg = registered.registry;

    const claimA = claimProject(reg, keyA, 'window-a');
    expect(claimA.ok).toBe(true);

    const claimB = claimProject(claimA.registry, keyB, 'window-b');
    expect(claimB.ok).toBe(false);
    expect(claimB.error).toMatch(/another Window/);
  });

  it('legacy repos keep their repo path as the key — unchanged behavior', () => {
    const id = resolveOpenedProject(
      input('/Users/dev/mc-qa-sandbox/repo-a', { registryContent: null }),
      null,
    );
    expect(id.key).toBe('/Users/dev/mc-qa-sandbox/repo-a');
    expect(id.kind).toBe('legacy');
  });
});
