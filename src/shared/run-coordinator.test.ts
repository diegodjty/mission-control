import { describe, it, expect } from 'vitest';
import {
  planDrain,
  normalizeCap,
  isParkedHitl,
  drainAvailability,
  soloChainedIssueIds,
  type ActiveRun,
} from './run-coordinator';
import type { BacklogIssue, IssueStatus } from './backlog-model';
import type { RunStatus } from './run-state';

/** Minimal issue factory — only the fields the coordinator/eligibility read. */
function mk(
  id: number,
  status: IssueStatus,
  dependsOn: number[] = [],
  hitl = false,
): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl,
    repoKey: null,
    model: null,
    effort: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

const running = (id: number): ActiveRun => ({ issueId: id, status: 'running' });

/** A leftover Run from a PRIOR drain generation (issue 132). */
const leftover = (id: number, status: RunStatus = 'running'): ActiveRun => ({
  issueId: id,
  status,
  leftover: true,
});

describe('normalizeCap', () => {
  it('floors non-positive caps at 1', () => {
    expect(normalizeCap(0)).toBe(1);
    expect(normalizeCap(-3)).toBe(1);
  });

  it('floors fractional caps to an integer', () => {
    expect(normalizeCap(2.9)).toBe(2);
  });

  it('treats NaN/Infinity defensively as 1', () => {
    expect(normalizeCap(NaN)).toBe(1);
    expect(normalizeCap(Infinity)).toBe(1);
  });

  it('passes through a normal cap', () => {
    expect(normalizeCap(3)).toBe(3);
  });
});

describe('planDrain — startable set respects the cap', () => {
  it('starts every eligible issue when the cap exceeds their count', () => {
    const issues = [mk(1, 'open'), mk(2, 'open'), mk(3, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 5, activeRuns: [] });
    expect(plan.startable).toEqual([1, 2, 3]);
    expect(plan.queued).toEqual([]);
  });

  it('starts only up to the cap and queues the rest, lowest id first', () => {
    const issues = [mk(1, 'open'), mk(2, 'open'), mk(3, 'open'), mk(4, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toEqual([1, 2]);
    expect(plan.queued).toEqual([3, 4]);
  });

  it('orders startable/queued by id even when the input is unsorted', () => {
    const issues = [mk(3, 'open'), mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toEqual([1, 2]);
    expect(plan.queued).toEqual([3]);
  });

  it('only counts eligible issues — skips blocked, wip and done', () => {
    const issues = [
      mk(1, 'done'),
      mk(2, 'wip'),
      mk(3, 'open', [99]), // blocked: dep missing
      mk(4, 'open'), // eligible
      mk(5, 'open', [1]), // eligible: dep 1 is done
    ];
    const plan = planDrain({ issues, maxConcurrent: 10, activeRuns: [] });
    expect(plan.startable).toEqual([4, 5]);
    expect(plan.queued).toEqual([]);
  });
});

describe('planDrain — active Runs occupy slots', () => {
  it('leaves only cap-minus-running free slots for new Runs', () => {
    const issues = [mk(1, 'wip'), mk(2, 'open'), mk(3, 'open'), mk(4, 'open')];
    // issue 1 is already running (and wip on disk); cap 2 → 1 free slot.
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [running(1)] });
    expect(plan.startable).toEqual([2]);
    expect(plan.queued).toEqual([3, 4]);
  });

  it('starts nothing new while the cap is fully occupied', () => {
    const issues = [mk(1, 'wip'), mk(2, 'wip'), mk(3, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [running(1), running(2)],
    });
    expect(plan.startable).toEqual([]);
    expect(plan.queued).toEqual([3]);
  });

  it('auto-starts a queued Run once a running slot frees (re-plan)', () => {
    const issues = [mk(1, 'wip'), mk(2, 'open'), mk(3, 'open')];
    // First: cap 1, issue 1 running → 2 and 3 queue.
    const first = planDrain({ issues, maxConcurrent: 1, activeRuns: [running(1)] });
    expect(first.startable).toEqual([]);
    expect(first.queued).toEqual([2, 3]);

    // Issue 1 finished (done on disk, Run terminal) → slot frees, 2 starts.
    const afterFinish = [mk(1, 'done'), mk(2, 'open'), mk(3, 'open')];
    const second = planDrain({
      issues: afterFinish,
      maxConcurrent: 1,
      activeRuns: [{ issueId: 1, status: 'finished' }],
    });
    expect(second.startable).toEqual([2]);
    expect(second.queued).toEqual([3]);
  });

  it('never restarts an issue that already has a Run (even if terminal)', () => {
    // A stopped Run on issue 2, whose issue is still `open` on disk, must not be
    // silently re-started inside the same drain.
    const issues = [mk(1, 'done'), mk(2, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 5,
      activeRuns: [{ issueId: 2, status: 'stopped' }],
    });
    expect(plan.startable).toEqual([]);
  });

  it('does not count terminal Runs against the slot budget', () => {
    const issues = [mk(1, 'done'), mk(2, 'open'), mk(3, 'open')];
    // A finished Run on 1 frees its slot; cap 2 → both 2 and 3 start.
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 1, status: 'finished' }],
    });
    expect(plan.startable).toEqual([2, 3]);
    expect(plan.queued).toEqual([]);
  });
});

