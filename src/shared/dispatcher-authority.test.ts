import { describe, expect, it } from 'vitest';
import {
  classifyAuthority,
  isBlocking,
  isProtectedBranch,
  DEFAULT_PROTECTED_BRANCHES,
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
  'receipt-adopt': 'passive',
  // The blocking list (four items as of issue 113, amending ADR-0011).
  'merge-conflict': 'blocking',
  'abort-drain': 'blocking',
  'hitl-signoff': 'blocking',
  'protected-branch-land': 'blocking',
};

// The ENTIRE blocking list per ADR-0011 as amended by issue 113 — nothing else
// may block. Issue 113 adds `protected-branch-land` to the original three.
const BLOCKING: DispatcherAction[] = [
  'merge-conflict',
  'abort-drain',
  'hitl-signoff',
  'protected-branch-land',
];

describe('dispatcher authority classifier (ADR-0011, silent-autonomy default)', () => {
  it('blocks on EXACTLY the interruption list, nothing else (four items as of issue 113)', () => {
    for (const action of BLOCKING) {
      expect(classifyAuthority(action)).toBe('blocking');
      expect(isBlocking(action)).toBe(true);
    }
    const blocking = (Object.keys(LINE) as DispatcherAction[]).filter((a) => isBlocking(a));
    expect(blocking.sort()).toEqual([...BLOCKING].sort());
    expect(blocking).toHaveLength(4);
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

  it('adopting a stray Receipt is a passive repair note, never a gate (issue 62)', () => {
    expect(classifyAuthority('receipt-adopt')).toBe('passive');
    expect(isBlocking('receipt-adopt')).toBe(false);
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

  it('landing on a protected branch is a blocking gate (issue 113)', () => {
    expect(classifyAuthority('protected-branch-land')).toBe('blocking');
    expect(isBlocking('protected-branch-land')).toBe(true);
  });
});

describe('isProtectedBranch (issue 113 — the "big warning" trigger)', () => {
  it('treats the default set main/master as protected', () => {
    expect(DEFAULT_PROTECTED_BRANCHES).toEqual(['main', 'master']);
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('master')).toBe(true);
  });

  it('does NOT treat a feature branch as protected — it lands unchanged', () => {
    expect(isProtectedBranch('afk/113-merge-target')).toBe(false);
    expect(isProtectedBranch('feature/login')).toBe(false);
    expect(isProtectedBranch('develop')).toBe(false);
  });

  it('is case- and whitespace-insensitive (errs toward warning)', () => {
    expect(isProtectedBranch('Main')).toBe(true);
    expect(isProtectedBranch('MASTER')).toBe(true);
    // Raw git output can carry a trailing newline.
    expect(isProtectedBranch('main\n')).toBe(true);
  });

  it('treats an empty/unknown branch as NOT protected (nothing to warn about)', () => {
    expect(isProtectedBranch('')).toBe(false);
    expect(isProtectedBranch(null)).toBe(false);
    expect(isProtectedBranch(undefined)).toBe(false);
  });

  it('honors a custom protected set (config overrides the default)', () => {
    const config = { protected: ['trunk', 'release'] };
    expect(isProtectedBranch('trunk', config)).toBe(true);
    expect(isProtectedBranch('release', config)).toBe(true);
    // With a custom set, the defaults are NOT implicitly protected.
    expect(isProtectedBranch('main', config)).toBe(false);
  });
});
