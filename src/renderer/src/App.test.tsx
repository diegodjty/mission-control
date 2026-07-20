import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { App } from './App';
import { createMcMock } from './test/mcMock';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import type { ProjectView } from '../../shared/ipc-contract';

/**
 * App.tsx test harness (issue 184): pins the state-seam behavior 185–187 will
 * extract into hooks — project-switch reset, the drain re-plan effect, and
 * merge-handler state transitions — against a fully mocked `window.mc`
 * bridge, with every OTHER child component stubbed so only App's own
 * hooks/effects are under test. Fast (no real git/e2e).
 */

// Every child component App renders is mocked to a minimal stub: this test
// exercises App's own state/effects, not Map/Pane/etc.'s rendering. Map and
// RunTile are the two whose props the tests actually need, so their mocks
// capture the latest props for assertions/interaction.
const hoisted = vi.hoisted(() => ({
  mapProps: null as any,
}));

vi.mock('./Map', () => ({
  Map: (props: any) => {
    hoisted.mapProps = props;
    return <div data-testid="map" />;
  },
}));
vi.mock('./Pane', () => ({ Pane: () => <div data-testid="pane" /> }));
vi.mock('./RunTile', () => ({ RunTile: () => <div data-testid="run-tile" /> }));
vi.mock('./PlanningView', () => ({ PlanningView: () => <div data-testid="planning" /> }));
vi.mock('./Launcher', () => ({ Launcher: () => <div data-testid="launcher" /> }));
vi.mock('./Attention', () => ({ Attention: () => <div data-testid="attention" /> }));
vi.mock('./CommandPalette', () => ({ CommandPalette: () => <div data-testid="palette" /> }));
vi.mock('./ProjectSwitcher', () => ({
  ProjectSwitcher: () => <div data-testid="project-switcher" />,
}));
vi.mock('./AppDialogs', () => ({
  GitInitDialog: () => null,
  BranchPromptDialog: () => null,
  OpenChoiceDialog: () => null,
  InterruptDialog: () => null,
}));

const PROJECT_PATH = '/workbench/demo-project';

function mkIssue(id: number, overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status: 'open',
    dependsOn: [],
    parent: null,
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    runTimeoutMinutes: null,
    touches: [],
    inBatch: false,
    standalone: true,
    body: '',
    ...overrides,
  };
}

function mkBacklog(issues: BacklogIssue[]): Backlog {
  return {
    activePrd: null,
    workerModel: 'sonnet',
    escalationCeiling: 'opus',
    workerEffort: null,
    runTimeoutMinutes: 30,
    hotFiles: [],
    issues,
  };
}

function mkProject(key: string): ProjectView {
  return {
    key,
    kind: 'workbench',
    label: 'Demo project',
    issuesRoot: `${key}/issues`,
    completionsRoot: `${key}/completions`,
    defaultRepoPath: `${key}/repo`,
    repos: {},
    plannedRepoKeys: [],
    stage: 'executing',
    ownership: 'you',
    notUnderGit: false,
  };
}

/** Mounts App, drives the bootstrap effect to open PROJECT_PATH, and waits
 * for the Map mock's props to reflect it — every test's common starting
 * point. */
async function renderOpenedToProject(mc: ReturnType<typeof createMcMock>): Promise<void> {
  const project = mkProject(PROJECT_PATH);
  mc.listProjects = vi
    .fn()
    .mockResolvedValue({ projects: [project], activeProjectKey: null, pendingOpen: PROJECT_PATH });
  mc.openProject = vi.fn().mockResolvedValue({
    ok: true,
    error: null,
    activeProjectKey: PROJECT_PATH,
    projects: [project],
  });
  (window as unknown as { mc: typeof mc }).mc = mc;

  render(<App />);

  await waitFor(() => expect(hoisted.mapProps?.projectPath).toBe(PROJECT_PATH));
}

/** Simulates Map having loaded the backlog (App never loads it itself — the
 * real Map component does, then calls this back). */
function loadBacklog(backlog: Backlog | null, path: string = PROJECT_PATH): void {
  act(() => {
    hoisted.mapProps.onBacklogLoaded(backlog, path);
  });
}

beforeEach(() => {
  hoisted.mapProps = null;
});

