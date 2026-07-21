import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import { createMockBridge, legacyProject } from './app/test/mockBridge';

/**
 * App.tsx has no exported hooks/sub-units for most of its state seams (issue
 * 184) — `resetForProjectSwitch` and the cross-cutting primitives (`logNote`,
 * `runStatusOf`, `midMerge`, `TrackedRun`) still live as closures inside the
 * one component. The merge/auto-merge-lane seam (issue 185, `./app/
 * useMergeLane`) and the drain-coordinator seam (issue 186, `./app/useDrain`)
 * are extracted with their own focused unit tests; the drain re-plan test
 * below stays as an integration check that the extracted hook still wires
 * correctly through the real component. The fast harness here renders the
 * real `App`, mocks `window.mc` (every IPC call resolves to a safe default,
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

  it('scheduled drain (issue 190): fires the same start path at fire time, one-shot', async () => {
    const projectPath = '/repo/scheduled-drain-project';
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

    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectPath);
    });
    await waitFor(() => expect(mapPropsRef.current.branchStatus).not.toBeNull());

    // Idle until armed.
    expect(mapPropsRef.current.schedule).toEqual({ kind: 'idle' });

    // A near-future real time — the hook polls wall-clock time every second,
    // so this fires on the next tick or two without faking timers (which
    // would also have to fake out the App's own 1.5s scan/branch polls).
    const fireAt = Date.now() + 1_100;
    await act(async () => {
      mapPropsRef.current.onScheduleDrain(fireAt, 1);
    });
    expect(mapPropsRef.current.schedule).toEqual(
      expect.objectContaining({ kind: 'pending', fireAt, cap: 1 }),
    );
    // Not due yet — nothing starts.
    expect(mapPropsRef.current.draining).toBe(false);

    // Fire time reached: the SAME start path a manual Drain click uses ran —
    // draining flips true and the eligible issue starts, exactly like
    // `onDrain` in the sibling re-plan test above — and the schedule disarms
    // (one-shot: it does not stay pending or re-fire).
    await waitFor(() => expect(mapPropsRef.current.draining).toBe(true), { timeout: 6000 });
    await waitFor(
      () => expect(runTileCalls.current.some((p) => p.run.target.issueId === 1)).toBe(true),
      { timeout: 6000 },
    );
    expect(mapPropsRef.current.schedule).toEqual({ kind: 'idle' });
  }, 10000);

<<<<<<< HEAD
<<<<<<< HEAD
  it('scheduled drain (issue 191): a protected branch skips instead of prompting, and notifies the reason', async () => {
    const projectPath = '/repo/scheduled-drain-skip-project';
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
    // On a protected branch: the manual Drain path would prompt
    // (`BranchPromptDialog`) — a scheduled fire must skip instead, never prompt.
    (bridge.getGitBranchStatus as any).mockResolvedValue({
      branch: 'main',
      detached: false,
      protectedBranch: true,
    });

    render(<App />);
    await waitFor(() => expect(mapPropsRef.current).not.toBeNull());

    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectPath);
    });
    await waitFor(() => expect(mapPropsRef.current.branchStatus).not.toBeNull());

    const fireAt = Date.now() + 1_100;
    await act(async () => {
      mapPropsRef.current.onScheduleDrain(fireAt, 1);
    });

    // The schedule disarms one-shot at fire time either way — assert on the
    // notification + no-start, not on `schedule` staying pending.
    await waitFor(
      () => expect((bridge.notifyScheduledDrainSkipped as any).mock.calls.length).toBeGreaterThan(0),
      { timeout: 6000 },
    );
    expect((bridge.notifyScheduledDrainSkipped as any).mock.calls[0][0]).toEqual({
      projectPath,
      reason: expect.stringContaining('protected branch'),
    });
    // Never started, and never asked the (mocked-null) BranchPromptDialog for
    // input — the drain simply never begins.
    expect(mapPropsRef.current.draining).toBe(false);
    expect(runTileCalls.current.some((p) => p.run.target.issueId === 1)).toBe(false);
  }, 10000);

=======
>>>>>>> afk/192-scope-scheduled-drain-by-selection
  it('scheduled drain scoped by selection (issue 192): only the selected eligible issue starts; the unselected one is never touched', async () => {
    const projectPath = '/repo/scheduled-drain-scope-project';
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

    // Two independent eligible issues; the schedule only selects issue 2.
    const backlog = backlogWith([
      issue({ id: 1, status: 'open' }),
      issue({ id: 2, status: 'open' }),
    ]);
    await act(async () => {
      mapPropsRef.current.onBacklogLoaded(backlog, projectPath);
    });
    await waitFor(() => expect(mapPropsRef.current.branchStatus).not.toBeNull());

    const fireAt = Date.now() + 1_100;
    await act(async () => {
      mapPropsRef.current.onScheduleDrain(fireAt, 2, [2]);
    });
    expect(mapPropsRef.current.schedule).toEqual(
      expect.objectContaining({ kind: 'pending', fireAt, cap: 2, selectedIds: [2] }),
    );

    await waitFor(() => expect(mapPropsRef.current.draining).toBe(true), { timeout: 6000 });
    await waitFor(
      () => expect(runTileCalls.current.some((p) => p.run.target.issueId === 2)).toBe(true),
      { timeout: 6000 },
    );
    // Issue 1 was eligible too, but never selected — it must never start.
    expect(runTileCalls.current.some((p) => p.run.target.issueId === 1)).toBe(false);
    expect(mapPropsRef.current.schedule).toEqual({ kind: 'idle' });
  }, 10000);

=======
>>>>>>> afk/193-scheduled-drain-power-save-blocker
  it('scheduled drain (issue 190): a Project switch drops the pending schedule — it never fires into the new Project, nothing persists', async () => {
    const projectA = '/repo/schedule-switch-a';
    const projectB = '/repo/schedule-switch-b';

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

    const fireAt = Date.now() + 1_100;
    await act(async () => {
      mapPropsRef.current.onScheduleDrain(fireAt, 1);
    });
    expect(mapPropsRef.current.schedule.kind).toBe('pending');

    // Another Window switches the shared active Project away from A, exactly
    // as the sibling reset test above delivers it.
    (bridge.listProjects as any).mockResolvedValue({
      projects: [legacyProject({ key: projectA }), legacyProject({ key: projectB })],
      activeProjectKey: projectB,
      pendingOpen: null,
    });

    expect(registryListeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of registryListeners) listener();
    });

    await waitFor(() => expect(mapPropsRef.current.projectPath).toBe(projectB));
    // The reset dropped the pending schedule immediately — it is not merely
    // withheld, it is gone (nothing persisted, nothing to reconnect to).
    expect(mapPropsRef.current.schedule).toEqual({ kind: 'idle' });

    // Even past the original fire time, nothing starts — the schedule that
    // would have fired into project A is simply gone, and it must not bleed
    // into project B either.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
    expect(mapPropsRef.current.draining).toBe(false);
  }, 10000);

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