describe('planDrain — a leftover Run from a prior drain never wedges a fresh drain (issue 132)', () => {
  // The reported bug: two `claude` Panes from YESTERDAY's drain lingered alive
  // at their prompt having neither flipped `done` nor written a Receipt, so
  // run-state read them `running` forever. A fresh cap-3 drain over three
  // eligible issues then saw runningCount=2 → freeSlots=1 → started ONE Run and
  // the rest starved, because those phantom slots never freed. A Run explicitly
  // marked `leftover` (carried over from a prior drain generation) must not
  // occupy a slot in — nor halt — the current drain.

  it('does not count a leftover `running` Run against the cap', () => {
    const issues = [mk(101, 'open'), mk(102, 'open'), mk(103, 'open')];
    // Two lingering phantoms (99, 105) from a prior drain, plus 3 fresh eligible.
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [leftover(99), leftover(105)],
    });
    // All three fresh issues start — the phantoms no longer eat the budget.
    expect(plan.startable).toEqual([101, 102, 103]);
    expect(plan.queued).toEqual([]);
  });

  it('starts every fresh issue up to the cap regardless of how many leftovers linger', () => {
    const issues = [mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [leftover(90), leftover(91), leftover(92), leftover(93)],
    });
    expect(plan.startable).toEqual([1, 2]);
  });

  it('a leftover Run whose Pane is still alive (`running`) does not halt the drain', () => {
    const issues = [mk(1, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [leftover(99, 'running')],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.startable).toEqual([1]);
  });

  it('a leftover Run that ended `blocked` (session died) does NOT halt a fresh drain', () => {
    // Before the fix a stale blocked Pane from yesterday would stop today's
    // drain with run-blocked. A leftover blocked Run is not this drain's
    // concern — the drain proceeds.
    const issues = [mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [leftover(99, 'blocked')],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.startable).toEqual([1, 2]);
  });

  it('still excludes a leftover Run\'s OWN issue from re-start (no double-run)', () => {
    // 99 is a leftover whose issue happens to still read `open`; it must never
    // be re-started inside this drain even though it no longer occupies a slot.
    const issues = [mk(99, 'open'), mk(101, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [leftover(99, 'running')],
    });
    expect(plan.startable).toEqual([101]);
    expect(plan.startable).not.toContain(99);
  });

  it('still counts THIS drain\'s own Runs against the cap (leftovers are only prior ones)', () => {
    // A current-drain Run (not marked leftover) occupies its slot exactly as
    // before, so the drain never over-starts its own work.
    const issues = [mk(1, 'wip'), mk(2, 'open'), mk(3, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      // 1 is this drain's running Run; 99 is a prior-drain leftover.
      activeRuns: [running(1), leftover(99)],
    });
    expect(plan.startable).toEqual([2]); // cap 2 − 1 current running = 1 free
    expect(plan.queued).toEqual([3]);
  });

  it('a leftover chained Run does not hold the single integration-branch slot', () => {
    // A prior-drain chained Run left running must not block a fresh chain root
    // from taking the solo slot.
    const issues = [mk(1, 'open'), mk(2, 'open', [1])];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [leftover(80, 'running')],
    });
    expect(plan.startable).toEqual([1]); // 1 is a chain root; it starts solo
  });
});