describe('App — project-switch reset', () => {
  it('clears drain/merge state when the active Project changes underneath the Window', async () => {
    const mc = createMcMock();
    // App subscribes to `onProjectRegistryChanged` more than once (the
    // reset-on-switch effect AND the Launcher project-cards refresh) — a
    // registry event must reach every subscriber, not just the last one.
    const registryListeners: (() => void)[] = [];
    mc.onProjectRegistryChanged = vi.fn((listener: () => void) => {
      registryListeners.push(listener);
      return () => {};
    });
    await renderOpenedToProject(mc);
    loadBacklog(mkBacklog([mkIssue(1)]));

    // Drive a drain + a pending merge so there is real state to reset.
    await waitFor(() => expect(mc.getGitBranchStatus).toHaveBeenCalled());
    act(() => {
      hoisted.mapProps.onDrain(1);
    });
    await waitFor(() => expect(hoisted.mapProps.draining).toBe(true));

    act(() => {
      hoisted.mapProps.onMergeStrays(['01-slug']);
    });
    await waitFor(() => expect(hoisted.mapProps.merging).toBe(true));

    // Another Window switches the shared registry's active Project away from
    // this one — `resetForProjectSwitch` must fire before the new Project's
    // Map mounts, per the ADR-0026-noted `isProjectSwitch` guard.
    const otherProject = mkProject('/workbench/other-project');
    mc.listProjects = vi.fn().mockResolvedValue({
      projects: [otherProject],
      activeProjectKey: otherProject.key,
      pendingOpen: null,
    });

    expect(registryListeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of registryListeners) listener();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(hoisted.mapProps.projectPath).toBe(otherProject.key));
    expect(hoisted.mapProps.draining).toBe(false);
    expect(hoisted.mapProps.drainMessage).toBe('');
    expect(hoisted.mapProps.merging).toBe(false);
    expect(hoisted.mapProps.mergeDisplay).toBeNull();
  });
});

describe('App — drain re-plan effect', () => {
  it('starts a fresh Run for an eligible issue via the isolation adapter', async () => {
    const mc = createMcMock();
    await renderOpenedToProject(mc);
    loadBacklog(mkBacklog([mkIssue(7)]));
    await waitFor(() => expect(mc.getGitBranchStatus).toHaveBeenCalled());

    act(() => {
      hoisted.mapProps.onDrain(1);
    });

    await waitFor(() => expect(mc.applyIsolation).toHaveBeenCalled());
    const call = (mc.applyIsolation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.runs.map((r: { issueId: number }) => r.issueId)).toEqual([7]);

    await waitFor(() => expect(hoisted.mapProps.activeRunIssueIds).toContain(7));
    expect(hoisted.mapProps.draining).toBe(true);
  });

  it('stops the drain immediately with a truthful reason when nothing is eligible', async () => {
    const mc = createMcMock();
    await renderOpenedToProject(mc);
    // A `done` issue offers nothing for the coordinator to start.
    loadBacklog(mkBacklog([mkIssue(1, { status: 'done' })]));
    await waitFor(() => expect(mc.getGitBranchStatus).toHaveBeenCalled());

    act(() => {
      hoisted.mapProps.onDrain(1);
    });

    await waitFor(() => expect(hoisted.mapProps.draining).toBe(false));
    expect(hoisted.mapProps.drainMessage).toMatch(/no.*eligible|no issues/i);
    expect(mc.applyIsolation).not.toHaveBeenCalled();
  });
});

describe('App — merge-handler state transitions', () => {
  it('shows a pending display then the clean-merge result', async () => {
    const mc = createMcMock();
    let resolveMerge!: (result: unknown) => void;
    mc.mergeRuns = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveMerge = resolve;
      }),
    );
    await renderOpenedToProject(mc);
    loadBacklog(mkBacklog([]));

    act(() => {
      hoisted.mapProps.onMergeStrays(['01-slug']);
    });

    expect(hoisted.mapProps.merging).toBe(true);
    expect(hoisted.mapProps.mergeDisplay).toMatchObject({ tone: 'pending' });

    await act(async () => {
      resolveMerge({ ok: true, conflicted: false, merged: ['01-slug'], message: 'Merged 01.', output: '' });
      await Promise.resolve();
    });

    expect(hoisted.mapProps.mergeDisplay).toMatchObject({ tone: 'success', headline: 'Merged 01.' });
  });

  it('surfaces a conflict result distinctly from a clean merge', async () => {
    const mc = createMcMock();
    mc.mergeRuns = vi.fn().mockResolvedValue({
      ok: false,
      conflicted: true,
      merged: [],
      message: 'Conflict on 01.',
      output: 'CONFLICT (content): 01.md',
    });
    await renderOpenedToProject(mc);
    loadBacklog(mkBacklog([]));

    await act(async () => {
      hoisted.mapProps.onMergeStrays(['01-slug']);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(hoisted.mapProps.mergeDisplay).toMatchObject({ tone: 'conflict', headline: 'Conflict on 01.' }),
    );
  });

  it('ignores a second merge trigger while one is already in flight', async () => {
    const mc = createMcMock();
    mc.mergeRuns = vi.fn().mockReturnValue(new Promise(() => {}));
    await renderOpenedToProject(mc);
    loadBacklog(mkBacklog([]));

    act(() => {
      hoisted.mapProps.onMergeStrays(['01-slug']);
    });
    act(() => {
      hoisted.mapProps.onMergeStrays(['02-slug']);
    });

    expect(mc.mergeRuns).toHaveBeenCalledTimes(1);
  });
});
