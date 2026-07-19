import { describe, expect, it } from 'vitest';
import {
  lifecycleKindForOutcome,
  reactToLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventKind,
} from './dispatcher-lifecycle';
import { classifyAuthority } from './action-authority';
import type { RunOutcome } from './completion-parser';

/** A base event; each test overrides the kind/fields it cares about. */
function ev(over: Partial<LifecycleEvent> & { kind: LifecycleEventKind }): LifecycleEvent {
  return {
    runId: 'sess-1',
    issueId: 5,
    slug: 'manual-check',
    title: 'manual-check',
    detail: null,
    ...over,
  };
}

describe('reactToLifecycleEvent', () => {
  it('relays started/finished as non-proactive with no proposal', () => {
    for (const kind of ['started', 'finished'] as const) {
      const r = reactToLifecycleEvent(ev({ kind }));
      expect(r.proactive).toBe(false);
      expect(r.proposal).toBeNull();
      expect(r.notification).toContain('issue 05');
    }
  });

  it('surfaces a declared-blocked Run as a PARK awaiting the human, no discard proposal (issue 137)', () => {
    const r = reactToLifecycleEvent(
      ev({ kind: 'blocked', detail: '62 is wip and blocks the rest' }),
    );
    // Proactive so the user is not left to notice the parked issue.
    expect(r.proactive).toBe(true);
    expect(r.notification).toContain('issue 05');
    expect(r.notification).toContain('blocked');
    // The captured blocker reason (issue 42 detail) reaches the user.
    expect(r.notification).toContain('62 is wip and blocks the rest');
    // The drain continues past it and the human unsticks it — nothing to discard.
    expect(r.notification?.toLowerCase()).not.toContain('discard');
    expect(r.proposal).toBeNull();
  });

  it('surfaces a stranded Run and suggests a non-blocking discard-and-continue', () => {
    const r = reactToLifecycleEvent(ev({ kind: 'stranded' }));
    expect(r.proactive).toBe(true);
    expect(r.notification).toContain('stranded');
    expect(r.proposal?.action).toBe('discard-and-continue');
    expect(classifyAuthority(r.proposal!.action)).not.toBe('blocking');
  });

  it('surfaces a needs-attention Run so the drain does not silently stall', () => {
    const r = reactToLifecycleEvent(ev({ kind: 'needs-attention' }));
    expect(r.proactive).toBe(true);
    expect(r.notification).toContain('needs your attention');
    // Nothing safe to auto-propose here.
    expect(r.proposal).toBeNull();
  });

  it('proactively notifies for a HITL-waiting issue and relays its verification steps', () => {
    const steps = '1. Call the live number. 2. Confirm the greeting plays.';
    const r = reactToLifecycleEvent(
      ev({ kind: 'hitl-waiting', issueId: 5, slug: 'manual-check', detail: steps }),
    );
    // Proactive so the user is not left to notice the paused drain.
    expect(r.proactive).toBe(true);
    // Names the issue...
    expect(r.notification).toContain('issue 05');
    expect(r.notification).toContain('manual-check');
    // ...and relays the manual-verification steps (issue 42 captured detail).
    expect(r.notification).toContain(steps);
    // The human does the verifying — no gated action.
    expect(r.proposal).toBeNull();
  });

  it('omits the detail clause when there is no captured body', () => {
    const r = reactToLifecycleEvent(ev({ kind: 'hitl-waiting', detail: null }));
    expect(r.notification).not.toContain('Steps:');
    const b = reactToLifecycleEvent(ev({ kind: 'blocked', detail: '   ' }));
    expect(b.notification).not.toContain('Reason:');
  });

  it('notes a finished-without-receipt Run passively — peek at the Pane, no scrape (issue 57)', () => {
    const r = reactToLifecycleEvent(
      ev({ kind: 'finished-without-receipt', issueId: 5, slug: 'manual-check' }),
    );
    // A routine passive fact: not proactive, nothing to approve.
    expect(r.proactive).toBe(false);
    expect(r.proposal).toBeNull();
    expect(r.notification).toContain('issue 05');
    expect(r.notification).toContain('finished without a receipt');
    expect(r.notification).toContain('peek at the Pane');
  });

  it('falls back gracefully when issue id/slug are unknown', () => {
    // The blocked park labels the issue "a Run" when nothing is known, no proposal.
    const b = reactToLifecycleEvent(
      ev({ kind: 'blocked', issueId: null, slug: null, title: null }),
    );
    expect(b.notification).toContain('a Run');
    expect(b.proposal).toBeNull();
    // The stranded path still carries its discard-and-continue proposal id.
    const s = reactToLifecycleEvent(
      ev({ kind: 'stranded', issueId: null, slug: null, title: null }),
    );
    expect(s.notification).toContain('a Run');
    expect(s.proposal?.id).toBe('discard-and-continue:sess-1');
  });

  // The defining exclusion (PRD "Input contract", ADR-0007): raw Pane output is
  // NEVER surfaced. Prove it by pushing raw scroll into the event and asserting
  // none of it appears in the reaction.
  it('NEVER surfaces raw Pane output (assert the exclusion)', () => {
    const RAW = 'RAW_PANE_SCROLL_esc[2Jgit diff --stat secrets leaking here';
    for (const kind of [
      'started',
      'finished',
      'blocked',
      'stranded',
      'needs-attention',
      'hitl-waiting',
      'finished-without-receipt',
    ] as const) {
      const r = reactToLifecycleEvent(
        ev({ kind, detail: 'real captured detail', rawPaneOutput: RAW }),
      );
      expect(r.notification ?? '').not.toContain('RAW_PANE_SCROLL');
      expect(r.notification ?? '').not.toContain(RAW);
    }
  });
});

describe('lifecycleKindForOutcome', () => {
  it('maps completed → finished and blocked → blocked', () => {
    expect(lifecycleKindForOutcome('completed', false)).toBe('finished');
    expect(lifecycleKindForOutcome('blocked', false)).toBe('blocked');
  });

  it('maps needs-verification → hitl-waiting only for a HITL issue', () => {
    expect(lifecycleKindForOutcome('needs-verification', true)).toBe('hitl-waiting');
    // A needs-verification block on a non-HITL issue is a stall to surface, not
    // a declared HITL gate.
    expect(lifecycleKindForOutcome('needs-verification', false)).toBe('needs-attention');
  });

  it('maps unknown → null (nothing recognised to react to)', () => {
    expect(lifecycleKindForOutcome('unknown', false)).toBeNull();
    expect(lifecycleKindForOutcome('unknown', true)).toBeNull();
  });

  it('classifies every outcome (exhaustive)', () => {
    const outcomes: RunOutcome[] = ['completed', 'needs-verification', 'blocked', 'unknown'];
    for (const o of outcomes) {
      // Never throws; returns a kind or null.
      const k = lifecycleKindForOutcome(o, true);
      expect(k === null || typeof k === 'string').toBe(true);
    }
  });
});