describe('planDrain — drain-stop conditions', () => {
  it('is live while eligible work remains', () => {
    const issues = [mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 1, activeRuns: [] });
    expect(plan.drain.stop).toBe(false);
    expect(plan.drain.reason).toBeNull();
    expect(plan.drain.message).toBe('');
  });

  it('is live while a Run is in flight even with nothing eligible now', () => {
    // issue 2 is blocked behind the running issue 1; not eligible yet, but the
    // drain must wait for 1 to finish, not stop.
    const issues = [mk(1, 'wip'), mk(2, 'open', [1])];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [running(1)] });
    expect(plan.drain.stop).toBe(false);
  });

  it('stops with no-eligible when nothing runs and nothing is eligible', () => {
    const issues = [mk(1, 'done'), mk(2, 'done')];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
    expect(plan.drain.message).toMatch(/no eligible issue remains/i);
    expect(plan.startable).toEqual([]);
    expect(plan.queued).toEqual([]);
  });

  it('stops with no-eligible when only wip/blocked issues remain and none run', () => {
    // Someone else claimed 1 (wip) and 2 is blocked behind it; with no active
    // Run of our own, there is nothing this drain can start.
    const issues = [mk(1, 'wip'), mk(2, 'open', [1])];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
  });

  it('stops with run-blocked the moment a Run reports blocked', () => {
    const issues = [mk(1, 'wip'), mk(2, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [{ issueId: 1, status: 'blocked' }],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(1);
    expect(plan.drain.message).toMatch(/issue 1.*blocked/i);
  });

  it('opens no new Panes once a Run is blocked, even with eligible work left', () => {
    const issues = [mk(1, 'wip'), mk(2, 'open'), mk(3, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [{ issueId: 1, status: 'blocked' }],
    });
    expect(plan.startable).toEqual([]);
    // The eligible-but-unstarted issues are still reported for the UI to explain.
    expect(plan.queued).toEqual([2, 3]);
  });

  it('prefers run-blocked over no-eligible when both could apply', () => {
    const issues = [mk(1, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 1, status: 'blocked' }],
    });
    expect(plan.drain.reason).toBe('run-blocked');
  });
});

describe('isParkedHitl — the declared-state park/blocked distinction (issue 64)', () => {
  const hitlWip = mk(5, 'wip', [], true);

  it('a Run whose Receipt declares needs-verification is a park', () => {
    const run: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' };
    expect(isParkedHitl(run, hitlWip)).toBe(true);
  });

  it('a declared needs-verification parks even when the issue lacks the HITL marker', () => {
    // The Receipt's declaration is itself declared state — the Worker parked.
    const run: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' };
    expect(isParkedHitl(run, mk(5, 'wip'))).toBe(true);
  });

  it('an HITL-marked issue left wip WITH a Receipt is a park (undeclared-outcome fallback)', () => {
    const run: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: 'unknown' };
    expect(isParkedHitl(run, hitlWip)).toBe(true);
  });

  it('a Run declaring outcome: blocked is NEVER a park, HITL marker or not', () => {
    const run: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: 'blocked' };
    expect(isParkedHitl(run, hitlWip)).toBe(false);
  });

  it('a Run with NO Receipt is never a park — the genuinely-unknown case', () => {
    const bare: ActiveRun = { issueId: 5, status: 'blocked' };
    const explicit: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: null };
    expect(isParkedHitl(bare, hitlWip)).toBe(false);
    expect(isParkedHitl(explicit, hitlWip)).toBe(false);
  });

  it('a non-HITL issue with only an unknown-outcome Receipt is not a park', () => {
    const run: ActiveRun = { issueId: 2, status: 'blocked', receiptOutcome: 'unknown' };
    expect(isParkedHitl(run, mk(2, 'wip'))).toBe(false);
  });

  it('the HITL fallback requires the issue to have ended wip', () => {
    const run: ActiveRun = { issueId: 5, status: 'blocked', receiptOutcome: 'unknown' };
    expect(isParkedHitl(run, mk(5, 'open', [], true))).toBe(false);
  });

  it('only a blocked-status Run can be a park', () => {
    const run: ActiveRun = { issueId: 5, status: 'running', receiptOutcome: 'needs-verification' };
    expect(isParkedHitl(run, hitlWip)).toBe(false);
  });

  it('an unknown issue (not in the backlog) never parks via the fallback', () => {
    const run: ActiveRun = { issueId: 99, status: 'blocked', receiptOutcome: 'unknown' };
    expect(isParkedHitl(run, undefined)).toBe(false);
  });

  it('a Run already derived `parked` (issue 65) is a park, whatever else is known', () => {
    // run-state now derives `parked` directly from the declared Receipt while
    // the session lingers — that status IS the park, no re-derivation here.
    const run: ActiveRun = { issueId: 5, status: 'parked', receiptOutcome: 'needs-verification' };
    expect(isParkedHitl(run, hitlWip)).toBe(true);
    expect(isParkedHitl({ status: 'parked' }, undefined)).toBe(true);
  });
});

