import { describe, it, expect } from 'vitest';
import {
  emptyRegistry,
  normalizeProjectKey,
  findProject,
  registerProject,
  claimProject,
  releaseProject,
  switchActiveProject,
  transitionStage,
  canTransition,
  closeWindow,
  ownsProject,
  checkProjectOwnership,
  PIPELINE_STAGES,
  type ProjectRegistry,
} from './project-registry';

/** Register a set of repo paths into a fresh registry (all unowned). */
function withProjects(...paths: string[]): ProjectRegistry {
  return paths.reduce<ProjectRegistry>(
    (reg, p) => registerProject(reg, p).registry,
    emptyRegistry(),
  );
}

describe('normalizeProjectKey', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeProjectKey('  /Users/dev/billing/  ')).toBe('/Users/dev/billing');
    expect(normalizeProjectKey('/Users/dev/billing///')).toBe('/Users/dev/billing');
    expect(normalizeProjectKey('/Users/dev/billing')).toBe('/Users/dev/billing');
  });

  it('keeps a lone root slash', () => {
    expect(normalizeProjectKey('/')).toBe('/');
    expect(normalizeProjectKey('///')).toBe('/');
  });

  it('an empty/blank path normalizes to empty', () => {
    expect(normalizeProjectKey('')).toBe('');
    expect(normalizeProjectKey('   ')).toBe('');
  });
});

describe('registerProject — the registry of Projects', () => {
  it('registers a Project unowned at the default backlog stage', () => {
    const res = registerProject(emptyRegistry(), '/repo/a');
    expect(res.ok).toBe(true);
    expect(res.project).toEqual({
      key: '/repo/a',
      stage: 'backlog',
      ownerWindowId: null,
    });
    expect(res.registry.projects).toHaveLength(1);
  });

  it('can register multiple distinct Projects', () => {
    const reg = withProjects('/repo/a', '/repo/b', '/repo/c');
    expect(reg.projects.map((p) => p.key)).toEqual(['/repo/a', '/repo/b', '/repo/c']);
  });

  it('honours a chosen initial stage', () => {
    const res = registerProject(emptyRegistry(), '/repo/a', 'planning');
    expect(res.project?.stage).toBe('planning');
  });

  it('rejects a duplicate repo with a clear message and leaves the registry unchanged', () => {
    const reg = withProjects('/repo/a');
    const res = registerProject(reg, '/repo/a/');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('already registered');
    expect(res.registry).toBe(reg);
    expect(res.registry.projects).toHaveLength(1);
  });

  it('treats trailing-slash spellings as the same repo (normalized identity)', () => {
    const reg = withProjects('/repo/a');
    expect(registerProject(reg, '/repo/a///').ok).toBe(false);
  });

  it('rejects an empty repo path', () => {
    const res = registerProject(emptyRegistry(), '   ');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('path');
  });
});

describe('findProject', () => {
  it('finds a Project by any spelling of its path', () => {
    const reg = withProjects('/repo/a');
    expect(findProject(reg, '/repo/a/')?.key).toBe('/repo/a');
    expect(findProject(reg, '/repo/missing')).toBeUndefined();
  });
});

describe('claimProject — no two Windows manage the same repo', () => {
  it('an unowned Project is claimed by a Window', () => {
    const reg = withProjects('/repo/a');
    const res = claimProject(reg, '/repo/a', 'win-1');
    expect(res.ok).toBe(true);
    expect(res.project?.ownerWindowId).toBe('win-1');
  });

  it('rejects a second Window claiming an already-owned repo, with a clear message', () => {
    const claimed = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = claimProject(claimed, '/repo/a', 'win-2');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already open in another Window/i);
    // registry unchanged: win-1 still owns it
    expect(findProject(res.registry, '/repo/a')?.ownerWindowId).toBe('win-1');
  });

  it('re-claiming by the same Window is an idempotent success', () => {
    const claimed = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = claimProject(claimed, '/repo/a', 'win-1');
    expect(res.ok).toBe(true);
    expect(res.project?.ownerWindowId).toBe('win-1');
  });

  it('two different repos can be owned by two different Windows at once', () => {
    let reg = withProjects('/repo/a', '/repo/b');
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    const res = claimProject(reg, '/repo/b', 'win-2');
    expect(res.ok).toBe(true);
    expect(findProject(res.registry, '/repo/a')?.ownerWindowId).toBe('win-1');
    expect(findProject(res.registry, '/repo/b')?.ownerWindowId).toBe('win-2');
  });

  it('rejects claiming an unregistered repo', () => {
    const res = claimProject(withProjects('/repo/a'), '/repo/missing', 'win-1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No such Project');
  });
});

