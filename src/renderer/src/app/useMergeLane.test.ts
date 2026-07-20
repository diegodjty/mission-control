// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AfkBranchFacts } from '../../../shared/worktree-scan';
import type { ActiveScanView } from '../../../shared/project-switch';
import type { RunLogRecord } from '../../../shared/ipc-contract';
import { useMergeLane, type MergeLaneDeps } from './useMergeLane';
import type { TrackedRun } from './appTypes';

/**
 * The merge/auto-merge-lane seam already lives in its own hook (issue 185),
 * which makes it the cleanest unit for issue 184's "merge-handler state
 * transitions" ask: `renderHook` drives it directly, with `window.mc.mergeRuns`
 * / `abortMerge` mocked, no App.tsx render required.
 */

function branch(overrides: Partial<AfkBranchFacts> = {}): AfkBranchFacts {
  return {
    issueId: 1,
    slug: '01-example',
    hasWorktree: false,
    committedStatus: 'done',
    worktreeStatus: 'done',
    mergedIntoMain: false,
    repoPath: '/repo',
    ...overrides,
  };
}

function receiptRecord(issueId: number, finished = '2026-07-20T00-00-00Z'): RunLogRecord {
  return {
    id: `receipt:${issueId.toString().padStart(2, '0')}-example:${finished}`,
    capturedAt: '2026-07-20T00:00:00.000Z',
    slug: `${issueId.toString().padStart(2, '0')}-example`,
    title: 'Example issue',
    usage: null,
    issue: null,
    issueId,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed',
  };
}

function baseDeps(overrides: Partial<MergeLaneDeps> = {}): MergeLaneDeps {
  const activeScan: ActiveScanView = {
    branches: [],
    midMerge: false,
    previews: [],
    previewNote: null,
    staleBuildNote: null,
  };
  return {
    projectPath: '/repo',
    activeScan,
    runLog: [],
    liveRunIssueIds: [],
    runs: [] as TrackedRun[],
    runStatusOf: () => 'finished',
    isIsolated: () => true,
    logNote: vi.fn(),
    onMergeCompleted: vi.fn(),
    recordProtectedLandTarget: vi.fn(),
    refreshScan: vi.fn(),
    ...overrides,
  };
}

describe('useMergeLane', () => {
  beforeEach(() => {
    (globalThis as any).window.mc = {
      mergeRuns: vi.fn(),
      abortMerge: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mergeStrays: pending → success display, and reports the merged ids/slugs', async () => {
    (window.mc.mergeRuns as any).mockResolvedValue({
      ok: true,
      conflicted: false,
      merged: ['01-example'],
      message: 'Merged 01 clean.',
      output: '',
    });
    const onMergeCompleted = vi.fn();
    const deps = baseDeps({
      activeScan: {
        branches: [branch({ issueId: 1, slug: '01-example' })],
        midMerge: false,
        previews: [],
        previewNote: null,
        staleBuildNote: null,
      },
      onMergeCompleted,
    });

    const { result } = renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    act(() => {
      result.current.mergeStrays(['01-example']);
    });
    expect(result.current.merging).toBe(true);
    expect(result.current.mergeDisplay?.tone).toBe('pending');

    await waitFor(() => expect(result.current.merging).toBe(false));
    expect(result.current.mergeDisplay?.tone).toBe('success');
    expect(onMergeCompleted).toHaveBeenCalledWith(new Set([1]), ['01-example']);
  });

  it('resolveConflict: a real conflict surfaces the conflict display and never calls onMergeCompleted', async () => {
    (window.mc.mergeRuns as any).mockResolvedValue({
      ok: false,
      conflicted: true,
      merged: [],
      message: 'Conflict merging 02.',
      output: 'CONFLICT (content): 02-example.md',
    });
    const onMergeCompleted = vi.fn();
    const deps = baseDeps({
      activeScan: {
        branches: [branch({ issueId: 2, slug: '02-example' })],
        midMerge: false,
        previews: [],
        previewNote: null,
        staleBuildNote: null,
      },
      onMergeCompleted,
    });
    const { result } = renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    act(() => {
      result.current.resolveConflict('02-example');
    });
    await waitFor(() => expect(result.current.merging).toBe(false));

    expect(result.current.mergeDisplay?.tone).not.toBe('success');
    expect(onMergeCompleted).not.toHaveBeenCalled();
  });

  it('runAbortMerge: aborting → clears the display and refreshes the scan on success', async () => {
    (window.mc.abortMerge as any).mockResolvedValue({ ok: true, error: null });
    const refreshScan = vi.fn();
    const deps = baseDeps({ refreshScan });
    const { result } = renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    act(() => {
      result.current.runAbortMerge();
    });
    expect(result.current.aborting).toBe(true);

    await waitFor(() => expect(result.current.aborting).toBe(false));
    expect(refreshScan).toHaveBeenCalledWith('/repo');
  });

  it('reset(): clears merging/aborting/mergeDisplay/sweepNote together', async () => {
    (window.mc.mergeRuns as any).mockResolvedValue({
      ok: true,
      conflicted: false,
      merged: ['01-example'],
      message: 'Merged 01 clean.',
      output: '',
    });
    const deps = baseDeps({
      activeScan: {
        branches: [branch({ issueId: 1, slug: '01-example' })],
        midMerge: false,
        previews: [],
        previewNote: null,
        staleBuildNote: null,
      },
    });
    const { result } = renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    act(() => {
      result.current.mergeStrays(['01-example']);
    });
    await waitFor(() => expect(result.current.merging).toBe(false));
    expect(result.current.mergeDisplay).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.merging).toBe(false);
    expect(result.current.aborting).toBe(false);
    expect(result.current.mergeDisplay).toBeNull();
    expect(result.current.sweepNote).toBeNull();
  });

  it('forceSweep(): nothing mergeable on disk sets a plain sweep note, no IPC call', () => {
    const deps = baseDeps();
    const { result } = renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    act(() => {
      result.current.forceSweep();
    });

    expect(result.current.sweepNote).toMatch(/nothing mergeable/i);
    expect(window.mc.mergeRuns).not.toHaveBeenCalled();
  });

  it('the always-on auto-merge lane effect merges a clean, Receipt-backed branch without any user click', async () => {
    (window.mc.mergeRuns as any).mockResolvedValue({
      ok: true,
      conflicted: false,
      merged: ['01-example'],
      message: 'Merged 01 clean.',
      output: '',
    });
    const onMergeCompleted = vi.fn();
    const deps = baseDeps({
      runLog: [receiptRecord(1)],
      onMergeCompleted,
      activeScan: {
        branches: [branch({ issueId: 1, slug: '01-example' })],
        midMerge: false,
        previews: [{ issueId: 1, slug: '01-example', verdict: { kind: 'clean' } }],
        previewNote: null,
        staleBuildNote: null,
      },
    });

    renderHook((d: MergeLaneDeps) => useMergeLane(d), { initialProps: deps });

    await waitFor(() => expect(window.mc.mergeRuns).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onMergeCompleted).toHaveBeenCalledWith(new Set([1]), ['01-example']));
  });
});