describe('planDrain — a terminal `parked` Run (issue 65) frees its slot and never halts', () => {
  it('continues past a parked Run at cap 1 — the lingering-Pane stall this fixes', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open'), mk(7, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 1,
      activeRuns: [{ issueId: 5, status: 'parked', receiptOutcome: 'needs-verification' }],
    });
    expect(plan.drain.stop).toBe(false);
    // The park freed the ONLY slot: 6 starts immediately, 7 queues.
    expect(plan.startable).toEqual([6]);
    expect(plan.queued).toEqual([7]);
  });

  it('stops with no-eligible (not run-blocked) when only the parked Run remains', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 1,
      activeRuns: [
        { issueId: 5, status: 'parked', receiptOutcome: 'needs-verification' },
        { issueId: 6, status: 'finished', receiptOutcome: 'completed' },
      ],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
  });
});

describe('planDrain — a parked HITL Run does not halt the drain (issue 64)', () => {
  it('continues scheduling eligible issues past a parked HITL Run', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open'), mk(7, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 1,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' }],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.startable).toEqual([6]);
    expect(plan.queued).toEqual([7]);
  });

  it('a parked Run frees its slot (it is not running)', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open'), mk(7, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' }],
    });
    expect(plan.startable).toEqual([6, 7]);
  });

  it('never restarts the parked issue within the same drain', () => {
    // Even if the parked issue somehow read `open` again, its Run is tracked.
    const issues = [mk(5, 'open', [], true), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' }],
    });
    expect(plan.startable).toEqual([6]);
  });

  it('issues depending on the parked issue stay blocked naturally', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open', [5]), mk(7, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' }],
    });
    expect(plan.startable).toEqual([7]);
    expect(plan.queued).toEqual([]);
  });

  it('stops with no-eligible (not run-blocked) when only the park remains', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [
        { issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' },
        { issueId: 6, status: 'finished', receiptOutcome: 'completed' },
      ],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
  });

  it('still stops with run-blocked for a Run declaring outcome: blocked', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'blocked' }],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(5);
  });

  it('still stops with run-blocked when a Run ends with no Receipt and no done flip', () => {
    const issues = [mk(5, 'wip', [], true), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 5, status: 'blocked' }],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
  });

  it('halts on the genuinely blocked Run even when another Run is parked', () => {
    const issues = [mk(4, 'wip'), mk(5, 'wip', [], true), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [
        { issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' },
        { issueId: 4, status: 'blocked', receiptOutcome: 'blocked' },
      ],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(4);
  });
});

describe('planDrain — refuses to start on a mid-merge main (issue 24)', () => {
  it('stops with a mid-merge reason and opens no Panes', () => {
    const issues = [mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [], midMerge: true });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('mid-merge');
    expect(plan.startable).toEqual([]);
    expect(plan.drain.message).toMatch(/mid-merge/i);
  });

  it('prefers mid-merge over run-blocked and no-eligible', () => {
    const issues = [mk(1, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 9, status: 'blocked' }],
      midMerge: true,
    });
    expect(plan.drain.reason).toBe('mid-merge');
  });

  it('drains normally when midMerge is false/absent', () => {
    const issues = [mk(1, 'open'), mk(2, 'open')];
    expect(planDrain({ issues, maxConcurrent: 2, activeRuns: [], midMerge: false }).startable).toEqual([1, 2]);
    expect(planDrain({ issues, maxConcurrent: 2, activeRuns: [] }).startable).toEqual([1, 2]);
  });
});

