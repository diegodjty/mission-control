import { describe, it, expect } from 'vitest';
import { repoForIssue, unknownRepoKeyNote } from './run-targeting';

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
    expect(repoForIssue(PROJECT, 'nope')).toEqual({ ok: false, unknownKey: 'nope' });
  });

  it('legacy project (no repos map): keyless issues target the repo itself', () => {
    const legacy = { repos: {}, defaultRepoPath: '/repos/legacy' };
    expect(repoForIssue(legacy, null)).toEqual({ ok: true, repoPath: '/repos/legacy' });
    // A repo: key on a legacy project's issue is unknown by construction.
    expect(repoForIssue(legacy, 'app')).toEqual({ ok: false, unknownKey: 'app' });
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
