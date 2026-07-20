import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import { createMockBridge, legacyProject } from './app/test/mockBridge';

/**
 * App.tsx has no exported hooks/sub-units for its state seams (issue 184) —
 * `resetForProjectSwitch`, the drain re-plan effect, and the cross-cutting
 * primitives (`logNote`, `runStatusOf`, `midMerge`, `TrackedRun`) all live as
 * closures inside the one component. The fast harness here renders the real
 * `App`, mocks `window.mc` (every IPC call resolves to a safe default,
 * overridable per test), and replaces every heavy view (Map, Pane, Launcher,
 * …) with a thin stub that hands its live props to the test via a captured
 * ref — so a test can call `mapProps.current.onBacklogLoaded(...)` exactly as
 * the real Map would, without needing that component's own dependencies.
 *
 * A Project switch, in the real app, is driven by the shared registry
 * broadcast (`onProjectRegistryChanged`) or the bootstrap `listProjects` read
 * — never by a prop Map itself exposes — so these tests fire it the same way:
 * by resolving `listProjects` with the next project and invoking the captured
 * registry-changed listener.
 */

const mapPropsRef: { current: any } = { current: null };
const runTileCalls: { current: any[] } = { current: [] };

vi.mock('./Map', () => ({
  Map: (props: any) => {
    mapPropsRef.current = props;
    return <div data-testid="map-stub" />;
  },
}));
vi.mock('./Pane', () => ({ Pane: () => <div data-testid="pane-stub" /> }));
vi.mock('./Launcher', () => ({ Launcher: () => <div data-testid="launcher-stub" /> }));
vi.mock('./PlanningView', () => ({ PlanningView: () => <div data-testid="planning-stub" /> }));
vi.mock('./ReceiptsView', () => ({ ReceiptsView: () => <div data-testid="receipts-stub" /> }));
vi.mock('./CostView', () => ({ CostView: () => <div data-testid="cost-stub" /> }));
vi.mock('./DocsView', () => ({ DocsView: () => <div data-testid="docs-stub" /> }));
vi.mock('./Attention', () => ({ Attention: () => <div data-testid="attention-stub" /> }));
vi.mock('./ProjectSwitcher', () => ({ ProjectSwitcher: () => <div data-testid="switcher-stub" /> }));
vi.mock('./CommandPalette', () => ({ CommandPalette: () => <div data-testid="palette-stub" /> }));
vi.mock('./AppDialogs', () => ({
  GitInitDialog: () => null,
  BranchPromptDialog: () => null,
  OpenChoiceDialog: () => null,
  InterruptDialog: () => null,
}));
vi.mock('./AppShell', () => ({
  AppShell: (props: any) => <div data-testid="shell-stub">{props.children}</div>,
}));
vi.mock('./RunTile', () => ({
  RunTile: (props: any) => {
    runTileCalls.current.push(props);
    return <div data-testid={`runtile-${props.run.target.issueId}`}>{props.status}</div>;
  },
}));

import { App } from './App';

