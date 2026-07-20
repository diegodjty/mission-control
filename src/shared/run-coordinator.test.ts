import { describe, it, expect } from 'vitest';
import {
  planDrain,
  normalizeCap,
  isParkedHitl,
  isBlockedPark,
  drainAvailability,
  waitingOnMergeIssues,
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
  footprint: { touches?: string[]; body?: string } = {},
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
    runTimeoutMinutes: null,
    touches: footprint.touches ?? [],
    inBatch: true,
    standalone: false,
    body: footprint.body ?? '',
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

  it('a Run declaring outcome: blocked PARKS — it no longer halts (issue 137)', () => {
    // Pre-137 this stopped the drain with run-blocked; now a declared-blocked
    // Run parks (its dependents stay excluded via eligibility) and the drain
    // keeps scheduling, exactly as it already does for a parked HITL Run.
    const issues = [mk(5, 'wip'), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 5, status: 'blocked', receiptOutcome: 'blocked' }],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.drain.reason).toBeNull();
    expect(plan.drain.blockedParkedIssueIds).toEqual([5]);
    expect(plan.startable).toEqual([6]);
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

  it('halts on a genuinely blocked (no-Receipt) Run even alongside parks (issue 137)', () => {
    // Both a parked HITL Run (05) and a declared-blocked park (04) are skipped;
    // only the no-Receipt Run (03) — genuinely-unknown state — halts the drain.
    const issues = [mk(3, 'wip'), mk(4, 'wip'), mk(5, 'wip', [], true), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [
        { issueId: 5, status: 'blocked', receiptOutcome: 'needs-verification' }, // HITL park
        { issueId: 4, status: 'blocked', receiptOutcome: 'blocked' }, // declared-blocked park
        { issueId: 3, status: 'blocked' }, // no Receipt → genuine halt
      ],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(3);
    // The declared-blocked park is still reported so the human sees it.
    expect(plan.drain.blockedParkedIssueIds).toEqual([4]);
  });
});

describe('isBlockedPark — declared-blocked parks vs the genuinely-unknown halt (issue 137)', () => {
  it('a non-leftover blocked Run whose Receipt declares blocked is a park', () => {
    expect(isBlockedPark({ status: 'blocked', receiptOutcome: 'blocked' })).toBe(true);
  });

  it('a blocked Run with NO Receipt is NOT a park — the conservative halt stands', () => {
    expect(isBlockedPark({ status: 'blocked' })).toBe(false);
    expect(isBlockedPark({ status: 'blocked', receiptOutcome: null })).toBe(false);
  });

  it('a park needs the blocked status: a needs-verification/unknown Receipt is not a blocked park', () => {
    expect(isBlockedPark({ status: 'blocked', receiptOutcome: 'needs-verification' })).toBe(false);
    expect(isBlockedPark({ status: 'blocked', receiptOutcome: 'unknown' })).toBe(false);
    expect(isBlockedPark({ status: 'running', receiptOutcome: 'blocked' })).toBe(false);
  });

  it('a LEFTOVER declared-blocked Run is not THIS drain\'s park (issue 132)', () => {
    expect(isBlockedPark({ status: 'blocked', receiptOutcome: 'blocked', leftover: true })).toBe(false);
  });
});

