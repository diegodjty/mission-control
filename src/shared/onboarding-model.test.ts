/**
 * Onboarding model (issue 82, ADR-0016): the pure validation + artifact
 * builders behind the Launcher's New project flow. The plan either refuses
 * with every problem named (collisions, already-registered repos) or yields
 * the exact CONFIG.md content and registry append block — which must
 * round-trip through the REAL workbench-model parsers and resolver, since
 * those are what every later session reads.
 */
import { describe, it, expect } from 'vitest';
import {
  contractTilde,
  planOnboarding,
  projectDirName,
  repoKeyFor,
  type OnboardingInput,
} from './onboarding-model';
import { parseProjectConfig, parseRegistry, resolveProject } from './workbench-model';

const HOME = '/Users/dev';

const REGISTRY = [
  '# Registry',
  '',
  '## Entries',
  '',
  '- repo: ~/Developer/mission-control',
  '  project: mission-control',
  '  status: active',
  '- repo: /Users/dev/code/legacy-repo',
  '  project: legacy-tool',
  '  status: inactive',
  '',
].join('\n');

function input(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    name: 'Billing Platform',
    repos: [
      { key: 'api', path: '~/Developer/billing-api', exists: true, isGit: true },
      { key: 'web', path: '/Users/dev/Developer/billing-web', exists: true, isGit: true },
    ],
    registryContent: REGISTRY,
    existingProjectDirs: ['mission-control', 'qa-sandbox'],
    homeDir: HOME,
    ...overrides,
  };
}

describe('projectDirName', () => {
  it('slugs a display name into a workbench directory name', () => {
    expect(projectDirName('Billing Platform')).toBe('billing-platform');
    expect(projectDirName('  My   App!  v2 ')).toBe('my-app-v2');
  });

  it('degrades to empty when nothing usable remains (the caller refuses)', () => {
    expect(projectDirName('???')).toBe('');
    expect(projectDirName('')).toBe('');
  });
});

describe('repoKeyFor', () => {
  it('derives a short key from the path basename', () => {
    expect(repoKeyFor('~/Developer/billing-api')).toBe('billing-api');
    expect(repoKeyFor('/Users/dev/code/My Repo/')).toBe('my-repo');
  });

  it('falls back to "repo" when the basename has nothing usable', () => {
    expect(repoKeyFor('')).toBe('repo');
    expect(repoKeyFor('///')).toBe('repo');
  });
});

describe('contractTilde', () => {
  it('rewrites a path under home to the ~/ form the registry uses', () => {
    expect(contractTilde('/Users/dev/Developer/x', HOME)).toBe('~/Developer/x');
    expect(contractTilde('/Users/dev', HOME)).toBe('~');
  });

  it('leaves foreign and already-contracted paths alone', () => {
    expect(contractTilde('/opt/code/x', HOME)).toBe('/opt/code/x');
    expect(contractTilde('~/Developer/x', HOME)).toBe('~/Developer/x');
    expect(contractTilde('/Users/devlin/x', HOME)).toBe('/Users/devlin/x');
    expect(contractTilde('/Users/dev/x', null)).toBe('/Users/dev/x');
  });
});

