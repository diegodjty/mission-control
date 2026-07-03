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
];

describe('describeAction', () => {
  it('gives every action a non-empty plain-language label', () => {
    for (const action of ALL_ACTIONS) {
      expect(describeAction(action)).toBeTruthy();
    }
  });
});

describe('recordActivity', () => {
  it('records an auto action as already taken (autonomous)', () => {
    for (const action of ['commit-checkpoint', 'start-next', 'synthesize', 'relay'] as const) {
      const a = recordActivity(`x:${action}`, action);
      expect(a.authority).toBe('auto');
      expect(a.status).toBe('taken');
      expect(isAutonomous(a)).toBe(true);
      expect(isProposal(a)).toBe(false);
      // A taken autonomous action is not awaiting a click.
      expect(isActionable(a)).toBe(false);
    }
  });

  it('records a scope-changing action as a pending proposal', () => {
    for (const action of ['log-issue', 'merge', 'abort-drain', 'discard-and-continue', 'amend-plan', 'course-change'] as const) {
      const a = recordActivity(`x:${action}`, action);
      expect(a.authority).toBe('needs-approval');
      expect(a.status).toBe('pending');
      expect(isProposal(a)).toBe(true);
      expect(isAutonomous(a)).toBe(false);
      // A pending proposal shows approve/reject.
      expect(isActionable(a)).toBe(true);
    }
  });

  it('records Merge as a pending proposal, never taken (ADR-0002)', () => {
    const a = recordActivity('merge:1', 'merge');
    expect(a.status).toBe('pending');
    expect(a.authority).toBe('needs-approval');
  });

  it('carries the id and label through', () => {
    const a = recordActivity('merge:42', 'merge');
    expect(a.id).toBe('merge:42');
    expect(a.label).toBe(describeAction('merge'));
  });
});

describe('resolveActivity', () => {
  it('approving a pending proposal marks it approved (caller then executes)', () => {
    const pending = recordActivity('merge:1', 'merge');
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

  it('is idempotent — an already-resolved proposal cannot be re-flipped or re-fired', () => {
    const pending = recordActivity('merge:1', 'merge');
    const approved = resolveActivity(pending, 'approved');
    // A second click (or a re-render) must not flip approved → rejected.
    expect(resolveActivity(approved, 'rejected')).toEqual(approved);
    const rejected = resolveActivity(recordActivity('merge:2', 'merge'), 'rejected');
    expect(resolveActivity(rejected, 'approved')).toEqual(rejected);
  });

  it('a resolved proposal is no longer actionable', () => {
    const pending = recordActivity('merge:1', 'merge');
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
      recordActivity('synth:1', 'synthesize'), // auto → taken → resolved
      recordActivity('merge:1', 'merge'), // pending
      resolveActivity(recordActivity('merge:2', 'merge'), 'approved'), // approved → resolved
      recordActivity('abort:1', 'abort-drain'), // pending
      resolveActivity(recordActivity('merge:3', 'merge'), 'rejected'), // rejected → resolved
    ];
    const { pending, resolved } = partitionActivities(acts);
    expect(pending.map((a) => a.id)).toEqual(['merge:1', 'abort:1']);
    expect(resolved.map((a) => a.id)).toEqual(['synth:1', 'merge:2', 'merge:3']);
  });

  it('preserves arrival order within each group', () => {
    const acts: DispatcherActivity[] = [
      recordActivity('m:a', 'merge'),
      recordActivity('m:b', 'merge'),
      recordActivity('m:c', 'merge'),
    ];
    expect(partitionActivities(acts).pending.map((a) => a.id)).toEqual(['m:a', 'm:b', 'm:c']);
  });

  it('handles an empty list', () => {
    expect(partitionActivities([])).toEqual({ pending: [], resolved: [] });
  });
});
