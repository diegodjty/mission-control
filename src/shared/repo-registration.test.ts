import { describe, it, expect } from 'vitest';
import { planRepoRegistration, type RegisterRepoInput } from './repo-registration';
import { parseProjectConfig, parseRegistry } from './workbench-model';

const HOME = '/home/dev';

/** A repo-less project's CONFIG (what onboarding writes for zero repos). */
const REPO_LESS_CONFIG = [
  '---',
  'workspace_root: ~/Developer/demo',
  'repos:',
  '---',
  '',
  '# demo — project CONFIG',
  '',
  '## Test commands',
  '',
  'Not established yet.',
  '',
].join('\n');

/** A single-repo project's CONFIG. */
const ONE_REPO_CONFIG = [
  '---',
  'workspace_root: ~/Developer/demo',
  'repos:',
  '  api: ~/Developer/demo/api',
  'default_repo: api',
  '---',
  '',
  '# demo — project CONFIG',
  '',
].join('\n');

function input(overrides: Partial<RegisterRepoInput> = {}): RegisterRepoInput {
  return {
    project: 'demo',
    key: 'web',
    repoPath: '/home/dev/Developer/demo/web',
    configContent: REPO_LESS_CONFIG,
    registryContent: null,
    homeDir: HOME,
    ...overrides,
  };
}

describe('planRepoRegistration — self-heal confirm (issue 95, ADR-0017)', () => {
  it('adds the repo to a repo-less project and promotes it to default_repo', () => {
    const plan = planRepoRegistration(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // The rewritten CONFIG round-trips through the real parser.
    const config = parseProjectConfig(plan.configContent);
    expect(config.repos).toEqual({ web: '~/Developer/demo/web' });
    expect(config.defaultRepo).toBe('web'); // was repo-less → new repo is default
    expect(config.workspaceRoot).toBe('~/Developer/demo'); // untouched
    expect(config.testCommands).toContain('Not established yet.'); // body untouched

    // Path written in the registry's `~/` house style.
    expect(plan.writePath).toBe('~/Developer/demo/web');

    // The registry append is one active entry, parseable.
    const parsed = parseRegistry(plan.registryAppend);
    expect(parsed.entries).toEqual([
      { repo: '~/Developer/demo/web', project: 'demo', active: true },
    ]);
  });

  it('adds a second repo to an existing project WITHOUT changing its default', () => {
    const plan = planRepoRegistration(input({ configContent: ONE_REPO_CONFIG, key: 'web' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const config = parseProjectConfig(plan.configContent);
    expect(config.repos).toEqual({
      api: '~/Developer/demo/api',
      web: '~/Developer/demo/web',
    });
    expect(config.defaultRepo).toBe('api'); // unchanged — not the new repo
  });

  it('refuses a key already used by another repo', () => {
    const plan = planRepoRegistration(input({ configContent: ONE_REPO_CONFIG, key: 'api' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('"api" is already used');
  });

  it('refuses a path already a member of this project', () => {
    const plan = planRepoRegistration(
      input({ configContent: ONE_REPO_CONFIG, key: 'dup', repoPath: '/home/dev/Developer/demo/api' }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toMatch(/already registered to demo/);
  });

  it('refuses a path already registered to ANOTHER project (names the owner)', () => {
    const plan = planRepoRegistration(
      input({
        registryContent:
          '- repo: /home/dev/Developer/demo/web\n  project: other\n  status: active\n',
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('project "other"');
  });

  it('refuses a missing or fence-less CONFIG rather than guessing', () => {
    expect(planRepoRegistration(input({ configContent: null })).ok).toBe(false);
    expect(planRepoRegistration(input({ configContent: 'no frontmatter here' })).ok).toBe(false);
  });

  it('refuses an unusable key and a path-shaped project name, naming both', () => {
    const plan = planRepoRegistration(input({ key: 'has space', project: 'a/b' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('inserts a repos: block when the CONFIG has none at all', () => {
    const bare = ['---', 'workspace_root: ~/Developer/demo', '---', '', '# demo', ''].join('\n');
    const plan = planRepoRegistration(input({ configContent: bare }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const config = parseProjectConfig(plan.configContent);
    expect(config.repos).toEqual({ web: '~/Developer/demo/web' });
    expect(config.defaultRepo).toBe('web');
  });

  it('never throws on malformed input', () => {
    expect(() => planRepoRegistration({} as unknown as RegisterRepoInput)).not.toThrow();
    expect(planRepoRegistration({} as unknown as RegisterRepoInput).ok).toBe(false);
  });
});
