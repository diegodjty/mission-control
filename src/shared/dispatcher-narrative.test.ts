/**
 * Run-narrative routing (issue 66, ADR-0014) — unit tests on the routing
 * decision: what lands in the Dispatcher CONVERSATION as a live message vs what
 * stays a history-strip line only. Also pins the pump-key helpers that let live
 * delivery and the on-ask digest (issue 61) share one "session has seen it" set,
 * and the ADR-0011 invariant that narrative never widens the blocking list.
 */
import { describe, it, expect } from 'vitest';
import {
  narrativeChannelFor,
  narrativeKindForLifecycle,
  narrativeKeyFor,
  sessionSeenRecordId,
  type NarrativeEventKind,
} from './dispatcher-narrative';
import { classifyAuthority } from './dispatcher-authority';
import { channelForAction } from './dispatcher-channel';
import type { LifecycleEventKind } from './dispatcher-lifecycle';

describe('narrativeChannelFor — the ADR-0014 channel model', () => {
  it('routes run narrative into the conversation: completion blocks, HITL parks, drain facts, adopted strays, missing receipts', () => {
    const chatKinds: NarrativeEventKind[] = [
      'run-completed',
      'hitl-park',
      'drain-stopped',
      'drain-halted',
      'strays-adopted',
      'finished-without-receipt',
    ];
    for (const kind of chatKinds) {
      expect(narrativeChannelFor(kind), kind).toBe('chat');
    }
  });

  it('keeps routine flips and speculative signals OUT of the conversation (ADR-0012 noise floor stands)', () => {
    const historyKinds: NarrativeEventKind[] = [
      'run-started',
      'run-blocked-alert',
      'run-stranded-alert',
      'needs-attention',
      'doc-drift',
      'cross-run-overlap',
      'status-refresh',
      'receipt-mismatch',
      'delivery-phase',
    ];
    for (const kind of historyKinds) {
      expect(narrativeChannelFor(kind), kind).toBe('history');
    }
  });

  it('narrative is not a gate: the ADR-0011 blocking list is unchanged by ADR-0014', () => {
    // The three-item blocking-approval list, exactly as before.
    expect(classifyAuthority('merge-conflict')).toBe('blocking');
    expect(classifyAuthority('abort-drain')).toBe('blocking');
    expect(classifyAuthority('hitl-signoff')).toBe('blocking');
    // And the authority → channel line (issue 48) is untouched: blocking → chat,
    // everything else → log. Narrative rides its OWN routing, not a widened gate.
    expect(channelForAction('merge-conflict')).toBe('chat');
    expect(channelForAction('hitl-signoff')).toBe('chat');
    expect(channelForAction('synthesize')).toBe('log');
    expect(channelForAction('relay')).toBe('log');
    expect(channelForAction('receipt-adopt')).toBe('log');
  });
});

describe('narrativeKindForLifecycle — lifecycle events onto the narrative table', () => {
  it('maps every lifecycle kind, chat-worthy facts to chat and alerts to history', () => {
    const expected: Record<LifecycleEventKind, NarrativeEventKind> = {
      started: 'run-started',
      finished: 'run-completed',
      blocked: 'run-blocked-alert',
      stranded: 'run-stranded-alert',
      'needs-attention': 'needs-attention',
      'hitl-waiting': 'hitl-park',
      'finished-without-receipt': 'finished-without-receipt',
    };
    for (const [lifecycle, narrative] of Object.entries(expected)) {
      expect(narrativeKindForLifecycle(lifecycle as LifecycleEventKind), lifecycle).toBe(narrative);
    }
    // The two ADR-0014 promotions out of the ambient log:
    expect(narrativeChannelFor(narrativeKindForLifecycle('hitl-waiting'))).toBe('chat');
    expect(narrativeChannelFor(narrativeKindForLifecycle('finished-without-receipt'))).toBe('chat');
    // Blocked/stranded alerts stay history (their halt fact is the chat message).
    expect(narrativeChannelFor(narrativeKindForLifecycle('blocked'))).toBe('history');
    expect(narrativeChannelFor(narrativeKindForLifecycle('stranded'))).toBe('history');
  });
});

describe('session-seen keys — one "session has seen it" set for live feed + digest', () => {
  it('round-trips a narrative delivery key to its Run-log record id', () => {
    // Record ids themselves contain colons (receipt:<slug>:<finished>), so the
    // parse must strip the prefix, never split on ":".
    const recId = 'receipt:02-second-step:2026-07-03T12:00:00.000Z';
    expect(sessionSeenRecordId(narrativeKeyFor(recId))).toBe(recId);
  });

  it('recognises a delivered hitl-waiting notice as the session having seen that Run', () => {
    const recId = 'receipt:05-manual-check:2026-07-03T12:00:00.000Z';
    expect(sessionSeenRecordId(`hitl-waiting:${recId}`)).toBe(recId);
  });

  it('returns null for every non-Run delivery key (snapshots, gates, notes)', () => {
    for (const key of [
      'status-snapshot:3',
      'merge-conflict:06-parallel-a',
      'drain-stopped:1',
      'drain-halted:1',
      'synthesize:receipt:x:y',
      'doc-drift:receipt:x:y',
      'finished-without-receipt:missing-receipt-4',
      'receipt-adopt:solo:issues/completions/06.md',
      'narrative:',
      'hitl-waiting:',
    ]) {
      expect(sessionSeenRecordId(key), key).toBeNull();
    }
  });
});
