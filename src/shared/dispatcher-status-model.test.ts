/**
 * Unit tests for the Dispatcher status model (PURE) — issue 43.
 *
 * Pins the reconciliation the acceptance criteria call for:
 *   - the done-set matches the backlog, NOT the fed block stream;
 *   - a finished-unmerged `afk/` branch (cap≥2) is reflected as finished-unmerged;
 *   - an unknown-outcome capture is conveyed (with its detail), not dropped;
 *   - status comes from ground truth even when a block says otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileStatusModel,
  renderStatusModel,
  buildStatusSnapshotMessage,
  buildRunDigest,
  DIGEST_MAX_RUNS,
  debounceStatusModel,
  initialStatusDebounceState,
  REGRESSION_CHECKPOINTS,
  type StatusModelInput,
  type StatusDebounceState,
  type DispatcherStatusModel,
  type GroundedStatus,
} from './dispatcher-status-model';
import type { Backlog, BacklogIssue, IssueStatus } from './backlog-model';
import type { WorktreeRunState } from './worktree-scan';
import type { RunLogRecord } from './ipc-contract';
import type { RunOutcome } from './completion-parser';

function issue(id: number, status: IssueStatus): BacklogIssue {
  return {
    id,
    slug: `${String(id).padStart(2, '0')}-thing`,
    fileName: `${String(id).padStart(2, '0')}-thing.md`,
    title: `Issue ${id}`,
    status,
    dependsOn: [],
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

function backlog(issues: BacklogIssue[]): Backlog {
  return { activePrd: 'docs/PRD.md', workerModel: 'sonnet', escalationCeiling: 'opus', workerEffort: null, runTimeoutMinutes: 30, issues };
}

function record(over: Partial<RunLogRecord> & { id: string; outcome: RunOutcome }): RunLogRecord {
  return {
    issue: null,
    issueId: null,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    capturedAt: '2026-07-03T00:00:00.000Z',
    slug: null,
    title: null,
    usage: null,
    ...over,
  };
}

function input(over: Partial<StatusModelInput> = {}): StatusModelInput {
  return { backlog: null, worktreeStates: [], runLog: [], ...over };
}

describe('reconcileStatusModel — done-set from the backlog, not the blocks', () => {
  it('takes done/wip/open straight from the backlog', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(3, 'done'), issue(4, 'done'), issue(5, 'wip'), issue(6, 'open')]),
      }),
    );
    expect(model.doneIds).toEqual([1, 2, 3, 4]);
    expect(model.wipIds).toEqual([5]);
    expect(model.openIds).toEqual([6]);
  });

  it("reflects issues the backlog marks done even when NO completion block was seen for them (the issue-35 drift)", () => {
    // The exact bug: 03/04 are done on disk, but the Dispatcher never got their
    // blocks. With the reconcile, the run log is irrelevant to done-ness.
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(3, 'done'), issue(4, 'done'), issue(5, 'open')]),
        runLog: [
          // Only 01/02 ever produced a parsed block; 03/04 did not.
          record({ id: 's1', issueId: 1, outcome: 'completed' }),
          record({ id: 's2', issueId: 2, outcome: 'completed' }),
        ],
      }),
    );
    expect(model.doneIds).toEqual([1, 2, 3, 4]);
    expect(model.openIds).toEqual([5]);
  });

  it("does NOT infer done from a completion block when the backlog disagrees", () => {
    // A block claiming 'completed' must not upgrade a status the backlog still
    // reads as open — status is grounded in the backlog/scan, blocks are qualitative.
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'open')]),
        runLog: [record({ id: 's1', issueId: 1, outcome: 'completed' })],
      }),
    );
    expect(model.doneIds).toEqual([]);
    expect(model.openIds).toEqual([1]);
  });
});

describe('reconcileStatusModel — finished-unmerged overlay (cap≥2 route)', () => {
  const wt = (issueId: number, kind: WorktreeRunState['kind']): WorktreeRunState => ({
    issueId,
    slug: `${String(issueId).padStart(2, '0')}-thing`,
    kind,
  });

  it('reflects a finished-unmerged branch whose done flip the backlog cannot see', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(7, 'open')]), // main still reads open — flip is on afk/07-thing
        worktreeStates: [wt(7, 'finished-unmerged')],
      }),
    );
    expect(model.finishedUnmergedIds).toEqual([7]);
    expect(model.openIds).toEqual([]);
    expect(model.issues.find((i) => i.issueId === 7)?.status).toBe('finished-unmerged');
  });

  it('keeps a merged issue as done (backlog done wins over a stale finished-unmerged)', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(7, 'done')]),
        worktreeStates: [wt(7, 'finished-unmerged')],
      }),
    );
    expect(model.doneIds).toEqual([7]);
    expect(model.finishedUnmergedIds).toEqual([]);
  });

  it('does not let running/stranded/commit-failed branches change a status', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(8, 'open'), issue(9, 'open'), issue(10, 'open')]),
        worktreeStates: [wt(8, 'running'), wt(9, 'stranded'), wt(10, 'commit-failed')],
      }),
    );
    expect(model.openIds).toEqual([8, 9, 10]);
    expect(model.finishedUnmergedIds).toEqual([]);
  });

  it('adds a finished-unmerged issue the backlog does not list', () => {
    const model = reconcileStatusModel(
      input({ backlog: backlog([]), worktreeStates: [wt(12, 'finished-unmerged')] }),
    );
    expect(model.finishedUnmergedIds).toEqual([12]);
    expect(model.issues[0]).toMatchObject({ issueId: 12, status: 'finished-unmerged' });
  });
});

describe('reconcileStatusModel — unknown captures conveyed, not dropped', () => {
  it('surfaces unknown-outcome captures as needs-look with their detail', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(3, 'open'), issue(4, 'open')]),
        runLog: [
          record({ id: 's3', issueId: 3, slug: '03-thing', title: 'Issue 3', outcome: 'unknown', detail: 'streamed but never resolved' }),
          record({ id: 's4', issueId: 4, outcome: 'completed' }),
        ],
      }),
    );
    expect(model.needsLook).toHaveLength(1);
    expect(model.needsLook[0]).toMatchObject({
      runId: 's3',
      issueId: 3,
      slug: '03-thing',
      detail: 'streamed but never resolved',
    });
    // And it is NOT counted as done anywhere.
    expect(model.doneIds).toEqual([]);
  });

  it('conveys an unknown capture even when it carries no issue id', () => {
    const model = reconcileStatusModel(
      input({ runLog: [record({ id: 'sX', outcome: 'unknown', detail: 'garbled' })] }),
    );
    expect(model.needsLook).toEqual([
      { runId: 'sX', issueId: null, slug: null, title: null, detail: 'garbled' },
    ]);
  });
});

describe('debounceStatusModel — backward moves held, forward moves immediate (issue 49)', () => {
  // Build a reconciled model directly from grounded statuses — the debounce is a
  // pure fold over the reconciled model, independent of how reconcile produced it
  // (so this exercises `finished-unmerged`, which only ever comes from the afk
  // scan, as cleanly as backlog statuses).
  function model(entries: Array<[number, GroundedStatus]>): DispatcherStatusModel {
    const issues = entries.map(([issueId, status]) => ({ issueId, slug: null, title: null, status }));
    const ids = (s: GroundedStatus): number[] => issues.filter((i) => i.status === s).map((i) => i.issueId);
    return {
      issues,
      doneIds: ids('done'),
      finishedUnmergedIds: ids('finished-unmerged'),
      wipIds: ids('wip'),
      openIds: ids('open'),
      needsLook: [],
    };
  }

  // Thread a sequence of reconcile checkpoints (one grounded status for `id` per
  // snapshot) through the debounce, returning the SURFACED status after each —
  // mirroring the renderer feeding one reconcile checkpoint after another.
  function surfaced(id: number, statuses: GroundedStatus[]): (GroundedStatus | undefined)[] {
    let state: StatusDebounceState = initialStatusDebounceState();
    const out: (GroundedStatus | undefined)[] = [];
    for (const status of statuses) {
      const result = debounceStatusModel(model([[id, status]]), state);
      state = result.state;
      out.push(result.model.issues.find((i) => i.issueId === id)?.status);
    }
    return out;
  }

  it('sanity-checks the debounce window is the one ADR-0012 specifies', () => {
    expect(REGRESSION_CHECKPOINTS).toBe(2);
  });

  it('SUPPRESSES a one-snapshot backward move (the false "05 regressed to open" alarm)', () => {
    // done, a single transient open snapshot, recovered.
    expect(surfaced(5, ['done', 'open', 'done'])).toEqual(['done', 'done', 'done']);
  });

  it('debounces a finished-unmerged → open blip the same way (the dogfood case)', () => {
    // Held at the higher prior status on the first backward snapshot.
    expect(surfaced(6, ['finished-unmerged', 'open'])).toEqual([
      'finished-unmerged',
      'finished-unmerged',
    ]);
  });

  it('SURFACES a regression once it persists past the debounce window', () => {
    // CP1 done, CP2 open (held), CP3 open (persisted → surfaced).
    expect(surfaced(5, ['done', 'open', 'open'])).toEqual(['done', 'done', 'open']);
  });

  it('does NOT delay forward transitions (open → wip → done)', () => {
    expect(surfaced(5, ['open', 'wip', 'done'])).toEqual(['open', 'wip', 'done']);
  });

  it('does NOT delay a forward finished-unmerged → done (merged) transition', () => {
    expect(surfaced(7, ['finished-unmerged', 'done'])).toEqual(['finished-unmerged', 'done']);
  });

  it('adopts a brand-new issue at its reconciled status without treating it as a regression', () => {
    const { model: m } = debounceStatusModel(model([[9, 'open']]), initialStatusDebounceState());
    expect(m.openIds).toEqual([9]);
  });

  it('keeps the held-back status in the buckets, not just the per-issue list', () => {
    let state = initialStatusDebounceState();
    ({ state } = debounceStatusModel(model([[5, 'done']]), state));
    const { model: m } = debounceStatusModel(model([[5, 'open']]), state);
    // Surfaced buckets reflect the HELD status: still done, not yet open.
    expect(m.doneIds).toEqual([5]);
    expect(m.openIds).toEqual([]);
  });

  it('clears the pending regression when the status recovers, so a later blip is debounced afresh', () => {
    // done, blip (held), recovered (pending cleared), a NEW blip (held again).
    expect(surfaced(5, ['done', 'open', 'done', 'open'])).toEqual(['done', 'done', 'done', 'done']);
  });

  it('passes needs-look through untouched while a regression is held (reconcile → debounce)', () => {
    let state = initialStatusDebounceState();
    ({ state } = debounceStatusModel(
      reconcileStatusModel(input({ backlog: backlog([issue(5, 'done')]) })),
      state,
    ));
    const reconciled = reconcileStatusModel(
      input({
        backlog: backlog([issue(5, 'open')]),
        runLog: [record({ id: 's1', issueId: 8, outcome: 'unknown', detail: 'garbled' })],
      }),
    );
    const { model: m } = debounceStatusModel(reconciled, state);
    expect(m.needsLook).toHaveLength(1);
    expect(m.doneIds).toEqual([5]); // still held
  });
});

describe('renderStatusModel', () => {
  it('lists each grounded bucket and the needs-look items', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(5, 'wip'), issue(6, 'open'), issue(7, 'open')]),
        worktreeStates: [{ issueId: 7, slug: '07-thing', kind: 'finished-unmerged' }],
        runLog: [record({ id: 's9', issueId: 9, slug: '09-thing', outcome: 'unknown', detail: 'could not parse' })],
      }),
    );
    const text = renderStatusModel(model);
    expect(text).toContain('Done (merged): 01, 02');
    expect(text).toContain('Finished, not yet merged: 07');
    expect(text).toContain('In progress (wip): 05');
    expect(text).toContain('Open: 06');
    expect(text).toContain('Needs a look');
    expect(text).toContain('issue 09 — 09-thing: could not parse');
  });

  it('is a stable signature for an unchanged model (re-feed guard)', () => {
    const build = (): StatusModelInput =>
      input({ backlog: backlog([issue(1, 'done'), issue(2, 'open')]) });
    expect(renderStatusModel(reconcileStatusModel(build()))).toBe(
      renderStatusModel(reconcileStatusModel(build())),
    );
  });

  it('says nothing to report before the backlog loads', () => {
    expect(renderStatusModel(reconcileStatusModel(input()))).toContain('has not loaded yet');
  });

  it('truncates a very long detail body so the refresh stays bounded', () => {
    const long = 'x'.repeat(500);
    const text = renderStatusModel(
      reconcileStatusModel(input({ runLog: [record({ id: 's1', outcome: 'unknown', detail: long })] })),
    );
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });
});

describe('buildStatusSnapshotMessage — on-demand injection (issue 52)', () => {
  it('returns null when there is no model yet (nothing to inject)', () => {
    expect(buildStatusSnapshotMessage(null)).toBeNull();
  });

  it('returns null before the backlog loads (empty model, no needs-look)', () => {
    // The same "not loaded yet" state renderStatusModel guards against — we must
    // NOT inject a hollow snapshot on the user's query in that window.
    expect(buildStatusSnapshotMessage(reconcileStatusModel(input()))).toBeNull();
  });

  it('wraps the authoritative status body in on-query framing when there is real status', () => {
    const model = reconcileStatusModel(
      input({
        backlog: backlog([issue(1, 'done'), issue(2, 'done'), issue(5, 'wip'), issue(6, 'open')]),
      }),
    );
    const msg = buildStatusSnapshotMessage(model);
    expect(msg).not.toBeNull();
    // Framing tells the session to answer from THIS snapshot, not the seed.
    expect(msg).toContain('injected on your query');
    expect(msg).toContain('not the drain-start seed');
    // And it carries the full reconciled body verbatim.
    expect(msg).toContain(renderStatusModel(model));
    expect(msg).toContain('Done (merged): 01, 02');
    expect(msg).toContain('In progress (wip): 05');
    expect(msg).toContain('Open: 06');
  });

  it('injects when the only ground truth is a needs-look item (no backlog issues)', () => {
    const model = reconcileStatusModel(
      input({ runLog: [record({ id: 's1', issueId: 9, outcome: 'unknown', detail: 'huh' })] }),
    );
    const msg = buildStatusSnapshotMessage(model);
    expect(msg).not.toBeNull();
    expect(msg).toContain('Needs a look');
  });
});

describe('buildRunDigest — Completion-block digest for the on-ask injection (issue 61)', () => {
  const completed = (id: string, issueId: number, whatChanged: string): RunLogRecord =>
    record({
      id,
      issueId,
      slug: `${String(issueId).padStart(2, '0')}-thing`,
      outcome: 'completed',
      whatChanged,
    });

  it('names each new Run: issue id + slug, declared outcome, a What-changed extract', () => {
    const log = [
      completed('r4', 4, 'The Map now draws dependency edges.'),
      completed('r3', 3, 'Runs open in a fresh Pane.'),
    ];
    const digest = buildRunDigest(log, new Set());
    expect(digest.text).not.toBeNull();
    expect(digest.text).toContain('issue 04 — 04-thing');
    expect(digest.text).toContain('completed');
    expect(digest.text).toContain('The Map now draws dependency edges.');
    expect(digest.text).toContain('issue 03 — 03-thing');
    expect(digest.text).toContain('Runs open in a fresh Pane.');
    expect(digest.digestedIds).toEqual(expect.arrayContaining(['r3', 'r4']));
  });

  it('words an HITL park as waiting on the user, carrying the park reason', () => {
    const log = [
      record({
        id: 'r5',
        issueId: 5,
        slug: '05-manual-check',
        outcome: 'needs-verification',
        detail: 'Ready for manual verification: open the app and click the thing.',
      }),
    ];
    const digest = buildRunDigest(log, new Set());
    expect(digest.text).toContain('issue 05 — 05-manual-check');
    expect(digest.text).toContain('parked — waiting on your manual verification (HITL)');
    expect(digest.text).toContain('open the app and click the thing');
  });

  it('carries a blocked Run with its reason', () => {
    const log = [
      record({ id: 'r7', issueId: 7, outcome: 'blocked', detail: 'Issue 06 is wip and overlaps.' }),
    ];
    const digest = buildRunDigest(log, new Set());
    expect(digest.text).toContain('blocked');
    expect(digest.text).toContain('Issue 06 is wip and overlaps.');
  });

  it('does not repeat already-digested blocks; new Runs since the last ask still appear', () => {
    const log = [
      completed('r4', 4, 'Edges drawn.'),
      completed('r3', 3, 'Pane runs.'),
    ];
    const first = buildRunDigest(log, new Set());
    const fed = new Set(first.digestedIds);
    // Nothing new → no digest at all (the ask injects status only).
    const second = buildRunDigest(log, fed);
    expect(second.text).toBeNull();
    expect(second.digestedIds).toEqual([]);
    // A Run that finished after the last ask appears; the old ones do not.
    const grown = [completed('r6', 6, 'Drain caps at N.'), ...log];
    const third = buildRunDigest(grown, fed);
    expect(third.text).toContain('issue 06');
    expect(third.text).not.toContain('issue 04');
    expect(third.text).not.toContain('issue 03');
    expect(third.digestedIds).toEqual(['r6']);
  });

  it('excludes unknown-outcome captures and never marks them digested', () => {
    const log = [
      record({ id: 'r9', issueId: 9, outcome: 'unknown', detail: 'still streaming' }),
      completed('r3', 3, 'Pane runs.'),
    ];
    const digest = buildRunDigest(log, new Set());
    expect(digest.text).not.toContain('still streaming');
    expect(digest.digestedIds).toEqual(['r3']);
  });

  it('caps at the newest N and counts the elided so a 50-Run drain stays bounded', () => {
    const log = Array.from({ length: 50 }, (_, i) =>
      completed(`r${50 - i}`, 50 - i, `Change ${50 - i}.`),
    );
    const digest = buildRunDigest(log, new Set());
    expect(digest.text).not.toBeNull();
    const listed = (digest.text as string).match(/- issue \d\d/g) ?? [];
    expect(listed.length).toBe(DIGEST_MAX_RUNS);
    expect(digest.text).toContain('issue 50');
    expect(digest.text).not.toContain(`issue ${50 - DIGEST_MAX_RUNS}`);
    expect(digest.text).toContain(`${50 - DIGEST_MAX_RUNS} earlier Run(s)`);
    // The elided are acknowledged in aggregate — they count as given, so a later
    // ask does not replay a long drain's history into the session's context.
    expect(digest.digestedIds).toHaveLength(50);
  });

  it('truncates a long What-changed so an entry stays one-to-two lines', () => {
    const digest = buildRunDigest([completed('r1', 1, 'y'.repeat(600))], new Set());
    expect(digest.text).toContain('…');
    expect(digest.text).not.toContain('y'.repeat(600));
  });
});

describe('buildStatusSnapshotMessage — with the Completion-block digest (issue 61)', () => {
  const model = (): DispatcherStatusModel =>
    reconcileStatusModel(input({ backlog: backlog([issue(1, 'done'), issue(2, 'open')]) }));

  it('appends the digest after the authoritative status body', () => {
    const digest = buildRunDigest(
      [record({ id: 'r1', issueId: 1, slug: '01-thing', outcome: 'completed', whatChanged: 'It works now.' })],
      new Set(),
    );
    const msg = buildStatusSnapshotMessage(model(), digest.text);
    expect(msg).not.toBeNull();
    expect(msg).toContain('Done (merged): 01');
    expect(msg).toContain('issue 01 — 01-thing');
    expect(msg).toContain('It works now.');
    // Status first, digest second — the digest is qualitative, never authoritative.
    expect((msg as string).indexOf('Ground-truth status')).toBeLessThan(
      (msg as string).indexOf('Completion-block digest'),
    );
  });

  it('injects status alone when there is no digest (nothing new since the last ask)', () => {
    const msg = buildStatusSnapshotMessage(model(), null);
    expect(msg).toBe(buildStatusSnapshotMessage(model()));
    expect(msg).not.toContain('Completion-block digest');
  });

  it('still returns null with a digest when there is no status model (no hollow injection)', () => {
    expect(buildStatusSnapshotMessage(null, 'anything')).toBeNull();
  });
});