function issue(overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: 1,
    slug: 'example',
    fileName: '01-example.md',
    title: 'Example issue',
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

function backlogWith(issues: BacklogIssue[]): Backlog {
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

describe('App.tsx state-seam harness', () => {
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    bridge = createMockBridge();
    (globalThis as any).window.mc = bridge;
    mapPropsRef.current = null;
    runTileCalls.current = [];
  });

  afterEach(() => {
    // Every test mounts a fresh `<App />`; without an explicit unmount its
    // polling effects (branch status, afk scan) keep firing against the NEXT
    // test's `window.mc` mock and racing to overwrite the shared prop refs.
    cleanup();
    vi.clearAllMocks();
  });

  it('boots to the Map stub with no active project', async () => {
    render(<App />);
    await waitFor(() => expect(mapPropsRef.current).not.toBeNull());
    expect(mapPropsRef.current.projectPath).toBeNull();
    expect(mapPropsRef.current.draining).toBe(false);
  });

  it('reattaches to the last active project on bootstrap and lets the Map push its backlog', async () => {
    const projectPath = '/repo/reattach-project';
    (bridge.listProjects as any).mockResolvedValue({
      projects: [legacyProject({ key: projectPath })],
      activeProjectKey: projectPath,
      pendingOpen: null,
    });

    render(<App />);
    // `Map`'s `projectPath` prop is the reattached `activeProjectKey` — set on
    // bootstrap before the Map has loaded (or pushed back) any backlog at all.
    await waitFor(() => expect(mapPropsRef.current?.projectPath).toBe(projectPath));

    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlogWith([issue({ id: 1 })]), projectPath);
    });

    expect(mapPropsRef.current.projectPath).toBe(projectPath);
  });

  it('drain re-plan starts the next queued issue once the cap frees (fast — no e2e)', async () => {
    const projectPath = '/repo/drain-project';
    (bridge.listProjects as any).mockResolvedValue({
      projects: [legacyProject({ key: projectPath })],
      activeProjectKey: projectPath,
      pendingOpen: null,
    });
    (bridge.applyIsolation as any).mockImplementation((req: any) =>
      Promise.resolve({
        parallel: false,
        placements: req.runs.map((r: any) => ({ issueId: r.issueId, cwd: projectPath })),
        queuedIssueIds: [],
        nonGitRoots: [],
      }),
    );
    (bridge.getGitBranchStatus as any).mockResolvedValue({
      branch: 'main',
      detached: false,
      protectedBranch: false,
    });

    render(<App />);
    await waitFor(() => expect(mapPropsRef.current).not.toBeNull());

    let backlog = backlogWith([issue({ id: 1, status: 'open' }), issue({ id: 2, status: 'open' })]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectPath);
    });
    // The branch-status poll must resolve (non-null) before a drain proceeds
    // past the guard (`branchGuardDecision` treats null as "still resolving,
    // hold the click") — wait for the resolved status to reach the Map prop.
    await waitFor(() => expect(mapPropsRef.current.branchStatus).not.toBeNull());

    await act(async () => {
      mapPropsRef.current.onCapChange(1);
    });
    await act(async () => {
      mapPropsRef.current.onDrain(1);
    });

    await waitFor(() => expect(mapPropsRef.current.draining).toBe(true));
    await waitFor(() =>
      expect(runTileCalls.current.some((p) => p.run.target.issueId === 1)).toBe(true),
    );
    expect(runTileCalls.current.some((p) => p.run.target.issueId === 2)).toBe(false);

    // Issue 1 finishes on disk (its status flips `done`) — the next Map
    // backlog push must re-plan and auto-start issue 2 with no further user
    // action, exactly the "queued Run auto-starts as slots free" behavior.
    backlog = backlogWith([issue({ id: 1, status: 'done' }), issue({ id: 2, status: 'open' })]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectPath);
    });

    await waitFor(() =>
      expect(runTileCalls.current.some((p) => p.run.target.issueId === 2)).toBe(true),
    );
  });

  it('resetForProjectSwitch clears drain + merge + launcher state together on a project switch', async () => {
    const projectA = '/repo/project-a';
    const projectB = '/repo/project-b';

    (bridge.listProjects as any).mockResolvedValue({
      projects: [legacyProject({ key: projectA })],
      activeProjectKey: projectA,
      pendingOpen: null,
    });
    (bridge.applyIsolation as any).mockResolvedValue({
      parallel: false,
      placements: [{ issueId: 1, cwd: projectA }],
      queuedIssueIds: [],
      nonGitRoots: [],
    });
    (bridge.getGitBranchStatus as any).mockResolvedValue({
      branch: 'main',
      detached: false,
      protectedBranch: false,
    });
    (bridge.scanAfkRuns as any).mockResolvedValue({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    });

    // App.tsx registers TWO independent `onProjectRegistryChanged` listeners
    // (the project-switch reset, and an unrelated Home-grid refresh) — capture
    // every one and fire them all, so this doesn't depend on registration order.
    const registryListeners: Array<() => void> = [];
    (bridge.onProjectRegistryChanged as any).mockImplementation((cb: () => void) => {
      registryListeners.push(cb);
      return () => {};
    });

    render(<App />);
    await waitFor(() => expect(mapPropsRef.current).not.toBeNull());

    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectA);
    });
    await waitFor(() => expect(mapPropsRef.current.branchStatus).not.toBeNull());

    await act(async () => {
      mapPropsRef.current.onDrain(1);
    });
    await waitFor(() => expect(mapPropsRef.current.draining).toBe(true));
    await waitFor(() =>
      expect(runTileCalls.current.some((p) => p.run.target.issueId === 1)).toBe(true),
    );

    // A merge conflict lands on `main` mid-drain (the next scan tick reports
    // it) — the reset must clear THIS, from the Map's eyes, the instant the
    // switch happens, not wait for the next scan tick against the new project.
    (bridge.scanAfkRuns as any).mockResolvedValue({
      branches: [],
      midMerge: true,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    });
    // The scan is polled every 1.5s (not event-driven) — give the next tick
    // room to land.
    await waitFor(() => expect(mapPropsRef.current.midMerge).toBe(true), { timeout: 3000 });

    // Another Window (or this one) switches the shared active Project to B —
    // delivered here exactly as production delivers it: a registry broadcast
    // whose follow-up `listProjects` names the new active key.
    (bridge.listProjects as any).mockResolvedValue({
      projects: [legacyProject({ key: projectA }), legacyProject({ key: projectB })],
      activeProjectKey: projectB,
      pendingOpen: null,
    });
    (bridge.scanAfkRuns as any).mockResolvedValue({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    });

    expect(registryListeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of registryListeners) listener();
    });

    await waitFor(() => expect(mapPropsRef.current.draining).toBe(false));
    // The Window has moved on to project B (the switch itself succeeded) —
    // it's the per-project bookkeeping (drain/merge/tracked-Run state) that
    // must have been dropped, not the active project.
    expect(mapPropsRef.current.projectPath).toBe(projectB);
    await waitFor(() => expect(mapPropsRef.current.midMerge).toBe(false));
    expect(screen.queryByTestId('runtile-1')).toBeNull();
  });
});