describe('planDrain — a declared-blocked Run parks and the drain continues (issue 137)', () => {
  it('does not stop; excludes the blocked issue + its transitive dependents; fills free slots with unrelated work', () => {
    // 03 declared blocked. 04 depends_on 03, 07 depends_on 04 — both transitive
    // dependents stay excluded (their dependency never reached `done`). 05 and 06
    // are unrelated and eligible; both fill the free slots on THIS tick.
    const issues = [
      mk(3, 'wip'),
      mk(4, 'open', [3]),
      mk(7, 'open', [4]),
      mk(5, 'open'),
      mk(6, 'open'),
    ];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [{ issueId: 3, status: 'blocked', receiptOutcome: 'blocked' }],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.drain.reason).toBeNull();
    expect(plan.drain.blockedParkedIssueIds).toEqual([3]);
    // Unrelated eligible issues fill the slots; the dependents never appear.
    expect(plan.startable).toEqual([5, 6]);
    expect(plan.startable).not.toContain(4);
    expect(plan.startable).not.toContain(7);
    // The blocked issue is never re-started within the drain (it has a Run).
    expect(plan.startable).not.toContain(3);
  });

  it('never restarts the blocked-parked issue within the same drain', () => {
    // Even if the blocked issue somehow read `open`, its Run is tracked.
    const issues = [mk(3, 'open'), mk(6, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [{ issueId: 3, status: 'blocked', receiptOutcome: 'blocked' }],
    });
    expect(plan.startable).toEqual([6]);
  });

  it('a blocked park frees its slot (it is not running)', () => {
    const issues = [mk(3, 'wip'), mk(6, 'open'), mk(7, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 3, status: 'blocked', receiptOutcome: 'blocked' }],
    });
    // cap 2, the park occupies no slot → both remaining eligible issues start.
    expect(plan.startable).toEqual([6, 7]);
  });

  it('ends no-eligible (not run-blocked) and the stop message reports "N blocked awaiting you"', () => {
    // Only the blocked park remains — nothing running, nothing eligible: the
    // drain FINISHED, it did not halt. The message names who is awaiting you.
    const issues = [mk(3, 'wip'), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [
        { issueId: 3, status: 'blocked', receiptOutcome: 'blocked' },
        { issueId: 6, status: 'finished', receiptOutcome: 'completed' },
      ],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
    expect(plan.drain.blockedParkedIssueIds).toEqual([3]);
    expect(plan.drain.message).toMatch(/no eligible issue remains/i);
    expect(plan.drain.message).toMatch(/1 blocked awaiting you \(issue 3\)/i);
  });

  it('lists multiple blocked parks by id, ascending, in the stop message', () => {
    const issues = [mk(3, 'wip'), mk(8, 'wip'), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 3,
      activeRuns: [
        { issueId: 8, status: 'blocked', receiptOutcome: 'blocked' },
        { issueId: 3, status: 'blocked', receiptOutcome: 'blocked' },
      ],
    });
    expect(plan.drain.reason).toBe('no-eligible');
    expect(plan.drain.blockedParkedIssueIds).toEqual([3, 8]);
    expect(plan.drain.message).toMatch(/2 blocked awaiting you \(issues 3, 8\)/i);
  });

  it('a clean no-eligible stop (no blocked parks) reads exactly as before', () => {
    const issues = [mk(1, 'done'), mk(2, 'done')];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.drain.blockedParkedIssueIds).toEqual([]);
    expect(plan.drain.message).toBe('Stopped: no eligible issue remains.');
  });

  it('names a pending timeout-salvage strand distinctly from "blocked awaiting you" (issue 170)', () => {
    // Issue 9 timed out (its Run killed, worktree stranded) — no Receipt, so it
    // stays `wip` with NO tracked active Run at all in this drain's view.
    const issues = [mk(9, 'wip'), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [],
      timeoutSalvageIssueIds: [9],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('no-eligible');
    expect(plan.drain.message).toMatch(/no eligible issue remains/i);
    expect(plan.drain.message).toMatch(/1 timed out awaiting salvage \(issue 9\)/i);
    expect(plan.drain.message).not.toMatch(/blocked awaiting you/i);
  });

  it('lists multiple timeout-salvage strands by id, ascending, deduped', () => {
    const issues = [mk(9, 'wip'), mk(11, 'wip'), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [],
      timeoutSalvageIssueIds: [11, 9, 9],
    });
    expect(plan.drain.message).toMatch(/2 timed out awaiting salvage \(issues 9, 11\)/i);
  });

  it('combines a blocked park AND a timeout-salvage strand, each named separately', () => {
    const issues = [mk(3, 'wip'), mk(9, 'wip'), mk(6, 'done')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 3, status: 'blocked', receiptOutcome: 'blocked' }],
      timeoutSalvageIssueIds: [9],
    });
    expect(plan.drain.message).toMatch(/1 blocked awaiting you \(issue 3\)/i);
    expect(plan.drain.message).toMatch(/1 timed out awaiting salvage \(issue 9\)/i);
  });

  it('a LEFTOVER declared-blocked Run neither halts nor is reported as this drain\'s park', () => {
    // A prior-drain Run that declared blocked (Receipt and all) is not THIS
    // drain's concern: it neither halts nor swells the "awaiting you" list.
    const issues = [mk(1, 'open'), mk(2, 'open')];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [{ issueId: 99, status: 'blocked', receiptOutcome: 'blocked', leftover: true }],
    });
    expect(plan.drain.stop).toBe(false);
    expect(plan.drain.blockedParkedIssueIds).toEqual([]);
    expect(plan.startable).toEqual([1, 2]);
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

