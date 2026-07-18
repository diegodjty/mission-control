/**
 * Unit tests for the rolling-synthesis state (PURE) — issue 39, ADR-0009.
 *
 * Pins the retention rule the acceptance criteria call for:
 *   - a finished-and-merged issue folds into the summary and drops from verbatim;
 *   - an open/flagged (e.g. doc-drift) thread stays verbatim;
 *   - state size stays bounded across many events;
 *   - a superseding event (blocked → later completed) resolves and folds.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyState,
  foldEvent,
  foldEvents,
  isFoldable,
  isOpenOrFlagged,
  renderActiveContext,
  recallBlock,
  DEFAULT_RECENT_WINDOW,
  type SituationState,
} from './dispatcher-rolling-synthesis';
import type { CompletionBlockEvent } from './dispatcher-input-contract';
import type { RunOutcome } from './completion-parser';
import type { RunLogRecord } from './ipc-contract';

function event(over: Partial<CompletionBlockEvent> = {}): CompletionBlockEvent {
  return {
    kind: 'completion-block',
    id: `sess-${over.issueId ?? 'x'}`,
    issueId: 1,
    issue: '1 — a-thing',
    outcome: 'completed' as RunOutcome,
    whatChanged: 'Did a thing.',
    tryIt: 'Try the thing.',
    verified: 'Ran the thing.',
    bookkeeping: 'Touched a file.',
    docDrift: 'none',
    detail: null,
    ...over,
  };
}

/** A block still verbatim in active context (recent window OR open/flagged). */
function isVerbatim(state: SituationState, issueId: number): boolean {
  const inRecent = state.recentBlocks.some((e) => e.issueId === issueId);
  const inOpen = state.openThreads.some((e) => e.issueId === issueId);
  return inRecent || inOpen;
}

describe('retention classification', () => {
  it('a clean completion with no doc-drift is foldable', () => {
    expect(isFoldable(event({ outcome: 'completed', docDrift: 'none' }))).toBe(true);
    expect(isOpenOrFlagged(event({ outcome: 'completed', docDrift: 'none' }))).toBe(false);
  });

  it('a completed block that reports doc-drift is flagged, not foldable', () => {
    const flagged = event({ outcome: 'completed', docDrift: 'PRD §retention says 13mo; data holds 11 days.' });
    expect(isFoldable(flagged)).toBe(false);
    expect(isOpenOrFlagged(flagged)).toBe(true);
  });

  it('blocked / needs-verification / unknown are all open, never foldable', () => {
    for (const outcome of ['blocked', 'needs-verification', 'unknown'] as RunOutcome[]) {
      expect(isFoldable(event({ outcome }))).toBe(false);
    }
  });
});

describe('fold: finished issues fold into the summary and drop from verbatim', () => {
  it('a finished-and-merged issue eventually folds and is dropped verbatim', () => {
    // Window of 2: push issue 1 (clean), then two more clean issues so 1 ages out.
    let state = emptyState();
    state = foldEvent(state, event({ issueId: 1, id: 's1' }), { recentWindow: 2 });
    expect(isVerbatim(state, 1)).toBe(true); // still in the recent window

    state = foldEvent(state, event({ issueId: 2, id: 's2' }), { recentWindow: 2 });
    state = foldEvent(state, event({ issueId: 3, id: 's3' }), { recentWindow: 2 });

    // Issue 1 has aged out: folded into the summary, gone from verbatim.
    expect(isVerbatim(state, 1)).toBe(false);
    expect(state.rollingSummary.folded).toBe(1);
    expect(state.rollingSummary.highlights.join(' ')).toContain('issue 01');
    // The two most-recent (2 and 3) are still verbatim.
    expect(isVerbatim(state, 2)).toBe(true);
    expect(isVerbatim(state, 3)).toBe(true);
  });
});

describe('fold: open/flagged threads stay verbatim after ageing out', () => {
  it('a doc-drift block that ages out is retained verbatim as an open thread, not folded', () => {
    let state = emptyState();
    state = foldEvent(
      state,
      event({ issueId: 1, id: 's1', docDrift: 'PRD contradicts the code at `docs/PRD.md`.' }),
      { recentWindow: 1 },
    );
    // Push a clean issue so the flagged one ages out of the size-1 window.
    state = foldEvent(state, event({ issueId: 2, id: 's2' }), { recentWindow: 1 });

    expect(isVerbatim(state, 1)).toBe(true); // kept verbatim in openThreads
    expect(state.openThreads.map((e) => e.issueId)).toEqual([1]);
    expect(state.rollingSummary.folded).toBe(0); // NOT folded — it is flagged
  });

  it('a blocked block that ages out stays verbatim as an open thread', () => {
    let state = emptyState();
    state = foldEvent(
      state,
      event({ issueId: 7, id: 's7', outcome: 'blocked', whatChanged: null, detail: 'wip 62 blocks it' }),
      { recentWindow: 1 },
    );
    state = foldEvent(state, event({ issueId: 8, id: 's8' }), { recentWindow: 1 });

    expect(isVerbatim(state, 7)).toBe(true);
    expect(state.openThreads[0].detail).toBe('wip 62 blocks it');
    expect(state.rollingSummary.folded).toBe(0);
  });
});

