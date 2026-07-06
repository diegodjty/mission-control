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

  it('repo-less project (issue 94, ADR-0017): a no-repo issue resolves to the workspace root', () => {
    // A repo-less project's identity resolves defaultRepoPath to the workspace
    // root (project-identity, issue 93) — so a no-repo issue's Run targets the
    // workspace root, where a scaffold command creates code.
    const repoLess = { repos: {}, defaultRepoPath: '/Users/dev/Developer/billing' };
    expect(repoForIssue(repoLess, null)).toEqual({
      ok: true,
      repoPath: '/Users/dev/Developer/billing',
    });
  });

  it('a project with repos: keys still resolves each key to its path unchanged', () => {
    // Regression alongside the repo-less case: real repo keys are untouched.
    expect(repoForIssue(PROJECT, 'app')).toEqual({ ok: true, repoPath: '/repos/app' });
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