describe('planOnboarding — the happy path round-trips through the real parsers', () => {
  it('yields a CONFIG.md the workbench model reads back exactly', () => {
    const plan = planOnboarding(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.dirName).toBe('billing-platform');
    const config = parseProjectConfig(plan.configContent);
    expect(config.repos).toEqual({
      api: '~/Developer/billing-api',
      web: '~/Developer/billing-web',
    });
    // First repo = default.
    expect(config.defaultRepo).toBe('api');
    expect(config.notes).toEqual([]);
  });

  it('yields registry entries that resolve the project by EVERY member repo path', () => {
    const plan = planOnboarding(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const appended = `${REGISTRY}\n${plan.registryAppend}`;
    const { entries, notes } = parseRegistry(appended);
    expect(notes).toEqual([]);
    const added = entries.filter((e) => e.project === 'billing-platform');
    expect(added).toEqual([
      { repo: '~/Developer/billing-api', project: 'billing-platform', active: true },
      { repo: '~/Developer/billing-web', project: 'billing-platform', active: true },
    ]);

    // The exact lookup a bare session's skill (and MC) performs, per repo.
    for (const cwd of ['/Users/dev/Developer/billing-api', '/Users/dev/Developer/billing-web/src']) {
      const resolved = resolveProject({
        registryContent: appended,
        homeDir: HOME,
        cwd,
        legacyIssuesPresent: false,
      });
      expect(resolved).toMatchObject({ kind: 'workbench', project: 'billing-platform' });
    }

    // Pre-existing entries are untouched by the append.
    expect(entries.filter((e) => e.project === 'mission-control')).toHaveLength(1);
  });

  it('works against a missing registry (first project ever)', () => {
    const plan = planOnboarding(input({ registryContent: null, existingProjectDirs: [] }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { entries } = parseRegistry(plan.registryAppend);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.active)).toBe(true);
  });

  it('accepts a single-repo project', () => {
    const plan = planOnboarding(
      input({ repos: [{ key: 'app', path: '~/Developer/solo', exists: true, isGit: true }] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const config = parseProjectConfig(plan.configContent);
    expect(config.repos).toEqual({ app: '~/Developer/solo' });
    expect(config.defaultRepo).toBe('app');
    expect(plan.warnings).toEqual([]);
  });
});

describe('planOnboarding — refusals name every problem', () => {
  it('refuses an unusable project name', () => {
    const plan = planOnboarding(input({ name: '!!!' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toMatch(/project name/i);
  });

  it('refuses a name colliding with an existing workbench project directory', () => {
    const plan = planOnboarding(input({ name: 'QA Sandbox' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('qa-sandbox');
    expect(plan.errors.join(' ')).toMatch(/already exists/i);
  });

  it('refuses a name the registry already maps entries to (even without a dir yet)', () => {
    const plan = planOnboarding(input({ name: 'Legacy Tool' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('legacy-tool');
  });

  it('refuses a repo path already registered to another project — and says which', () => {
    const plan = planOnboarding(
      input({
        repos: [
          // Same repo the registry maps to mission-control, written absolute
          // while the registry writes it with ~ — normalization must match them.
          { key: 'app', path: '/Users/dev/Developer/mission-control/', exists: true, isGit: true },
        ],
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('mission-control');
    expect(plan.errors.join(' ')).toMatch(/already registered/i);
  });

  it('refuses a repo held by an inactive entry too (the mapping exists)', () => {
    const plan = planOnboarding(
      input({ repos: [{ key: 'app', path: '~/code/legacy-repo', exists: true, isGit: true }] }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.join(' ')).toContain('legacy-tool');
  });

  it('refuses zero repos, empty paths, duplicate keys, and duplicate paths', () => {
    expect(planOnboarding(input({ repos: [] })).ok).toBe(false);

    const empty = planOnboarding(
      input({ repos: [{ key: 'app', path: '   ', exists: false, isGit: false }] }),
    );
    expect(empty.ok).toBe(false);

    const dupKeys = planOnboarding(
      input({
        repos: [
          { key: 'app', path: '~/a', exists: true, isGit: true },
          { key: 'app', path: '~/b', exists: true, isGit: true },
        ],
      }),
    );
    expect(dupKeys.ok).toBe(false);
    if (!dupKeys.ok) expect(dupKeys.errors.join(' ')).toMatch(/key "app"/);

    const dupPaths = planOnboarding(
      input({
        repos: [
          { key: 'a', path: '~/same', exists: true, isGit: true },
          { key: 'b', path: '/Users/dev/same/', exists: true, isGit: true },
        ],
      }),
    );
    expect(dupPaths.ok).toBe(false);
  });

  it('refuses a key that has nothing usable or would not parse', () => {
    const plan = planOnboarding(
      input({ repos: [{ key: 'my key:x', path: '~/a', exists: true, isGit: true }] }),
    );
    expect(plan.ok).toBe(false);
  });

  it('collects ALL problems in one pass, not just the first', () => {
    const plan = planOnboarding(
      input({
        name: 'QA Sandbox',
        repos: [
          { key: 'app', path: '~/Developer/mission-control', exists: true, isGit: true },
          { key: 'app', path: '', exists: false, isGit: false },
        ],
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('planOnboarding — non-git and missing paths warn but do not refuse', () => {
  it('warns on a non-git path (docs-first projects are allowed)', () => {
    const plan = planOnboarding(
      input({ repos: [{ key: 'docs', path: '~/Notes/product', exists: true, isGit: false }] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings.join(' ')).toContain('~/Notes/product');
    expect(plan.warnings.join(' ')).toMatch(/not a git repo/i);
  });

  it('warns on a path that does not exist yet', () => {
    const plan = planOnboarding(
      input({ repos: [{ key: 'app', path: '~/Developer/future', exists: false, isGit: false }] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings.join(' ')).toMatch(/does not exist/i);
  });

  it('never throws on garbage input', () => {
    // @ts-expect-error deliberate abuse — the house PURE contract.
    expect(planOnboarding({}).ok).toBe(false);
    // @ts-expect-error deliberate abuse
    expect(planOnboarding(null).ok).toBe(false);
  });
});
