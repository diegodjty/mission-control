/**
 * Issue 57 — Receipts are the SOLE capture input; the two honest signals that
 * replace the scroll scrape:
 *
 *   1. `finished-without-receipt` — ground truth says a Run ended but no Receipt
 *      exists for it → exactly one passive note naming the issue ("peek at the
 *      Pane"), routed to the ambient LOG, never a scrape of the tail buffer.
 *   2. Receipt/state mismatch — the Receipt's declared narrative disagrees with
 *      git's ground truth (e.g. Receipt says completed, issue file says wip) →
 *      one debounced passive note; the status model follows git (ADR-0013's
 *      trust hierarchy: state wins, the Receipt is narrative only).
 *
 * Plus the removed-scroll-path guarantee: a boot-screen-shaped buffer, even if
 * it somehow reached the feed as Receipt text, parses to an `unknown` with no
 * substance and is dropped by the noise floor — it can never become a card, a
 * status entry, or a note.
 */
import { describe, expect, it } from 'vitest';
import {
  auditMissingReceipts,
  detectReceiptStateMismatches,
  describeReceiptMismatch,
  hasReceiptFor,
  isReceiptRecord,
  latestReceiptOutcomeFor,
  type AuditedRun,
} from './receipt-audit';
import {
  actionForLifecycle,
  reactToLifecycleEvent,
} from './dispatcher-lifecycle';
import { classifyAuthority } from './action-authority';
import { isRealCapture } from './dispatcher-noise-floor';
import { toReceiptRunLogRecord } from './receipt-ingest';
import { reconcileStatusModel } from './dispatcher-status-model';
import { buildBacklog, type RawFile } from './backlog-model';
import type { RunLogRecord } from './ipc-contract';
import type { RunOutcome } from './completion-parser';

/** A Run-log record as the Receipt edge produces it (issue 56). */
function receiptRecord(over: Partial<RunLogRecord> & { issueId: number }): RunLogRecord {
  const slug = over.slug ?? `${String(over.issueId).padStart(2, '0')}-thing`;
  return {
    issue: `${over.issueId} — ${slug}`,
    whatChanged: 'Did the thing.',
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    outcome: 'completed' as RunOutcome,
    id: `receipt:${slug}:2026-07-03T10:00:00Z`,
    capturedAt: '2026-07-03T10:00:01.000Z',
    title: null,
    usage: null,
    ...over,
    slug,
  };
}

function run(over: Partial<AuditedRun> & { issueId: number }): AuditedRun {
  return {
    slug: `${String(over.issueId).padStart(2, '0')}-thing`,
    title: null,
    status: 'finished',
    ...over,
  };
}

describe('isReceiptRecord / hasReceiptFor', () => {
  it('recognises records the Receipt edge produced by their id', () => {
    expect(isReceiptRecord(receiptRecord({ issueId: 5 }))).toBe(true);
    // A legacy scroll-captured record (id = PTY session id) is NOT a Receipt.
    expect(isReceiptRecord({ id: '2f6c9a0e-session-uuid' })).toBe(false);
  });

  it('finds a Receipt for an issue by its id, ignoring non-Receipt records', () => {
    const log = [
      receiptRecord({ issueId: 5 }),
      { ...receiptRecord({ issueId: 7 }), id: 'legacy-session-id' },
    ];
    expect(hasReceiptFor(log, 5)).toBe(true);
    // Issue 7's only record is a legacy scroll capture — no Receipt exists.
    expect(hasReceiptFor(log, 7)).toBe(false);
    expect(hasReceiptFor(log, 9)).toBe(false);
  });
});

