import { describe, it, expect } from 'vitest';
import { takeoverKindFor, canTakeover, takeoverTarget } from './run-takeover';
import type { RunTarget } from './ipc-contract';

const HEADLESS_TARGET: RunTarget = {
  issueId: 7,
  issueFileName: '07-parallel-b.md',
  issueTitle: '07 — Parallel B',
  projectPath: '/repos/app/.afk-worktrees/07-parallel-b',
  workbench: {
    issuesRoot: '/Users/dev/Workbench/proj/issues',
    completionsRoot: '/Users/dev/Workbench/proj/completions',
  },
  headless: true,
};

describe('takeoverKindFor', () => {
  it('offers a LIVE take-over for a running headless Run with a captured session id', () => {
    expect(takeoverKindFor('running', true, 'sess-1')).toBe('live');
  });

  it('offers a POST-MORTEM resume for a finished headless Run with a captured session id', () => {
    expect(takeoverKindFor('finished', true, 'sess-1')).toBe('post-mortem');
  });

  it('offers nothing without a captured session id (nothing to --resume yet)', () => {
    expect(takeoverKindFor('running', true, null)).toBeNull();
    expect(takeoverKindFor('running', true, undefined)).toBeNull();
    expect(takeoverKindFor('running', true, '')).toBeNull();
    expect(takeoverKindFor('finished', true, null)).toBeNull();
  });

  it('offers nothing for a Run that is not headless (a Pane is already interactive)', () => {
    expect(takeoverKindFor('running', false, 'sess-1')).toBeNull();
    expect(takeoverKindFor('running', undefined, 'sess-1')).toBeNull();
  });

  it('offers nothing for blocked/stopped/parked — resuming would re-occupy a slot', () => {
    // A blocked/stopped Run's issue is still `wip`; resuming it as a Pane would
    // reset its liveness and wrongly read `running` again. Only done (finished)
    // and running qualify.
    expect(takeoverKindFor('blocked', true, 'sess-1')).toBeNull();
    expect(takeoverKindFor('stopped', true, 'sess-1')).toBeNull();
    expect(takeoverKindFor('parked', true, 'sess-1')).toBeNull();
  });
});

describe('canTakeover', () => {
  it('mirrors takeoverKindFor as a boolean', () => {
    expect(canTakeover('running', true, 'sess-1')).toBe(true);
    expect(canTakeover('finished', true, 'sess-1')).toBe(true);
    expect(canTakeover('running', true, null)).toBe(false);
    expect(canTakeover('blocked', true, 'sess-1')).toBe(false);
  });
});

describe('takeoverTarget', () => {
  it('produces a Pane resume target that keeps the Run identity (issue, cwd, workbench)', () => {
    const resumed = takeoverTarget(HEADLESS_TARGET, 'sess-live-9');
    // Identity preserved verbatim — this is why the slot + guard survive: the
    // coordinator sees the SAME issue id, and the session runs in the SAME cwd.
    expect(resumed.issueId).toBe(HEADLESS_TARGET.issueId);
    expect(resumed.issueFileName).toBe(HEADLESS_TARGET.issueFileName);
    expect(resumed.issueTitle).toBe(HEADLESS_TARGET.issueTitle);
    expect(resumed.projectPath).toBe(HEADLESS_TARGET.projectPath);
    expect(resumed.workbench).toEqual(HEADLESS_TARGET.workbench);
  });

  it('clears headless (Feed → Pane) and names the session to --resume', () => {
    const resumed = takeoverTarget(HEADLESS_TARGET, 'sess-live-9');
    expect(resumed.headless).toBe(false);
    expect(resumed.resume).toEqual({ claudeSessionId: 'sess-live-9' });
  });

  it('does not mutate the source target', () => {
    const before = structuredClone(HEADLESS_TARGET);
    takeoverTarget(HEADLESS_TARGET, 'sess-x');
    expect(HEADLESS_TARGET).toEqual(before);
  });
});
