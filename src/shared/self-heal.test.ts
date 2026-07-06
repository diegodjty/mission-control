import { describe, it, expect } from 'vitest';
import { detectAppearedRepos, type SelfHealInput } from './self-heal';

/** A minimal input with sensible defaults, overridable per case. */
function input(overrides: Partial<SelfHealInput> = {}): SelfHealInput {
  return {
    workspaceRoot: '/home/dev/Developer/proj',
    entries: [],
    repos: {},
    registryContent: null,
    homeDir: '/home/dev',
    ...overrides,
  };
}

describe('detectAppearedRepos — the self-heal detector (issue 95, ADR-0017)', () => {
  it('a new .git dir under the workspace root, absent from repos, is one candidate', () => {
    const candidates = detectAppearedRepos(
      input({ entries: [{ name: 'api', isGit: true }] }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      path: '/home/dev/Developer/proj/api',
      name: 'api',
      suggestedKey: 'api',
    });
  });

  it('an already-registered repo (in the project repos: map) is not a candidate', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [{ name: 'api', isGit: true }],
        repos: { api: '~/Developer/proj/api' }, // `~/` expands to /home/dev
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('an already-registered repo (in the registry, any project) is not a candidate', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [{ name: 'api', isGit: true }],
        registryContent:
          '# Registry\n\n- repo: /home/dev/Developer/proj/api\n  project: other\n  status: active\n',
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('a registry entry written `~/`-style still excludes the matching repo', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [{ name: 'api', isGit: true }],
        registryContent: '- repo: ~/Developer/proj/api\n  project: other\n  status: inactive\n',
      }),
    );
    expect(candidates).toEqual([]); // inactive counts — the mapping exists
  });

  it('a non-git subdir under the workspace root is not a candidate', () => {
    const candidates = detectAppearedRepos(
      input({ entries: [{ name: 'notes', isGit: false }] }),
    );
    expect(candidates).toEqual([]);
  });

  it('a repo OUTSIDE the workspace root is never a candidate (never handed in)', () => {
    // The edge only ever lists the workspace root's OWN top-level entries, so a
    // sibling repo elsewhere simply never appears in `entries` — modeled here by
    // an empty listing even though such a repo exists on disk.
    const candidates = detectAppearedRepos(input({ entries: [] }));
    expect(candidates).toEqual([]);
  });

  it('null / empty workspace root (legacy, pre-0017) yields no candidates', () => {
    expect(detectAppearedRepos(input({ workspaceRoot: null, entries: [{ name: 'api', isGit: true }] }))).toEqual([]);
    expect(detectAppearedRepos(input({ workspaceRoot: '   ', entries: [{ name: 'api', isGit: true }] }))).toEqual([]);
  });

  it('surfaces only the unregistered repos when some are already members', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [
          { name: 'api', isGit: true }, // already a member
          { name: 'web', isGit: true }, // new → candidate
          { name: 'docs', isGit: false }, // not a repo
        ],
        repos: { api: '/home/dev/Developer/proj/api' },
      }),
    );
    expect(candidates.map((c) => c.name)).toEqual(['web']);
    expect(candidates[0].suggestedKey).toBe('web');
  });

  it('candidates come back sorted by name for a stable Inbox order', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [
          { name: 'zeta', isGit: true },
          { name: 'alpha', isGit: true },
        ],
      }),
    );
    expect(candidates.map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  it('bumps a suggested key that would collide with an existing repos key', () => {
    const candidates = detectAppearedRepos(
      input({
        // A repo dir named `api` appears, but the key `api` is already taken by a
        // DIFFERENT (planned) path — the suggestion must not shadow it.
        entries: [{ name: 'api', isGit: true }],
        repos: { api: '/home/dev/Developer/proj/legacy-api' },
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].suggestedKey).toBe('api-2');
  });

  it('ignores dotfiles / dot-dirs and path-shaped names at the workspace root', () => {
    const candidates = detectAppearedRepos(
      input({
        entries: [
          { name: '.git', isGit: false },
          { name: '.hidden', isGit: true },
          { name: 'a/b', isGit: true },
        ],
      }),
    );
    expect(candidates).toEqual([]);
  });

  it('never throws on malformed input', () => {
    expect(() => detectAppearedRepos({} as unknown as SelfHealInput)).not.toThrow();
    expect(detectAppearedRepos({} as unknown as SelfHealInput)).toEqual([]);
    expect(
      detectAppearedRepos({
        workspaceRoot: '/ws',
        entries: [null as unknown as never, { name: 'ok', isGit: true }],
        repos: null as unknown as Record<string, string>,
        registryContent: 12345 as unknown as string,
        homeDir: null,
      }),
    ).toEqual([{ path: '/ws/ok', name: 'ok', suggestedKey: 'ok' }]);
  });
});