describe('releaseProject / closeWindow — freeing a repo for another Window', () => {
  it('the owning Window releases, then another Window may claim it', () => {
    let reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    reg = releaseProject(reg, '/repo/a', 'win-1').registry;
    expect(findProject(reg, '/repo/a')?.ownerWindowId).toBeNull();
    const res = claimProject(reg, '/repo/a', 'win-2');
    expect(res.ok).toBe(true);
    expect(res.project?.ownerWindowId).toBe('win-2');
  });

  it('a non-owning Window releasing is a no-op that leaves the owner intact', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = releaseProject(reg, '/repo/a', 'win-2');
    expect(res.ok).toBe(true);
    expect(findProject(res.registry, '/repo/a')?.ownerWindowId).toBe('win-1');
  });

  it('closeWindow frees every repo that Window owned', () => {
    let reg = withProjects('/repo/a', '/repo/b', '/repo/c');
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    reg = claimProject(reg, '/repo/b', 'win-1').registry;
    reg = claimProject(reg, '/repo/c', 'win-2').registry;
    const after = closeWindow(reg, 'win-1');
    expect(findProject(after, '/repo/a')?.ownerWindowId).toBeNull();
    expect(findProject(after, '/repo/b')?.ownerWindowId).toBeNull();
    // win-2's claim is untouched
    expect(findProject(after, '/repo/c')?.ownerWindowId).toBe('win-2');
  });
});

describe('switchActiveProject — one Project per Window, switch within a Window', () => {
  it('a Window switches: it releases its old Project and claims the new one', () => {
    let reg = withProjects('/repo/a', '/repo/b');
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    const res = switchActiveProject(reg, 'win-1', '/repo/b');
    expect(res.ok).toBe(true);
    expect(findProject(res.registry, '/repo/a')?.ownerWindowId).toBeNull();
    expect(findProject(res.registry, '/repo/b')?.ownerWindowId).toBe('win-1');
  });

  it('rejects switching to a repo another Window owns, leaving the registry unchanged', () => {
    let reg = withProjects('/repo/a', '/repo/b');
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    reg = claimProject(reg, '/repo/b', 'win-2').registry;
    const res = switchActiveProject(reg, 'win-1', '/repo/b');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already open in another Window/i);
    // win-1 keeps /repo/a; nothing was released
    expect(findProject(res.registry, '/repo/a')?.ownerWindowId).toBe('win-1');
    expect(findProject(res.registry, '/repo/b')?.ownerWindowId).toBe('win-2');
  });

  it('rejects switching to an unregistered repo', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = switchActiveProject(reg, 'win-1', '/repo/missing');
    expect(res.ok).toBe(false);
  });
});

describe('canTransition — legal pipeline stage moves', () => {
  it('the pipeline is planning → backlog → executing → merge-qa', () => {
    expect(PIPELINE_STAGES).toEqual(['planning', 'backlog', 'executing', 'merge-qa']);
  });

  it('adjacent forward moves are legal', () => {
    expect(canTransition('planning', 'backlog')).toBe(true);
    expect(canTransition('backlog', 'executing')).toBe(true);
    expect(canTransition('executing', 'merge-qa')).toBe(true);
  });

  it('adjacent backward moves (rework) are legal', () => {
    expect(canTransition('merge-qa', 'executing')).toBe(true);
    expect(canTransition('executing', 'backlog')).toBe(true);
    expect(canTransition('backlog', 'planning')).toBe(true);
  });

  it('skipping a stage is illegal', () => {
    expect(canTransition('planning', 'executing')).toBe(false);
    expect(canTransition('backlog', 'merge-qa')).toBe(false);
    expect(canTransition('planning', 'merge-qa')).toBe(false);
  });

  it('staying in place is illegal', () => {
    expect(canTransition('backlog', 'backlog')).toBe(false);
  });
});

