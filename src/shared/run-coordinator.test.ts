import { describe, it, expect } from 'vitest';
import { planDrain, normalizeCap, type ActiveRun } from './run-coordinator';
import type { BacklogIssue, IssueStatus } from './backlog-model';

/** Minimal issue factory — only the fields the coordinator/eligibility read. */
function mk(id: number, status: IssueStatus, dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

const running = (id: number): ActiveRun => ({ issueId: id, status: 'running' });

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

describe('planDrain — determinism', () => {
  it('is idempotent: re-planning identical input yields an identical plan', () => {
    const issues = [mk(1, 'open'), mk(2, 'open'), mk(3, 'open')];
    const input = { issues, maxConcurrent: 2, activeRuns: [] as ActiveRun[] };
    expect(planDrain(input)).toEqual(planDrain(input));
  });
});