describe('planDrain — the integrated start condition (issue 147, ADR-0021)', () => {
  it('starts a dependent once its dependency is done AND integrated (no finished-unmerged branch)', () => {
    const issues = [mk(1, 'done'), mk(2, 'open', [1])];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toEqual([2]);
    expect(plan.waitingOnMerge).toEqual([]);
  });

  it('holds a dependent whose dependency is done but still finished-unmerged — never a start from stale main', () => {
    const issues = [mk(1, 'done'), mk(2, 'open', [1])];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [],
      finishedUnmergedIds: [1],
    });
    expect(plan.startable).toEqual([]);
    expect(plan.queued).toEqual([]); // not eligible at all, not merely queued past the cap
    expect(plan.waitingOnMerge).toEqual([{ issueId: 2, mergeIssueId: 1 }]);
  });

  it('clears the wait the moment the lane lands the dependency (finishedUnmergedIds empties)', () => {
    const issues = [mk(1, 'done'), mk(2, 'open', [1])];
    const held = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [],
      finishedUnmergedIds: [1],
    });
    expect(held.waitingOnMerge).toEqual([{ issueId: 2, mergeIssueId: 1 }]);

    const landed = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(landed.startable).toEqual([2]);
    expect(landed.waitingOnMerge).toEqual([]);
  });

  it('never reports a genuinely not-done dependency as a merge wait', () => {
    // 2 depends on 1, which is still `open` — a real block, not a pending merge,
    // even though 1 also happens to be in `finishedUnmergedIds` (defensive: an
    // unmerged branch behind an issue whose frontmatter never flipped done).
    const issues = [mk(1, 'open'), mk(2, 'open', [1])];
    const plan = planDrain({
      issues,
      maxConcurrent: 2,
      activeRuns: [],
      finishedUnmergedIds: [1],
    });
    expect(plan.waitingOnMerge).toEqual([]);
  });

  it('every eligible issue starts in its own worktree like any other — no single-slot cap beyond maxConcurrent', () => {
    // Two independent chains, 1→2 and 3→4: pre-147 this used to solo-chain both
    // roots onto a single integration-branch slot. Now both roots start freely
    // up to the cap; 2 and 4 are still dep-blocked (1 and 3 aren't done yet).
    const issues = [mk(1, 'open'), mk(2, 'open', [1]), mk(3, 'open'), mk(4, 'open', [3])];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([1, 3]);
    expect(plan.queued).toEqual([]);
  });

  it('fills the cap with all independent batch issues under an HITL aggregator — no regression to issue 135', () => {
    // The redesign-batch regression this issue must not reintroduce: N mutually-
    // independent issues plus an HITL batch-QA walkthrough (9) depends_on all of
    // them. With solo-chaining retired outright, all N simply fan out up to the
    // cap (the aggregator was never solo-chain-exempt code path dependent — it's
    // just ineligible, deps not done).
    const issues = [mk(2, 'open'), mk(3, 'open'), mk(4, 'open'), mk(9, 'open', [2, 3, 4], true)];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([2, 3, 4]);
    expect(plan.queued).toEqual([]);
  });

  it('a lone eligible issue still plans as startable (solo survives only as ADR-0002 lone-Run placement, decided outside the coordinator)', () => {
    const issues = [mk(1, 'open')];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([1]);
  });
});