describe('fold: a superseding event resolves an open thread', () => {
  it('a blocked issue that later completes cleanly folds and stops being kept verbatim', () => {
    let state = emptyState();
    // 1 blocked, ages out into openThreads behind two clean issues.
    state = foldEvents(
      state,
      [
        event({ issueId: 1, id: 's1', outcome: 'blocked', whatChanged: null, detail: 'blocked on X' }),
        event({ issueId: 2, id: 's2' }),
        event({ issueId: 3, id: 's3' }),
      ],
      { recentWindow: 2 },
    );
    expect(state.openThreads.map((e) => e.issueId)).toEqual([1]);

    // Issue 1 comes back and completes cleanly — the SAME thread supersedes.
    state = foldEvent(state, event({ issueId: 1, id: 's1b', outcome: 'completed' }), { recentWindow: 2 });
    // No longer an open thread; it is now the freshest recent block.
    expect(state.openThreads.map((e) => e.issueId)).toEqual([]);
    expect(state.recentBlocks.some((e) => e.issueId === 1 && e.outcome === 'completed')).toBe(true);
  });

  it('supersede does not duplicate a thread across recent + open', () => {
    let state = emptyState();
    state = foldEvent(state, event({ issueId: 5, id: 's5', outcome: 'blocked', whatChanged: null }));
    state = foldEvent(state, event({ issueId: 5, id: 's5', outcome: 'completed' }));
    const appearances =
      state.recentBlocks.filter((e) => e.issueId === 5).length +
      state.openThreads.filter((e) => e.issueId === 5).length;
    expect(appearances).toBe(1);
  });
});

describe('boundedness across a long drain', () => {
  it('recentBlocks and highlights stay capped, and serialized size is O(1), over many events', () => {
    let state = emptyState();
    const window = 4;
    const maxHighlights = 3;

    let sizeAfter50 = 0;
    for (let i = 1; i <= 500; i++) {
      state = foldEvent(state, event({ issueId: i, id: `s${i}` }), {
        recentWindow: window,
        maxHighlights,
      });
      if (i === 50) sizeAfter50 = JSON.stringify(state).length;
    }

    expect(state.recentBlocks.length).toBe(window);
    expect(state.openThreads.length).toBe(0); // all clean → nothing retained verbatim
    expect(state.rollingSummary.highlights.length).toBe(maxHighlights);
    expect(state.rollingSummary.folded).toBe(500 - window);

    // The state barely grew between event 50 and event 500: any delta is only the
    // widening of integer digits (`folded`/issue ids), never accumulated blocks.
    // Linear growth would be ~450× the per-event block size; this is a few bytes.
    const sizeAfter500 = JSON.stringify(state).length;
    expect(sizeAfter500 - sizeAfter50).toBeLessThan(40);
    expect(sizeAfter500).toBeLessThan(2000); // a hard bound, independent of drain length
  });

  it('uses the default window when no options are given', () => {
    let state = emptyState();
    for (let i = 1; i <= DEFAULT_RECENT_WINDOW + 10; i++) {
      state = foldEvent(state, event({ issueId: i, id: `s${i}` }));
    }
    expect(state.recentBlocks.length).toBe(DEFAULT_RECENT_WINDOW);
  });
});

describe('renderActiveContext', () => {
  it('is seed + summary + open/flagged + recent, and quotes a flagged thread verbatim', () => {
    let state = emptyState();
    state = foldEvents(
      state,
      [
        event({ issueId: 1, id: 's1', docDrift: 'PRD/reality mismatch here.' }),
        event({ issueId: 2, id: 's2', whatChanged: 'Added a button.' }),
        event({ issueId: 3, id: 's3', whatChanged: 'Wired an endpoint.' }),
      ],
      { recentWindow: 1 },
    );
    const text = renderActiveContext(state, 'SEED: backlog + PRD');

    expect(text).toContain('SEED: backlog + PRD');
    expect(text).toContain('Situation summary:');
    expect(text).toContain('Open / flagged threads');
    expect(text).toContain('PRD/reality mismatch here.'); // flagged, verbatim
    expect(text).toContain('Recent 1 block(s):');
    expect(text).toContain('Added a button.'); // folded issue 2's highlight in summary
  });

  it('reports an empty state cleanly', () => {
    expect(renderActiveContext(emptyState())).toContain('no finished issues folded yet');
  });
});

describe('recallBlock', () => {
  function logRecord(over: Partial<RunLogRecord> = {}): RunLogRecord {
    return {
      id: 'sess-1',
      capturedAt: '2026-07-02T10:00:00.000Z',
      slug: '01-a-thing',
      title: '01 — A thing',
      issue: '1 — a-thing',
      issueId: 1,
      whatChanged: 'Did a thing.',
      tryIt: null,
      verified: null,
      bookkeeping: null,
      docDrift: 'none',
      detail: null,
      outcome: 'completed',
      usage: null,
      ...over,
    };
  }

  it('returns the record for an issue id from a newest-first list', () => {
    const records = [logRecord({ issueId: 3, id: 's3' }), logRecord({ issueId: 1, id: 's1' })];
    expect(recallBlock(records, 1)?.id).toBe('s1');
    expect(recallBlock(records, 3)?.id).toBe('s3');
  });

  it('returns the freshest when an issue was re-captured', () => {
    const records = [
      logRecord({ issueId: 1, id: 's1b', whatChanged: 'final' }),
      logRecord({ issueId: 1, id: 's1a', whatChanged: 'draft' }),
    ];
    expect(recallBlock(records, 1)?.whatChanged).toBe('final');
  });

  it('returns null for an unknown issue id', () => {
    expect(recallBlock([logRecord()], 999)).toBeNull();
  });
});
