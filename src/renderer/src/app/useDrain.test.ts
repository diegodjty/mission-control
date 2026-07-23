// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backlog, BacklogIssue } from '../../../shared/backlog-model';
import { useDrain, type DrainDeps } from './useDrain';
import { newRun, type TrackedRun } from './appTypes';

/**
 * The drain-coordinator seam already lives in its own hook (issue 186,
 * mirroring 185's `useMergeLane`), which makes it the cleanest unit for
 * driving the re-plan effect / journal baseline / spawn glue directly:
 * `renderHook` drives it with `window.mc.applyIsolation` /
 * `writeDrainJournal` mocked, no App.tsx render required.
 */

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

function backlogWith(issues: BacklogIssue[], overrides: Partial<Backlog> = {}): Backlog {
  return {
    activePrd: null,
    workerModel: 'sonnet',
    escalationCeiling: 'opus',
    workerEffort: null,
    runTimeoutMinutes: 30,
    hotFiles: [],
    issues,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    backlog: backlogWith([]),
    projectPath: '/repo',
    activeProject: null,
    runs: [] as TrackedRun[],
    setRuns: vi.fn(),
    setFocusedId: vi.fn(),
    runLog: [],
    runLogRef: { current: [] },
    activityNotesRef: { current: [] },
    projectPathRef: { current: '/repo' },
    backlogRef: { current: overrides.backlog ?? backlogWith([]) },
    finishedUnmergedIdsRef: { current: overrides.finishedUnmergedIds ?? [] },
    runStatusOf: () => 'finished',
    isIsolated: () => false,
    needsIsolation: () => false,
    midMerge: false,
    finishedUnmergedIds: [],
    issueRepoResolutions: new globalThis.Map(),
    repoForIssueId: () => '/repo',
    workbenchPathsForRun: null,
    logNote: vi.fn(),
    applyShellEvent: vi.fn(),
    branchStatus: { branch: 'main', detached: false, protectedBranch: false },
    notUnderGit: false,
    setGitInitPrompt: vi.fn(),
    setGitInitError: vi.fn(),
    setBranchPrompt: vi.fn(),
    setBranchPromptMode: vi.fn(),
    setBranchPromptError: vi.fn(),
    ...overrides,
  };
}