describe('waitingOnMergeIssues (issue 147)', () => {
  it('is empty with no finished-unmerged branches', () => {
    expect(waitingOnMergeIssues([mk(1, 'done'), mk(2, 'open', [1])], [])).toEqual([]);
  });

  it('reports the dependent held only by an unmerged dependency', () => {
    const issues = [mk(1, 'done'), mk(2, 'open', [1])];
    expect(waitingOnMergeIssues(issues, [1])).toEqual([{ issueId: 2, mergeIssueId: 1 }]);
  });

  it('reports the LOWEST unmerged dependency id when multiple block the same dependent', () => {
    const issues = [mk(1, 'done'), mk(3, 'done'), mk(2, 'open', [3, 1])];
    expect(waitingOnMergeIssues(issues, [1, 3])).toEqual([{ issueId: 2, mergeIssueId: 1 }]);
  });

  it('excludes an issue with a genuinely not-done dependency — that is a block, not a merge wait', () => {
    const issues = [mk(1, 'open'), mk(2, 'open', [1])];
    expect(waitingOnMergeIssues(issues, [1])).toEqual([]);
  });

  it('excludes wip/done issues — the wait only applies to a not-yet-started open issue', () => {
    const issues = [mk(1, 'done'), mk(2, 'wip', [1]), mk(3, 'done', [1])];
    expect(waitingOnMergeIssues(issues, [1])).toEqual([]);
  });

  it('sorts by ascending dependent issue id', () => {
    const issues = [mk(1, 'done'), mk(5, 'open', [1]), mk(2, 'open', [1])];
    expect(waitingOnMergeIssues(issues, [1]).map((w) => w.issueId)).toEqual([2, 5]);
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

describe('planDrain — overlap-aware scheduling (issue 171)', () => {
  const HOT = 'src/renderer/src/App.tsx';

  it('serializes two issues whose declared `touches` collide, and fans out a disjoint one up to the cap', () => {
    // 1 and 2 both declare the same hot file; 3 is genuinely disjoint.
    const issues = [
      mk(1, 'open', [], false, { touches: [HOT] }),
      mk(2, 'open', [], false, { touches: [HOT] }),
      mk(3, 'open', [], false, { touches: ['src/shared/unrelated.ts'] }),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [], hotFiles: [] });

    // Only one of the overlapping pair starts; the disjoint issue also starts.
    expect(plan.startable).toEqual([1, 3]);
    expect(plan.queued).toEqual([2]);
    expect(plan.overlapNotices).toEqual([{ issueId: 2, blockingIssueId: 1, path: HOT }]);
  });

  it('a CONFIG `hot_files` entry serializes issues whose bodies mention it; issues that don\'t mention it still fan out', () => {
    const issues = [
      mk(1, 'open', [], false, { body: `Rewires a route in ${HOT}.` }),
      mk(2, 'open', [], false, { body: `Also touches ${HOT} for the new tab.` }),
      mk(3, 'open', [], false, { body: 'Touches only a backend module, unrelated.' }),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [], hotFiles: [HOT] });

    expect(plan.startable).toEqual([1, 3]);
    expect(plan.queued).toEqual([2]);
    expect(plan.overlapNotices).toEqual([{ issueId: 2, blockingIssueId: 1, path: HOT }]);
  });

  it('never co-schedules a new start with a Run already occupying a slot on the same footprint', () => {
    const issues = [
      mk(1, 'open', [], false, { touches: [HOT] }), // already running
      mk(2, 'open', [], false, { touches: [HOT] }), // must wait for 1
      mk(3, 'open', [], false, { touches: ['src/shared/unrelated.ts'] }),
    ];
    const activeRuns: ActiveRun[] = [{ issueId: 1, status: 'running' }];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns, hotFiles: [] });

    expect(plan.startable).toEqual([3]);
    expect(plan.queued).toEqual([2]);
    expect(plan.overlapNotices).toEqual([{ issueId: 2, blockingIssueId: 1, path: HOT }]);
  });

  it('a leftover Run never forces overlap serialization on a fresh drain (issue 132 precedent)', () => {
    // Issue 1 already has a (leftover) tracked Run, so it's off the eligible
    // table regardless (same as any tracked Run); the point here is that its
    // footprint does NOT get seeded into `committed` and so does not hold
    // back issue 2, which starts freely.
    const issues = [
      mk(1, 'open', [], false, { touches: [HOT] }),
      mk(2, 'open', [], false, { touches: [HOT] }),
    ];
    const activeRuns: ActiveRun[] = [leftover(1)];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns, hotFiles: [] });

    expect(plan.startable).toEqual([2]);
    expect(plan.overlapNotices).toEqual([]);
  });

  it('reports no overlap notices and fans out fully when every eligible issue is disjoint', () => {
    const issues = [
      mk(1, 'open', [], false, { touches: ['src/a.ts'] }),
      mk(2, 'open', [], false, { touches: ['src/b.ts'] }),
      mk(3, 'open', [], false, { touches: ['src/c.ts'] }),
    ];
    const plan = planDrain({ issues, maxConcurrent: 3, activeRuns: [], hotFiles: [] });
    expect(plan.startable).toEqual([1, 2, 3]);
    expect(plan.overlapNotices).toEqual([]);
  });

  it('defaults to no overlap serialization when `hotFiles` is omitted (legacy/test callers)', () => {
    const issues = [
      mk(1, 'open', [], false, { body: `mentions ${HOT} but no hot_files configured` }),
      mk(2, 'open', [], false, { body: `also mentions ${HOT}` }),
    ];
    const plan = planDrain({ issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toEqual([1, 2]);
    expect(plan.overlapNotices).toEqual([]);
  });
});