describe('transitionStage — applying a stage move', () => {
  it('a legal move updates the Project stage', () => {
    const reg = registerProject(emptyRegistry(), '/repo/a', 'backlog').registry;
    const res = transitionStage(reg, '/repo/a', 'executing');
    expect(res.ok).toBe(true);
    expect(res.project?.stage).toBe('executing');
  });

  it('an illegal (skipping) move is rejected with a clear message, registry unchanged', () => {
    const reg = registerProject(emptyRegistry(), '/repo/a', 'planning').registry;
    const res = transitionStage(reg, '/repo/a', 'executing');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Illegal stage transition');
    expect(findProject(res.registry, '/repo/a')?.stage).toBe('planning');
  });

  it('preserves ownership across a stage move', () => {
    let reg = registerProject(emptyRegistry(), '/repo/a', 'backlog').registry;
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    const res = transitionStage(reg, '/repo/a', 'executing');
    expect(res.project?.ownerWindowId).toBe('win-1');
  });

  it('rejects a transition on an unregistered repo', () => {
    expect(transitionStage(emptyRegistry(), '/repo/missing', 'executing').ok).toBe(false);
  });
});

describe('immutability — operations never mutate the input registry', () => {
  it('a successful claim returns a new registry, leaving the original untouched', () => {
    const reg = withProjects('/repo/a');
    const res = claimProject(reg, '/repo/a', 'win-1');
    expect(res.registry).not.toBe(reg);
    expect(reg.projects[0]?.ownerWindowId).toBeNull();
  });
});

describe('ownsProject — does a Window own a repo right now', () => {
  it('true only for the exact owning Window', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    expect(ownsProject(reg, '/repo/a', 'win-1')).toBe(true);
    expect(ownsProject(reg, '/repo/a', 'win-2')).toBe(false);
  });

  it('false for an unowned repo', () => {
    const reg = withProjects('/repo/a');
    expect(ownsProject(reg, '/repo/a', 'win-1')).toBe(false);
  });

  it('false for an unregistered repo', () => {
    expect(ownsProject(emptyRegistry(), '/repo/missing', 'win-1')).toBe(false);
  });

  it('matches on normalized path (trailing slash / whitespace)', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    expect(ownsProject(reg, '  /repo/a/  ', 'win-1')).toBe(true);
  });

  it('goes false the instant the owner releases (the mid-release case)', () => {
    let reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    reg = releaseProject(reg, '/repo/a', 'win-1').registry;
    expect(ownsProject(reg, '/repo/a', 'win-1')).toBe(false);
  });
});

describe('checkProjectOwnership — the action-time ownership guard', () => {
  it('allows the owning Window', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = checkProjectOwnership(reg, '/repo/a', 'win-1');
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
  });

  it('rejects a Window that does not own the repo, with a reason', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const res = checkProjectOwnership(reg, '/repo/a', 'win-2');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/another Window/);
  });

  it('rejects an unowned (registered but not open) repo', () => {
    const reg = withProjects('/repo/a');
    const res = checkProjectOwnership(reg, '/repo/a', 'win-1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not open in any Window/);
  });

  it('rejects an unregistered repo', () => {
    const res = checkProjectOwnership(emptyRegistry(), '/repo/missing', 'win-1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No Project is registered/);
  });

  it('a Window mid-release cannot act on the repo it just released', () => {
    let reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    // The releasing Window still holds a stale projectPath in its renderer...
    reg = releaseProject(reg, '/repo/a', 'win-1').registry;
    // ...but the live registry now rejects it acting on that repo.
    expect(checkProjectOwnership(reg, '/repo/a', 'win-1').ok).toBe(false);
  });

  it('after a switch, only the new owner passes for the target repo', () => {
    let reg = withProjects('/repo/a', '/repo/b');
    reg = claimProject(reg, '/repo/a', 'win-1').registry;
    reg = switchActiveProject(reg, 'win-1', '/repo/b').registry;
    // win-1 released /repo/a during the switch, so it can no longer act on it.
    expect(checkProjectOwnership(reg, '/repo/a', 'win-1').ok).toBe(false);
    expect(checkProjectOwnership(reg, '/repo/b', 'win-1').ok).toBe(true);
  });

  it('two different Windows can never both pass for the same repo', () => {
    const reg = claimProject(withProjects('/repo/a'), '/repo/a', 'win-1').registry;
    const a = checkProjectOwnership(reg, '/repo/a', 'win-1').ok;
    const b = checkProjectOwnership(reg, '/repo/a', 'win-2').ok;
    expect([a, b]).toEqual([true, false]);
  });
});
