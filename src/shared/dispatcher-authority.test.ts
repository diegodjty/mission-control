import { describe, expect, it } from 'vitest';
import {
  classifyAuthority,
  isBlocking,
  type Authority,
  type DispatcherAction,
} from './dispatcher-authority';

// The full ADR-0011 line as a table — every action mapped to its interruption
// tier. Kept exhaustive so a newly-added action forces a decision here (and a
// failing test) rather than silently defaulting.
const LINE: Record<DispatcherAction, Authority> = {
  // Silent mechanics.
  'start-next': 'silent',
  synthesize: 'silent',
  relay: 'silent',
  // Passive, non-blocking notes.
  'commit-checkpoint': 'passive',
  'log-issue': 'passive',
  merge: 'passive',
  'discard-and-continue': 'passive',
  'amend-plan': 'passive',
  'course-change': 'passive',
  'merge-preflight': 'passive',
  // The three-item blocking list.
  'merge-conflict': 'blocking',
  'abort-drain': 'blocking',
  'hitl-signoff': 'blocking',
};

// The ENTIRE blocking list per ADR-0011 — nothing else may block.
const BLOCKING: DispatcherAction[] = ['merge-conflict', 'abort-drain', 'hitl-signoff'];

describe('dispatcher authority classifier (ADR-0011, silent-autonomy default)', () => {
  it('blocks on EXACTLY the three-item interruption list, nothing else', () => {
    for (const action of BLOCKING) {
      expect(classifyAuthority(action)).toBe('blocking');
      expect(isBlocking(action)).toBe(true);
    }
    const blocking = (Object.keys(LINE) as DispatcherAction[]).filter((a) => isBlocking(a));
    expect(blocking.sort()).toEqual([...BLOCKING].sort());
    expect(blocking).toHaveLength(3);
  });

  it('makes a clean merge, logging an issue, amend-plan and discard-and-continue non-blocking', () => {
    // The costly former gates that ADR-0011 demotes to passive notes.
    for (const action of ['merge', 'log-issue', 'amend-plan', 'discard-and-continue'] as const) {
      expect(classifyAuthority(action)).toBe('passive');
      expect(isBlocking(action)).toBe(false);
    }
  });

  it('a clean merge is passive but a conflicting merge blocks (refines ADR-0002)', () => {
    expect(classifyAuthority('merge')).toBe('passive');
    expect(classifyAuthority('merge-conflict')).toBe('blocking');
  });

  it('a merge PREFLIGHT failure is passive — a message, never an approval that cannot succeed (issue 59)', () => {
    expect(classifyAuthority('merge-preflight')).toBe('passive');
    expect(isBlocking('merge-preflight')).toBe(false);
  });

  it('keeps pure scheduling/relay mechanics silent', () => {
    for (const action of ['start-next', 'synthesize', 'relay'] as const) {
      expect(classifyAuthority(action)).toBe('silent');
      expect(isBlocking(action)).toBe(false);
    }
  });

  it('a committed checkpoint is a passive note', () => {
    expect(classifyAuthority('commit-checkpoint')).toBe('passive');
  });

  it('classifies the entire action union exactly per the ADR-0011 table', () => {
    for (const [action, authority] of Object.entries(LINE) as [
      DispatcherAction,
      Authority,
    ][]) {
      expect(classifyAuthority(action)).toBe(authority);
      expect(isBlocking(action)).toBe(authority === 'blocking');
    }
  });

  it('classifies every action into exactly one of blocking | passive | silent', () => {
    for (const action of Object.keys(LINE) as DispatcherAction[]) {
      expect(['blocking', 'passive', 'silent']).toContain(classifyAuthority(action));
    }
  });
});
