import { describe, expect, it } from 'vitest';
import {
  classifyAuthority,
  isAuto,
  type Authority,
  type DispatcherAction,
} from './dispatcher-authority';

// The full ADR-0007 line as a table — every action mapped to its authority.
// Kept exhaustive so a newly-added action forces a decision here (and a failing
// test) rather than silently defaulting.
const LINE: Record<DispatcherAction, Authority> = {
  'commit-checkpoint': 'auto',
  'start-next': 'auto',
  synthesize: 'auto',
  relay: 'auto',
  'log-issue': 'needs-approval',
  merge: 'needs-approval',
  'abort-drain': 'needs-approval',
  'discard-and-continue': 'needs-approval',
  'course-change': 'needs-approval',
};

describe('dispatcher authority classifier (ADR-0007, full line)', () => {
  it('marks commit-checkpoint, start-next and synthesize as auto', () => {
    // The exact three the tracer-bullet spine (issue 35) must self-authorize.
    expect(classifyAuthority('commit-checkpoint')).toBe('auto');
    expect(classifyAuthority('start-next')).toBe('auto');
    expect(classifyAuthority('synthesize')).toBe('auto');
  });

  it('also marks relay (plain-language progress) as auto', () => {
    expect(classifyAuthority('relay')).toBe('auto');
  });

  it('marks every scope-changing action as needs-approval', () => {
    const scope: DispatcherAction[] = [
      'log-issue',
      'merge',
      'abort-drain',
      'discard-and-continue',
      'course-change',
    ];
    for (const action of scope) {
      expect(classifyAuthority(action)).toBe('needs-approval');
    }
  });

  it('Merge is always approval-gated (ADR-0002 — no auto-merge)', () => {
    // Called out explicitly because a Merge is the costliest, hard-to-unwind
    // action; it must never fall on the auto side.
    expect(classifyAuthority('merge')).toBe('needs-approval');
    expect(isAuto('merge')).toBe(false);
  });

  it('classifies the entire action union exactly per the ADR-0007 table', () => {
    for (const [action, authority] of Object.entries(LINE) as [
      DispatcherAction,
      Authority,
    ][]) {
      expect(classifyAuthority(action)).toBe(authority);
      expect(isAuto(action)).toBe(authority === 'auto');
    }
  });

  it('discard-and-continue is approval-gated (issue 22 discard is destructive)', () => {
    // Force-removing a worktree + deleting its branch is irreversible, so the
    // Dispatcher proposes it (issue 37) rather than doing it on its own.
    expect(classifyAuthority('discard-and-continue')).toBe('needs-approval');
    expect(isAuto('discard-and-continue')).toBe(false);
  });

  it('returns exactly four auto actions and five needs-approval actions', () => {
    const actions = Object.keys(LINE) as DispatcherAction[];
    const auto = actions.filter((a) => classifyAuthority(a) === 'auto');
    const gated = actions.filter((a) => classifyAuthority(a) === 'needs-approval');
    expect(auto).toHaveLength(4);
    expect(gated).toHaveLength(5);
  });

  it('isAuto agrees with classifyAuthority', () => {
    expect(isAuto('start-next')).toBe(true);
    expect(isAuto('merge')).toBe(false);
  });
});