describe('latestReceiptOutcomeFor — the declared outcome the park decision reads (issue 64)', () => {
  it('returns the outcome of the only Receipt for the issue', () => {
    const log = [receiptRecord({ issueId: 5, outcome: 'needs-verification' })];
    expect(latestReceiptOutcomeFor(log, 5)).toBe('needs-verification');
  });

  it('returns null when no Receipt exists for the issue', () => {
    expect(latestReceiptOutcomeFor([], 5)).toBeNull();
    expect(latestReceiptOutcomeFor([receiptRecord({ issueId: 2 })], 5)).toBeNull();
  });

  it('ignores legacy non-Receipt records entirely', () => {
    const log = [{ ...receiptRecord({ issueId: 5, outcome: 'blocked' }), id: 'legacy-session-id' }];
    expect(latestReceiptOutcomeFor(log, 5)).toBeNull();
  });

  it('judges only the LATEST Receipt per issue — a re-run supersedes', () => {
    const log = [
      receiptRecord({
        issueId: 5,
        outcome: 'blocked',
        id: 'receipt:05-thing:2026-07-03T09:00:00Z',
        capturedAt: '2026-07-03T09:00:01.000Z',
      }),
      receiptRecord({
        issueId: 5,
        outcome: 'needs-verification',
        id: 'receipt:05-thing:2026-07-03T10:00:00Z',
        capturedAt: '2026-07-03T10:00:01.000Z',
      }),
    ];
    expect(latestReceiptOutcomeFor(log, 5)).toBe('needs-verification');
    // Order-independent: the newest capturedAt wins regardless of log order.
    expect(latestReceiptOutcomeFor([...log].reverse(), 5)).toBe('needs-verification');
  });
});

describe('auditMissingReceipts — the finished-without-receipt signal', () => {
  it('yields ONE finished-without-receipt event for a Run that ended with no Receipt', () => {
    const events = auditMissingReceipts([run({ issueId: 5, slug: 'manual-check' })], []);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('finished-without-receipt');
    expect(events[0].issueId).toBe(5);
    expect(events[0].slug).toBe('manual-check');
  });

  it('yields nothing when the Run has a Receipt', () => {
    const events = auditMissingReceipts(
      [run({ issueId: 5 })],
      [receiptRecord({ issueId: 5 })],
    );
    expect(events).toHaveLength(0);
  });

  it('audits ended Runs only — running and user-stopped Runs yield nothing', () => {
    const events = auditMissingReceipts(
      [
        run({ issueId: 1, status: 'running' }),
        run({ issueId: 2, status: 'stopped' }),
        run({ issueId: 3, status: 'blocked' }),
        run({ issueId: 4, status: 'finished' }),
      ],
      [],
    );
    // A blocked exit also owes a Receipt (ADR-0013: all three exit points).
    expect(events.map((e) => e.issueId)).toEqual([3, 4]);
  });

  it('the reaction is a passive ambient-log note naming the issue — never a chat prompt', () => {
    const [event] = auditMissingReceipts([run({ issueId: 5, slug: 'manual-check' })], []);
    const reaction = reactToLifecycleEvent(event);
    expect(reaction.notification).toContain('issue 05');
    expect(reaction.notification).toContain('finished without a receipt');
    expect(reaction.notification).toContain('peek at the Pane');
    // No gated action, not proactive — a routine passive fact.
    expect(reaction.proposal).toBeNull();
    expect(reaction.proactive).toBe(false);
    // Non-blocking (ADR-0012): a routine fact, not a gate.
    expect(classifyAuthority(actionForLifecycle(event.kind))).toBe('silent');
  });
});

