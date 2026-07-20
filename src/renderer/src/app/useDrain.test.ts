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