describe('useDrain', () => {
  beforeEach(() => {
    (globalThis as any).window.mc = {
      applyIsolation: vi.fn().mockResolvedValue({
        placements: [],
        queuedIssueIds: [],
        nonGitRoots: [],
      }),
      writeDrainJournal: vi.fn().mockResolvedValue({ offerDebrief: false }),
      notifyScheduledDrainSkipped: vi.fn().mockResolvedValue({ notified: false }),
      discardAfkRun: vi.fn().mockResolvedValue({ ok: true, error: null }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('guardedStartDrain: an idle branch starts the drain and stamps runs from the re-plan', async () => {
    const setRuns = vi.fn();
    const setFocusedId = vi.fn();
    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    (window.mc.applyIsolation as any).mockResolvedValue({
      placements: [{ issueId: 1, cwd: '/repo' }],
      queuedIssueIds: [],
      nonGitRoots: [],
    });
    const deps = baseDeps({ backlog, setRuns, setFocusedId });

    const { result, rerender } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.guardedStartDrain(1);
    });
    expect(result.current.draining).toBe(true);

    // The re-plan effect only sees the fresh `draining` state on a re-render
    // with the SAME deps object it just produced.
    rerender(deps);

    await waitFor(() => expect(window.mc.applyIsolation).toHaveBeenCalled());
    await waitFor(() => expect(setRuns).toHaveBeenCalled());
    const updater = (setRuns as any).mock.calls[0][0];
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0].target.issueId).toBe(1);
    expect(next[0].target.headless).toBe(true);
    expect(next[0].drainGeneration).toBe(1);
  });

  it('startDrain refuses onto a mid-merge main without flipping draining', () => {
    const deps = baseDeps({ midMerge: true });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.startDrain(1);
    });

    expect(result.current.draining).toBe(false);
    expect(result.current.drainMessage).toMatch(/mid-merge/i);
  });

  it('startDrain refuses when nothing is eligible, naming the coordinator reason', () => {
    const deps = baseDeps({ backlog: backlogWith([]) });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.startDrain(1);
    });

    expect(result.current.draining).toBe(false);
    expect(result.current.drainMessage).toMatch(/cannot drain/i);
  });

  it('startDrain on a non-git root with cap > 1 opens the git-init prompt instead of draining', () => {
    const setGitInitPrompt = vi.fn();
    const deps = baseDeps({
      notUnderGit: true,
      backlog: backlogWith([issue({ id: 1, status: 'open' })]),
      setGitInitPrompt,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.startDrain(2);
    });

    expect(result.current.draining).toBe(false);
    expect(setGitInitPrompt).toHaveBeenCalledWith({ cap: 2 });
  });

  it('guardedStartDrain prompts the branch dialog on a protected branch instead of starting', () => {
    const setBranchPrompt = vi.fn();
    const deps = baseDeps({
      branchStatus: { branch: 'main', detached: false, protectedBranch: true },
      setBranchPrompt,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.guardedStartDrain(1);
    });

    expect(result.current.draining).toBe(false);
    expect(setBranchPrompt).toHaveBeenCalledWith({ kind: 'drain', cap: 1 });
  });

  it('scheduledFire: an idle branch starts the drain like guardedStartDrain, no notification', async () => {
    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    (window.mc.applyIsolation as any).mockResolvedValue({
      placements: [{ issueId: 1, cwd: '/repo' }],
      queuedIssueIds: [],
      nonGitRoots: [],
    });
    const deps = baseDeps({ backlog });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(1);
    });

    expect(result.current.draining).toBe(true);
    expect(window.mc.notifyScheduledDrainSkipped).not.toHaveBeenCalled();
  });

  it('scheduledFire on a protected branch skips (never prompts) and notifies the reason', () => {
    const setBranchPrompt = vi.fn();
    const deps = baseDeps({
      branchStatus: { branch: 'main', detached: false, protectedBranch: true },
      setBranchPrompt,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(1);
    });

    expect(result.current.draining).toBe(false);
    expect(setBranchPrompt).not.toHaveBeenCalled();
    expect(window.mc.notifyScheduledDrainSkipped).toHaveBeenCalledWith({
      projectPath: '/repo',
      reason: expect.stringContaining('protected branch'),
    });
  });

  it('scheduledFire with a detached HEAD skips and notifies, never prompting', () => {
    const setBranchPrompt = vi.fn();
    const deps = baseDeps({
      branchStatus: { branch: null, detached: true, protectedBranch: false },
      setBranchPrompt,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(1);
    });

    expect(result.current.draining).toBe(false);
    expect(setBranchPrompt).not.toHaveBeenCalled();
    expect(window.mc.notifyScheduledDrainSkipped).toHaveBeenCalledWith({
      projectPath: '/repo',
      reason: expect.stringContaining('detached'),
    });
  });

  it('scheduledFire onto a mid-merge main skips and notifies, without setting drainMessage', () => {
    const deps = baseDeps({ midMerge: true });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(1);
    });

    expect(result.current.draining).toBe(false);
    expect(window.mc.notifyScheduledDrainSkipped).toHaveBeenCalledWith({
      projectPath: '/repo',
      reason: expect.stringContaining('mid-merge'),
    });
  });

  it('scheduledFire with nothing eligible skips and notifies with the coordinator reason', () => {
    const deps = baseDeps({ backlog: backlogWith([issue({ id: 1, status: 'done' })]) });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(1);
    });

    expect(result.current.draining).toBe(false);
    expect(window.mc.notifyScheduledDrainSkipped).toHaveBeenCalledWith({
      projectPath: '/repo',
      reason: expect.stringContaining('nothing eligible'),
    });
  });

  it('scheduledFire on a non-git root with cap > 1 skips and notifies, never opening the git-init prompt', () => {
    const setGitInitPrompt = vi.fn();
    const deps = baseDeps({
      notUnderGit: true,
      backlog: backlogWith([issue({ id: 1, status: 'open' })]),
      setGitInitPrompt,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.scheduledFire(2);
    });

    expect(result.current.draining).toBe(false);
    expect(setGitInitPrompt).not.toHaveBeenCalled();
    expect(window.mc.notifyScheduledDrainSkipped).toHaveBeenCalledWith({
      projectPath: '/repo',
      reason: expect.stringContaining('not a git repository'),
    });
  });

  it('stopDrain: ends the drain, notes it, and writes the journal for a workbench project', async () => {
    const logNote = vi.fn();
    const deps = baseDeps({
      backlog: backlogWith([issue({ id: 1, status: 'open' })]),
      activeProject: {
        key: '/wb/project',
        kind: 'workbench',
        label: 'Project',
        issuesRoot: '/wb/project/issues',
        completionsRoot: '/wb/project/completions',
        defaultRepoPath: '/repo',
        repos: {},
        plannedRepoKeys: [],
        notUnderGit: false,
      } as any,
      logNote,
    });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.guardedStartDrain(1);
    });
    expect(result.current.draining).toBe(true);

    act(() => {
      result.current.stopDrain();
    });

    expect(result.current.draining).toBe(false);
    expect(result.current.drainMessage).toMatch(/stopped by you/i);
    expect(logNote).toHaveBeenCalledWith(
      expect.stringContaining('drain-stopped:'),
      'relay',
      expect.stringContaining('stopped by you'),
    );
    await waitFor(() => expect(window.mc.writeDrainJournal).toHaveBeenCalled(), { timeout: 6000 });
  }, 8000);

  it('the re-plan halts the drain with the Coordinator stop reason once nothing is eligible', () => {
    // The gate sees issue 1 still `open` on disk (its status hasn't caught up
    // yet) so `startDrain` proceeds — but its Run is ALREADY tracked
    // `finished` with no other issue to start, so the re-plan itself (not the
    // gate) is what ends the drain — synchronously, on the very first tick.
    const backlog = backlogWith([issue({ id: 1, status: 'open' })]);
    const trackedRun = newRun(
      {
        issueId: 1,
        issueFileName: '01-example.md',
        issueTitle: 'Example issue',
        projectPath: '/repo',
      },
      null,
    );
    const deps = baseDeps({ backlog, runs: [trackedRun] });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.guardedStartDrain(1);
    });

    expect(result.current.draining).toBe(false);
    expect(result.current.drainMessage).toMatch(/no eligible issue remains/i);
  });

  it('issue 202: a slot-fill re-validates eligibility against the freshest backlog before spawning, and discards a worktree already cut for a now-ineligible issue', async () => {
    // Issue 2 depends on issue 1. At decision time issue 1 reads `done`, so
    // issue 2 is startable and `applyIsolation` gets called for it — but
    // `applyIsolation` is real, async git I/O (issue 202): a worktree isn't
    // actually cut until it resolves. We hold that resolution open, let the
    // on-disk truth move (issue 1 reverts to `wip` — the dependency was never
    // really done), then resolve it. The Worker must never spawn for issue 2,
    // and the worktree/branch `applyIsolation` already cut for it must be
    // discarded immediately rather than left stranded.
    const backlogWithDependencyDone = backlogWith([
      issue({ id: 1, status: 'done' }),
      issue({ id: 2, fileName: '02-dependent.md', dependsOn: [1] }),
    ]);
    const backlogWithDependencyStillWip = backlogWith([
      issue({ id: 1, status: 'wip' }),
      issue({ id: 2, fileName: '02-dependent.md', dependsOn: [1] }),
    ]);

    let resolveApply!: (v: unknown) => void;
    (window.mc.applyIsolation as any).mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );

    const setRuns = vi.fn();
    const deps = baseDeps({ backlog: backlogWithDependencyDone, setRuns });
    const { result, rerender } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.guardedStartDrain(1);
    });
    rerender(deps);

    await waitFor(() => expect(window.mc.applyIsolation).toHaveBeenCalled());

    // The freshest on-disk state moves on while provisioning is in flight —
    // the SAME ref object the hook reads, mutated directly (exactly what a
    // live-mirror ref is for).
    deps.backlogRef.current = backlogWithDependencyStillWip;

    resolveApply({
      placements: [{ issueId: 2, slug: '02-dependent', cwd: '/repo/.afk-worktrees/02-dependent', branch: 'afk/02-dependent' }],
      queuedIssueIds: [],
      nonGitRoots: [],
    });

    await waitFor(() =>
      expect((window.mc as any).discardAfkRun).toHaveBeenCalledWith({
        projectPath: '/repo',
        slug: '02-dependent',
      }),
    );

    const spawnedIssue2 = setRuns.mock.calls.some(([updater]) =>
      (updater as (prev: TrackedRun[]) => TrackedRun[])([]).some((r) => r.target.issueId === 2),
    );
    expect(spawnedIssue2).toBe(false);
  });

  it('reset(): clears draining/message/debrief together', () => {
    const deps = baseDeps({ midMerge: true });
    const { result } = renderHook((d: DrainDeps) => useDrain(d), { initialProps: deps });

    act(() => {
      result.current.startDrain(1);
    });
    expect(result.current.drainMessage.length).toBeGreaterThan(0);

    act(() => {
      result.current.reset();
    });

    expect(result.current.draining).toBe(false);
    expect(result.current.drainMessage).toBe('');
    expect(result.current.debriefAvailable).toBe(false);
  });
});