describe('detectReceiptStateMismatches — state wins, narrative surfaces once', () => {
  const CONFIG = '## Active PRD\n\n`docs/PRD.md` — the PRD.\n';
  const files: RawFile[] = [
    {
      name: '05-manual-check.md',
      content: '---\nstatus: wip\ndepends_on: []\n---\n\n# 05 — manual-check',
    },
    {
      name: '06-other.md',
      content: '---\nstatus: done\ndepends_on: []\n---\n\n# 06 — other',
    },
  ];
  const model = reconcileStatusModel({
    backlog: buildBacklog(files, CONFIG),
    worktreeStates: [],
    runLog: [],
  });

  it('flags a Receipt claiming completed while git shows wip', () => {
    const mismatches = detectReceiptStateMismatches(
      [receiptRecord({ issueId: 5, slug: '05-manual-check', outcome: 'completed' })],
      model.issues,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].issueId).toBe(5);
    expect(mismatches[0].declared).toBe('completed');
    expect(mismatches[0].grounded).toBe('wip');
    const note = describeReceiptMismatch(mismatches[0]);
    expect(note).toContain('issue 05');
    expect(note).toContain('completed');
    expect(note).toContain('wip');
    // The note says which side wins (ADR-0013 trust hierarchy).
    expect(note.toLowerCase()).toContain('git');
  });

  it('is silent when Receipt and git agree', () => {
    const agree = [
      receiptRecord({ issueId: 6, slug: '06-other', outcome: 'completed' }),
      receiptRecord({ issueId: 5, slug: '05-manual-check', outcome: 'needs-verification' }),
    ];
    expect(detectReceiptStateMismatches(agree, model.issues)).toHaveLength(0);
  });

  it('flags a stale non-completed Receipt on an issue git says is done', () => {
    const mismatches = detectReceiptStateMismatches(
      [receiptRecord({ issueId: 6, slug: '06-other', outcome: 'blocked' })],
      model.issues,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].grounded).toBe('done');
  });

  it('judges only the LATEST Receipt per issue — a superseded re-run does not fire', () => {
    const log = [
      // Newest first, as the feed sorts: the re-run completed and git agrees.
      receiptRecord({
        issueId: 6,
        slug: '06-other',
        outcome: 'completed',
        id: 'receipt:06-other:2026-07-03T11:00:00Z',
        capturedAt: '2026-07-03T11:00:01.000Z',
      }),
      receiptRecord({
        issueId: 6,
        slug: '06-other',
        outcome: 'blocked',
        id: 'receipt:06-other:2026-07-03T09:00:00Z',
        capturedAt: '2026-07-03T09:00:01.000Z',
      }),
    ];
    expect(detectReceiptStateMismatches(log, model.issues)).toHaveLength(0);
  });

  it('ignores legacy non-Receipt records and unknown outcomes', () => {
    const log = [
      { ...receiptRecord({ issueId: 5, outcome: 'completed' }), id: 'legacy-session' },
      receiptRecord({ issueId: 5, slug: '05-manual-check', outcome: 'unknown' }),
    ];
    expect(detectReceiptStateMismatches(log, model.issues)).toHaveLength(0);
  });

  it('the status model itself follows git regardless of what Receipts claim', () => {
    // A Receipt claiming issue 05 completed does not move it out of wip: the
    // reconciled model never reads outcomes for status (state wins).
    const withClaim = reconcileStatusModel({
      backlog: buildBacklog(files, CONFIG),
      worktreeStates: [],
      runLog: [receiptRecord({ issueId: 5, slug: '05-manual-check', outcome: 'completed' })],
    });
    expect(withClaim.wipIds).toContain(5);
    expect(withClaim.doneIds).not.toContain(5);
  });
});

describe('the scroll path stays dead — boot-screen text can never surface', () => {
  const BOOT_SCREEN =
    '[2J[H✳ Claude Code v2.1\n' +
    'Welcome back, Diego!\n' +
    'Run /init to set up your project\n' +
    '? for shortcuts\n';

  it('a boot-screen-shaped buffer parses to an unknown with no substance and is dropped', () => {
    // Worst case: boot-screen chrome lands in a Receipt file. It classifies as
    // `unknown` (no frontmatter, no block shape) and the noise floor drops it —
    // no card, no note, no needs-a-look entry (issue 47 / ADR-0012 / ADR-0013).
    const record = toReceiptRunLogRecord(BOOT_SCREEN, '05-manual-check.md', '2026-07-03T10:00:00Z');
    expect(record.outcome).toBe('unknown');
    expect(isRealCapture(record)).toBe(false);
  });
});
