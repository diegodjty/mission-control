import { describe, it, expect } from 'vitest';
import type { MergeRunsResult } from './ipc-contract';
import {
  mergeResultDisplay,
  pendingMergeDisplay,
  emptyMergeDisplay,
  mergeThrewDisplay,
} from './merge-display';

const result = (over: Partial<MergeRunsResult>): MergeRunsResult => ({
  ok: false,
  conflicted: false,
  merged: [],
  message: '',
  output: '',
  ...over,
});

describe('mergeResultDisplay', () => {
  it('shows the concise merged-N headline and no output dump on a clean merge', () => {
    const d = mergeResultDisplay(
      result({
        ok: true,
        merged: ['03-x', '04-x'],
        message: 'Merged 2 branches into main and cleaned up their worktrees.',
        output: 'app: merged afk/03-x cleanly\napp: merged afk/04-x cleanly',
      }),
    );
    expect(d.tone).toBe('success');
    expect(d.headline).toBe('Merged 2 branches into main and cleaned up their worktrees.');
    expect(d.showOutput).toBe(false);
  });

  it('surfaces the conflicting-files output with the resolve headline on a conflict', () => {
    const conflictOutput =
      'app: conflict in afk/03-x needs you — not a clean append:\n    - src/foo.ts\n\n  The merge is left in place.';
    const d = mergeResultDisplay(
      result({
        conflicted: true,
        message: 'Merge stopped on a conflict — resolve the listed files, then Merge again. Nothing was cleaned up.',
        output: conflictOutput,
      }),
    );
    expect(d.tone).toBe('conflict');
    expect(d.headline).toContain('resolve');
    expect(d.showOutput).toBe(true);
    expect(d.output).toBe(conflictOutput);
  });

  it('renders the verbatim output for a non-conflict failure (preflight refusal)', () => {
    const errOutput = 'app is on \'feature\', not main. Check out main first.';
    const d = mergeResultDisplay(
      result({
        message: 'Merge could not run — see details below.',
        output: errOutput,
      }),
    );
    expect(d.tone).toBe('error');
    expect(d.headline).toBe('Merge could not run — see details below.');
    expect(d.showOutput).toBe(true);
    expect(d.output).toBe(errOutput);
  });

  it('does not show a panel for an error that produced no output', () => {
    const d = mergeResultDisplay(
      result({ message: 'Merge tool not found at /x/afk-merge.sh.', output: '' }),
    );
    expect(d.tone).toBe('error');
    expect(d.showOutput).toBe(false);
  });

  it('treats a failure that only skipped missing branches as the empty case, not an error', () => {
    const d = mergeResultDisplay(
      result({
        merged: [],
        message: 'Merge could not run — see details below.',
        output: 'app: no afk/17-x — skipping\napp: no afk/18-x — skipping',
      }),
    );
    expect(d.tone).toBe('empty');
    expect(d.headline).toContain('Nothing to merge');
    expect(d.showOutput).toBe(false);
  });

  it('still treats a real error mixed with a skip line as an error', () => {
    const d = mergeResultDisplay(
      result({
        message: 'Merge could not run — see details below.',
        output: 'app: no afk/17-x — skipping\napp has uncommitted changes. Commit or stash them first.',
      }),
    );
    expect(d.tone).toBe('error');
    expect(d.showOutput).toBe(true);
  });
});

describe('pendingMergeDisplay', () => {
  it('pluralizes the in-flight headline and shows no panel', () => {
    expect(pendingMergeDisplay(1)).toMatchObject({
      headline: 'Merging 1 finished Run…',
      tone: 'pending',
      showOutput: false,
    });
    expect(pendingMergeDisplay(3).headline).toBe('Merging 3 finished Runs…');
  });
});

describe('emptyMergeDisplay', () => {
  it('is a plain nothing-to-merge message with no panel', () => {
    const d = emptyMergeDisplay();
    expect(d.tone).toBe('empty');
    expect(d.headline).toContain('Nothing to merge');
    expect(d.showOutput).toBe(false);
    expect(d.headline).not.toContain('could not run');
  });
});

describe('mergeThrewDisplay', () => {
  it('surfaces the thrown detail in a panel', () => {
    const d = mergeThrewDisplay('IPC channel closed');
    expect(d.tone).toBe('error');
    expect(d.showOutput).toBe(true);
    expect(d.output).toBe('IPC channel closed');
  });

  it('shows no panel when there is no detail', () => {
    expect(mergeThrewDisplay('   ').showOutput).toBe(false);
  });
});