describe('soloChainedIssueIds — dependency chains must stay solo (issue 111)', () => {
  it('marks BOTH endpoints of an edge between two not-done issues', () => {
    // 3 depends_on 2, both open: the dependency (2) must land its work on the
    // integration branch (solo) and the dependent (3) must build on it (solo).
    const solo = soloChainedIssueIds([mk(1, 'done'), mk(2, 'open'), mk(3, 'open', [2])]);
    expect([...solo].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('ignores edges to an already-done dependency — the foundation case', () => {
    // Everything depends_on the finished foundation issue 1; its work is already
    // on the integration branch, so no dependent is forced solo. This is what
    // keeps genuine independents parallelizing (issue 111 out-of-scope note).
    const solo = soloChainedIssueIds([
      mk(1, 'done'),
      mk(2, 'open', [1]),
      mk(3, 'open', [1]),
    ]);
    expect(solo.size).toBe(0);
  });

  it('does not mark two genuinely independent issues', () => {
    const solo = soloChainedIssueIds([mk(6, 'open'), mk(7, 'open')]);
    expect(solo.size).toBe(0);
  });

  it('marks a chain whose dependency is still wip (active in the drain)', () => {
    const solo = soloChainedIssueIds([mk(2, 'wip'), mk(3, 'open', [2])]);
    expect([...solo].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('marks a transitive chain across three not-done issues', () => {
    const solo = soloChainedIssueIds([
      mk(2, 'open'),
      mk(3, 'open', [2]),
      mk(4, 'open', [3]),
    ]);
    expect([...solo].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  // --- HITL-aggregator edges are exempt (issue 135) --------------------------

  it('does not solo-chain a batch behind an HITL aggregator that depends_on every issue (issue 135)', () => {
    // The /to-issues batch shape: 2, 3, 4 mutually independent; 9 is the HITL
    // batch-QA walkthrough that `depends_on` all of them and stays not-done for
    // the whole drain. Its edges are eligibility-only (never claim the
    // walkthrough early), not build edges — so none of 2/3/4 is forced solo and
    // they parallelize up to the cap.
    const solo = soloChainedIssueIds([
      mk(2, 'open'),
      mk(3, 'open'),
      mk(4, 'open'),
      mk(9, 'open', [2, 3, 4], true), // hitl aggregator
    ]);
    expect(solo.size).toBe(0);
  });

  it('does not solo-chain the HITL aggregator itself via its own edges (issue 135)', () => {
    // The exempt endpoint includes the aggregator: its edge into a not-done batch
    // issue marks neither the dependency NOR the aggregator solo.
    const solo = soloChainedIssueIds([mk(2, 'open'), mk(9, 'open', [2], true)]);
    expect(solo.size).toBe(0);
  });

  it('still solo-chains a genuine build chain even when an HITL aggregator also depends on both (issue 135)', () => {
    // 3 depends_on 2 (a real build edge, neither HITL) AND the HITL aggregator 9
    // depends_on both. The aggregator's edges are exempt, but the 3→2 build edge
    // still forces both endpoints solo, exactly as before.
    const solo = soloChainedIssueIds([
      mk(2, 'open'),
      mk(3, 'open', [2]),
      mk(9, 'open', [2, 3], true),
    ]);
    expect([...solo].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('a non-HITL dependent of an HITL issue is NOT exempt — only the dependent-is-HITL edge is (issue 135)', () => {
    // The exemption keys on the DEPENDENT being HITL, not the dependency. If a
    // non-HITL issue 3 genuinely `depends_on` an HITL issue 2 (both not-done),
    // that edge is a real dependent→dependency edge and still solo-chains both.
    const solo = soloChainedIssueIds([mk(2, 'open', [], true), mk(3, 'open', [2])]);
    expect([...solo].sort((a, b) => a - b)).toEqual([2, 3]);
  });
});

describe('planDrain — chained Runs serialize on the integration branch (issue 111)', () => {
  it('starts only ONE of two independent chain roots at a time, though both are eligible', () => {
    // Two independent chains: 1→2 and 3→4. Roots 1 and 3 are both eligible, but
    // each is solo (a not-done dependent hangs off it), so they'd collide on the
    // integration branch — only the lower id starts; the other queues, even
    // though the cap has room. The independent-parallel model is untouched.
    const issues = [
      mk(1, 'open'),
      mk(2, 'open', [1]),
      mk(3, 'open'),
      mk(4, 'open', [3]),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([1]);
    expect(plan.queued).toEqual([3]); // 2 and 4 are dep-blocked, not eligible yet
  });

  it('still starts an independent Run alongside a chain root — independence parallelizes', () => {
    // 1 is a chain root (2 depends on it → solo); 5 is independent. Both start:
    // the solo Run takes the integration-branch slot, the independent Run gets
    // its own worktree. No regression to genuine concurrency.
    const issues = [mk(1, 'open'), mk(2, 'open', [1]), mk(5, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([1, 5]);
    expect(plan.queued).toEqual([]);
  });

  it('holds a chain root while a solo-chained Run is already running', () => {
    // 1→2 is running solo (1 wip, running). 3→4 is another chain whose root 3 is
    // eligible — but the single integration-branch slot is taken, so 3 waits.
    const issues = [
      mk(1, 'wip'),
      mk(2, 'open', [1]),
      mk(3, 'open'),
      mk(4, 'open', [3]),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [running(1)] });
    expect(plan.startable).toEqual([]);
    expect(plan.queued).toEqual([3]);
  });

  it('does not constrain purely independent Runs (no chains → unchanged behavior)', () => {
    const issues = [mk(1, 'open'), mk(2, 'open'), mk(3, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toEqual([1, 2]);
    expect(plan.queued).toEqual([3]);
  });

  it('fills the cap with all independent batch issues under an HITL aggregator (issue 135)', () => {
    // The redesign-batch regression: N mutually-independent issues plus an HITL
    // batch-QA walkthrough (9) that `depends_on` all of them. Pre-135 the
    // aggregator's edges solo-chained the whole batch and the drain started ONE
    // at a time; now all N fan out up to the cap while the aggregator stays
    // ineligible (its deps aren't done, so it never appears as startable).
    const issues = [
      mk(2, 'open'),
      mk(3, 'open'),
      mk(4, 'open'),
      mk(9, 'open', [2, 3, 4], true),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([2, 3, 4]);
    expect(plan.queued).toEqual([]);
  });
});

describe('planDrain — determinism', () => {
  it('is idempotent: re-planning identical input yields an identical plan', () => {
    const issues = [mk(1, 'open'), mk(2, 'open'), mk(3, 'open')];
    const input = { issues, maxConcurrent: 2, activeRuns: [] as ActiveRun[] };
    expect(planDrain(input)).toEqual(planDrain(input));
  });
});

describe('drainAvailability — the Drain control is honest about the backlog (issue 90)', () => {
  it('is unavailable with "no issues" on an empty backlog', () => {
    expect(drainAvailability([])).toEqual({ available: false, reason: 'no issues' });
  });

  it('is available when an issue is startable right now', () => {
    const gate = drainAvailability([mk(1, 'open')]);
    expect(gate.available).toBe(true);
    expect(gate.reason).toBeNull();
  });

  it('is available when an issue is not startable now but the drain can unblock it', () => {
    // 2 is blocked behind 1, but the drain itself will run 1 — a chain the
    // drain can drain is available work.
    const gate = drainAvailability([mk(1, 'open'), mk(2, 'open', [1])]);
    expect(gate.available).toBe(true);
  });

  it('is unavailable with "all issues done" when every issue is done', () => {
    const gate = drainAvailability([mk(1, 'done'), mk(2, 'done')]);
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — all issues done',
    });
  });

  it('is unavailable and counts wip + blocked when everything is parked or stuck', () => {
    // 1 and 2 are wip (awaiting the human — e.g. parked HITL or claimed
    // elsewhere); 3 is open but blocked behind 1 and no live Run will land it.
    const gate = drainAvailability([mk(1, 'wip'), mk(2, 'wip'), mk(3, 'open', [1])]);
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — 2 wip awaiting you, 1 blocked',
    });
  });

  it('treats an open issue with a missing dependency as blocked, not startable', () => {
    const gate = drainAvailability([mk(1, 'open', [99])]);
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — 1 blocked',
    });
  });

  it('treats a dependency cycle as blocked, never available', () => {
    const gate = drainAvailability([mk(1, 'open', [2]), mk(2, 'open', [1])]);
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — 2 blocked',
    });
  });

  it('is available when a LIVE Run on a wip dependency will unblock an open issue', () => {
    // 1 is wip with a live Run (a manual Run in flight): its coming `done`
    // flip unblocks 2, so a drain started now has real work ahead.
    const gate = drainAvailability([mk(1, 'wip'), mk(2, 'open', [1])], [1]);
    expect(gate.available).toBe(true);
  });

  it('counts a live Run as running (not "awaiting you") when it unblocks nothing', () => {
    // The live Run on 1 will finish on its own; the drain would start nothing.
    const gate = drainAvailability([mk(1, 'wip')], [1]);
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — 1 running',
    });
  });

  it('mixes the reason parts and omits zero counts', () => {
    const gate = drainAvailability(
      [mk(1, 'wip'), mk(2, 'wip'), mk(3, 'open', [2]), mk(4, 'done')],
      [1],
    );
    expect(gate).toEqual({
      available: false,
      reason: 'nothing eligible — 1 wip awaiting you, 1 running, 1 blocked',
    });
  });
});

describe('planDrain — the race path when eligibility vanished before the click landed', () => {
  it('stops immediately with the normal no-eligible fact on an empty backlog', () => {
    const plan = planDrain({ issues: [], maxConcurrent: 2, activeRuns: [] });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
    expect(plan.drain.message).toMatch(/no eligible issue remains/i);
    expect(plan.startable).toEqual([]);
  });
});
