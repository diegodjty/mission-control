import { describe, it, expect } from 'vitest';
import { decideWindowBootstrap } from './window-bootstrap';

describe('decideWindowBootstrap', () => {
  it('opens the queued target repo when the opener passed one', () => {
    expect(
      decideWindowBootstrap({ pendingOpen: '/repos/repo-b', activeRepoPath: null }),
    ).toEqual({ kind: 'open', repoPath: '/repos/repo-b' });
  });

  it('opens the queued target even if the Window somehow already owns another repo', () => {
    // pendingOpen wins — a freshly-created "Open in new Window" target takes
    // precedence over any pre-existing ownership.
    expect(
      decideWindowBootstrap({
        pendingOpen: '/repos/repo-b',
        activeRepoPath: '/repos/repo-a',
      }),
    ).toEqual({ kind: 'open', repoPath: '/repos/repo-b' });
  });

  it('re-attaches to the owned repo when there is no queued target', () => {
    expect(
      decideWindowBootstrap({ pendingOpen: null, activeRepoPath: '/repos/repo-a' }),
    ).toEqual({ kind: 'reattach', repoPath: '/repos/repo-a' });
  });

  it('opens NO Project (empty state) when there is no target and no owned repo', () => {
    // This is the case that used to silently open process.cwd() (the app's own
    // repo) and collide with the Window that already owned it.
    expect(
      decideWindowBootstrap({ pendingOpen: null, activeRepoPath: null }),
    ).toEqual({ kind: 'empty' });
  });

  it('treats a blank/whitespace pendingOpen as no target, never "open here" (cwd)', () => {
    // A blank pending path must NOT resolve to the backend cwd — it falls
    // through to the owned repo or the empty state.
    expect(
      decideWindowBootstrap({ pendingOpen: '', activeRepoPath: null }),
    ).toEqual({ kind: 'empty' });
    expect(
      decideWindowBootstrap({ pendingOpen: '   ', activeRepoPath: null }),
    ).toEqual({ kind: 'empty' });
    expect(
      decideWindowBootstrap({ pendingOpen: '  ', activeRepoPath: '/repos/repo-a' }),
    ).toEqual({ kind: 'reattach', repoPath: '/repos/repo-a' });
  });

  it('never returns a decision that opens the backend cwd', () => {
    // Whatever the inputs, the only "open" we ever emit is the explicit queued
    // target — there is no cwd fallthrough.
    for (const input of [
      { pendingOpen: null, activeRepoPath: null },
      { pendingOpen: '', activeRepoPath: null },
      { pendingOpen: '   ', activeRepoPath: '/x' },
    ]) {
      const decision = decideWindowBootstrap(input);
      expect(decision.kind).not.toBe('open');
    }
  });
});
