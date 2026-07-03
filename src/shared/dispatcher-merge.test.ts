import { describe, expect, it } from 'vitest';
import {
  shouldAutoMerge,
  decideDispatcherMerge,
  type AutoMergeContext,
} from './dispatcher-merge';
import { classifyAuthority } from './dispatcher-authority';
import type { MergeRunsResult } from './ipc-contract';

/** A live-drain context where auto-merge is allowed; override per-case. */
function ctx(overrides: Partial<AutoMergeContext> = {}): AutoMergeContext {
  return {
    dispatcherActive: true,
    mergeableCount: 1,
    midMerge: false,
    merging: false,
    alreadyAttempted: false,
    ...overrides,
  };
}

/** A completed clean merge result; override per-case. */
function result(overrides: Partial<MergeRunsResult> = {}): MergeRunsResult {
  return {
    ok: true,
    conflicted: false,
    midMerge: false,
    merged: ['05-live-map-updates'],
    message: 'Merged 1 branch into main and cleaned up its worktree.',
    output: '',
    ...overrides,
  };
}

describe('shouldAutoMerge (pre-run guard)', () => {
  it('auto-merges when a drain is live and there is exactly a mergeable set to take', () => {
    expect(shouldAutoMerge(ctx())).toBe(true);
  });

  it('does not auto-merge outside a Dispatcher drain (manual button only)', () => {
    expect(shouldAutoMerge(ctx({ dispatcherActive: false }))).toBe(false);
  });

  it('does not auto-merge when nothing is mergeable', () => {
    expect(shouldAutoMerge(ctx({ mergeableCount: 0 }))).toBe(false);
  });

  it('does not auto-merge onto a mid-merge main (a prior conflict must be resolved first)', () => {
    expect(shouldAutoMerge(ctx({ midMerge: true }))).toBe(false);
  });

  it('does not fire a second merge while one is already in flight', () => {
    expect(shouldAutoMerge(ctx({ merging: true }))).toBe(false);
  });

  it('does not re-fire the same mergeable set (guards a preflight-failure loop)', () => {
    expect(shouldAutoMerge(ctx({ alreadyAttempted: true }))).toBe(false);
  });
});

describe('decideDispatcherMerge (post-run classification)', () => {
  it('a clean merge auto-proceeds as a passive note carrying the merge summary', () => {
    const decision = decideDispatcherMerge(result());
    expect(decision).toEqual({
      kind: 'auto',
      action: 'merge',
      note: 'Merged 1 branch into main and cleaned up its worktree.',
    });
    // The note action is on the non-blocking (passive) tier — never a gate.
    expect(classifyAuthority('merge')).toBe('passive');
  });

  it('a conflict blocks for approval and surfaces the reason (never auto-resolves)', () => {
    const conflict = result({
      ok: false,
      conflicted: true,
      midMerge: true,
      merged: [],
      conflictingFiles: ['src/app.ts'],
      message:
        'Hit a conflict on 05-live-map-updates in src/app.ts — main is now mid-merge. ' +
        'Resolve the conflict and commit, or Abort the merge to return main to a clean state.',
    });
    const decision = decideDispatcherMerge(conflict);
    expect(decision).toEqual({
      kind: 'gate',
      action: 'merge-conflict',
      reason: conflict.message,
    });
    // The gate action is on the blocking tier (issue 45's three-item list).
    expect(classifyAuthority('merge-conflict')).toBe('blocking');
  });

  it('a preflight failure (dirty tree / wrong branch) surfaces its reason WITHOUT an approval (issue 59)', () => {
    // Approving a preflight failure just retries into the same dirty tree and
    // fails identically — so it must NOT be presented as an approvable gate.
    const preflight = result({
      ok: false,
      conflicted: false,
      midMerge: false,
      merged: [],
      message:
        'Merge preflight failed: uncommitted changes on main: ' +
        'issues/completions/02-run-me.md. Commit or stash them, then Merge again.',
    });
    const decision = decideDispatcherMerge(preflight);
    expect(decision).toEqual({
      kind: 'halt',
      action: 'merge-preflight',
      reason: preflight.message,
    });
    // The surfaced note is passive (its own message), never a blocking approval.
    expect(classifyAuthority('merge-preflight')).toBe('passive');
  });

  it('a real conflict still gates exactly as before (ADR-0011 blocking list unchanged)', () => {
    const conflict = result({ ok: false, conflicted: true, midMerge: true, merged: [] });
    expect(decideDispatcherMerge(conflict).kind).toBe('gate');
  });

  it('a clean run that merged nothing is a no-op (no note, no gate)', () => {
    const decision = decideDispatcherMerge(result({ merged: [], message: 'Nothing to merge.' }));
    expect(decision).toEqual({ kind: 'noop' });
  });
});
