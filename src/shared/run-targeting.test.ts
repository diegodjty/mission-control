import { describe, it, expect } from 'vitest';
import { repoForIssue, unknownRepoKeyNote, plannedRepoHoldNote } from './run-targeting';

const PROJECT = {
  repos: { app: '/repos/app', api: '/repos/api' },
  defaultRepoPath: '/repos/app',
};

describe('repoForIssue (issue 72, ADR-0015)', () => {
  it('resolves a declared repo: key through the repos map', () => {
    expect(repoForIssue(PROJECT, 'api')).toEqual({ ok: true, repoPath: '/repos/api' });
  });

  it('falls back to the default repo when no key is declared', () => {
    expect(repoForIssue(PROJECT, null)).toEqual({ ok: true, repoPath: '/repos/app' });
  });

  it('resolves an unknown key to an explicit error — never a guessed path', () => {
    expect(repoForIssue(PROJECT, 'nope')).toEqual({
      ok: false,
      reason: 'unknownKey',
      unknownKey: 'nope',
    });
  });

  it('legacy project (no repos map): keyless issues target the repo itself', () => {
    const legacy = { repos: {}, defaultRepoPath: '/repos/legacy' };
    expect(repoForIssue(legacy, null)).toEqual({ ok: true, repoPath: '/repos/legacy' });
    // A repo: key on a legacy project's issue is unknown by construction.
    expect(repoForIssue(legacy, 'app')).toEqual({
      ok: false,
      reason: 'unknownKey',
      unknownKey: 'app',
    });
  });
});

describe('repoForIssue — planned repos (issue 96, ADR-0017)', () => {
  // A repo may be DECLARED in the repos map before its directory exists
  // (planned-first). `plannedRepoKeys` are declared keys whose directory is not
  // yet on disk; the adapter supplies them from an fs check.
  const PLANNED = {
    repos: { app: '/repos/app', api: '/repos/api' },
    defaultRepoPath: '/repos/app',
    plannedRepoKeys: ['api'],
  };

  it('a declared-but-absent repo: key resolves to planned (distinct from unknownKey)', () => {
    expect(repoForIssue(PLANNED, 'api')).toEqual({
      ok: false,
      reason: 'planned',
      repoKey: 'api',
      repoPath: '/repos/api',
    });
  });

  it('a genuinely unknown repo: key is still unknownKey, not planned', () => {
    expect(repoForIssue(PLANNED, 'nope')).toEqual({
      ok: false,
      reason: 'unknownKey',
      unknownKey: 'nope',
    });
  });

  it('a declared key whose repo now exists resolves to its path (planned → real)', () => {
    // `app` is declared and NOT in plannedRepoKeys → it exists → resolves.
    expect(repoForIssue(PLANNED, 'app')).toEqual({ ok: true, repoPath: '/repos/app' });
    // Once `api` is registered/created it drops out of plannedRepoKeys and
    // resolves exactly like any real repo — no code change, just newer facts.
    const registered = { ...PLANNED, plannedRepoKeys: [] };
    expect(repoForIssue(registered, 'api')).toEqual({ ok: true, repoPath: '/repos/api' });
  });

  it('an absent plannedRepoKeys field means every declared repo is real (back-compat)', () => {
    expect(repoForIssue(PROJECT, 'api')).toEqual({ ok: true, repoPath: '/repos/api' });
  });
});

describe('unknownRepoKeyNote', () => {
  it('names the issue, the bad key, and the known keys', () => {
    const note = unknownRepoKeyNote(7, 'nope', ['app', 'api']);
    expect(note).toContain('Issue 07');
    expect(note).toContain('"nope"');
    expect(note).toContain('known keys: app, api');
    expect(note).toContain('other issues continue');
  });

  it('says so when no repos are declared at all', () => {
    expect(unknownRepoKeyNote(7, 'x', [])).toContain('no repos declared');
  });
});

describe('plannedRepoHoldNote (issue 96, ADR-0017)', () => {
  it('names the issue and the planned repo, and reads as a hold — not an error', () => {
    const note = plannedRepoHoldNote(9, 'api');
    expect(note).toContain('Issue 09');
    expect(note).toContain('"api"');
    expect(note).toContain('planned');
    expect(note).toContain('held');
    // A hold lets siblings proceed — the same promise the unknown-key note makes.
    expect(note).toContain('other issues continue');
    // A hold is not an error: it must not read as a typo/failure.
    expect(note).not.toContain('unknown');
  });
});
