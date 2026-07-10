import { describe, expect, it } from 'vitest';
import {
  describeAction,
  isActionable,
  isAutonomous,
  isProposal,
  partitionActivities,
  recordActivity,
  resolveActivity,
  type DispatcherActivity,
} from './dispatcher-proposal';
import type { DispatcherAction } from './dispatcher-authority';

const ALL_ACTIONS: DispatcherAction[] = [
  'commit-checkpoint',
  'start-next',
  'synthesize',
  'relay',
  'log-issue',
  'merge',
  'abort-drain',
  'discard-and-continue',
  'amend-plan',
  'course-change',
  'merge-preflight',
  'receipt-adopt',
  'merge-conflict',
  'hitl-signoff',
  'protected-branch-land',
];

// ADR-0011 (as amended by issue 113): the entire blocking list; everything else
// is non-blocking.
const BLOCKING_ACTIONS: DispatcherAction[] = [
  'merge-conflict',
  'abort-drain',
  'hitl-signoff',
  'protected-branch-land',
];
const NON_BLOCKING_ACTIONS: DispatcherAction[] = [
  'commit-checkpoint',
  'start-next',
  'synthesize',
  'relay',
  'log-issue',
  'merge',
  'discard-and-continue',
  'amend-plan',
  'course-change',
  'merge-preflight',
  'receipt-adopt',
];

describe('describeAction', () => {
  it('gives every action a non-empty plain-language label', () => {
    for (const action of ALL_ACTIONS) {
      expect(describeAction(action)).toBeTruthy();
    }
  });
});

describe('recordActivity', () => {
  it('records a non-blocking action as already taken (autonomous, no gate)', () => {
    for (const action of NON_BLOCKING_ACTIONS) {
      const a = recordActivity(`x:${action}`, action);
      expect(a.authority).not.toBe('blocking');
      expect(a.status).toBe('taken');
      expect(isAutonomous(a)).toBe(true);
      expect(isProposal(a)).toBe(false);
      // A taken autonomous action is not awaiting a click.
      expect(isActionable(a)).toBe(false);
    }
  });

  it('records only a blocking action as a pending proposal (ADR-0011 list, 4 items as of issue 113)', () => {
    for (const action of BLOCKING_ACTIONS) {
      const a = recordActivity(`x:${action}`, action);
      expect(a.authority).toBe('blocking');
      expect(a.status).toBe('pending');
      expect(isProposal(a)).toBe(true);
      expect(isAutonomous(a)).toBe(false);
      // A pending proposal shows approve/reject.
      expect(isActionable(a)).toBe(true);
    }
  });

  it('records a CLEAN merge as taken, never a gate (ADR-0011 refines ADR-0002)', () => {
    const a = recordActivity('merge:1', 'merge');
    expect(a.status).toBe('taken');
    expect(a.authority).toBe('passive');
  });

  it('records a conflicting merge as a pending proposal (the one merge that blocks)', () => {
    const a = recordActivity('merge-conflict:1', 'merge-conflict');
    expect(a.status).toBe('pending');
    expect(a.authority).toBe('blocking');
  });

  it('carries the id and label through', () => {
    const a = recordActivity('merge-conflict:42', 'merge-conflict');
    expect(a.id).toBe('merge-conflict:42');
    expect(a.label).toBe(describeAction('merge-conflict'));
  });
});

describe('resolveActivity', () => {
  it('approving a pending proposal marks it approved (caller then executes)', () => {
    const pending = recordActivity('merge-conflict:1', 'merge-conflict');
    const approved = resolveActivity(pending, 'approved');
    expect(approved.status).toBe('approved');
    // Immutable transition — the original is untouched.
    expect(pending.status).toBe('pending');
  });

  it('rejecting a pending proposal marks it rejected (dropped, nothing runs)', () => {
    const pending = recordActivity('abort-drain:1', 'abort-drain');
    const rejected = resolveActivity(pending, 'rejected');
    expect(rejected.status).toBe('rejected');
  });

  it('is a no-op on an autonomous (taken) action — it was never up for a vote', () => {
    const taken = recordActivity('start:1', 'start-next');
    expect(resolveActivity(taken, 'approved')).toEqual(taken);
    expect(resolveActivity(taken, 'rejected')).toEqual(taken);
  });

  it('is a no-op on a passive (taken) note — a clean merge never gates', () => {
    const taken = recordActivity('merge:1', 'merge');
    expect(resolveActivity(taken, 'approved')).toEqual(taken);
    expect(resolveActivity(taken, 'rejected')).toEqual(taken);
  });

  it('is idempotent — an already-resolved proposal cannot be re-flipped or re-fired', () => {
    const pending = recordActivity('merge-conflict:1', 'merge-conflict');
    const approved = resolveActivity(pending, 'approved');
    // A second click (or a re-render) must not flip approved → rejected.
    expect(resolveActivity(approved, 'rejected')).toEqual(approved);
    const rejected = resolveActivity(recordActivity('merge-conflict:2', 'merge-conflict'), 'rejected');
    expect(resolveActivity(rejected, 'approved')).toEqual(rejected);
  });

  it('a resolved proposal is no longer actionable', () => {
    const pending = recordActivity('merge-conflict:1', 'merge-conflict');
    expect(isActionable(resolveActivity(pending, 'approved'))).toBe(false);
    expect(isActionable(resolveActivity(pending, 'rejected'))).toBe(false);
  });
});

describe('autonomous vs proposed partition', () => {
  it('every activity is exactly one of autonomous or proposal', () => {
    for (const action of ALL_ACTIONS) {
      const a: DispatcherActivity = recordActivity(`x:${action}`, action);
      expect(isAutonomous(a)).toBe(!isProposal(a));
    }
  });
});

describe('partitionActivities (pending vs resolved for display)', () => {
  it('puts pending proposals in `pending` and everything else in `resolved`', () => {
    const acts: DispatcherActivity[] = [
      recordActivity('synth:1', 'synthesize'), // silent → taken → resolved
      recordActivity('mc:1', 'merge-conflict'), // pending
      resolveActivity(recordActivity('mc:2', 'merge-conflict'), 'approved'), // approved → resolved
      recordActivity('abort:1', 'abort-drain'), // pending
      recordActivity('clean-merge:1', 'merge'), // passive → taken → resolved (no gate)
      resolveActivity(recordActivity('mc:3', 'merge-conflict'), 'rejected'), // rejected → resolved
    ];
    const { pending, resolved } = partitionActivities(acts);
    expect(pending.map((a) => a.id)).toEqual(['mc:1', 'abort:1']);
    expect(resolved.map((a) => a.id)).toEqual(['synth:1', 'mc:2', 'clean-merge:1', 'mc:3']);
  });

  it('preserves arrival order within each group', () => {
    const acts: DispatcherActivity[] = [
      recordActivity('m:a', 'merge-conflict'),
      recordActivity('m:b', 'merge-conflict'),
      recordActivity('m:c', 'merge-conflict'),
    ];
    expect(partitionActivities(acts).pending.map((a) => a.id)).toEqual(['m:a', 'm:b', 'm:c']);
  });

  it('handles an empty list', () => {
    expect(partitionActivities([])).toEqual({ pending: [], resolved: [] });
  });
});
