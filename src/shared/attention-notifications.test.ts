import { describe, expect, it } from 'vitest';
import {
  classifyDrainStop,
  decideNotifications,
  type NotificationEvent,
} from './attention-notifications';
import type { AttentionItem, AttentionKind } from './attention-hub-model';

/** A minimal attention item; spread over to set only the fields a test needs. */
function item(over: Partial<AttentionItem> & { kind: AttentionKind }): AttentionItem {
  const project = over.project ?? 'mission-control';
  const issueId = over.issueId ?? null;
  const disc = issueId !== null ? `:${issueId}` : '';
  return {
    project,
    issueId,
    fileRef: null,
    text: `${over.kind} line`,
    id: `${project}:${over.kind}${disc}`,
    ...over,
  };
}

function attentionEvent(items: AttentionItem[]): NotificationEvent {
  return { type: 'attention', items };
}

describe('decideNotifications — the tier filter (only the blocking/terminal set)', () => {
  it('an HITL park yields exactly one intent, with issue + project in the title', () => {
    const { intents } = decideNotifications(
      attentionEvent([item({ kind: 'hitl-park', issueId: 42, text: 'issue 42 — foo is parked (HITL)' })]),
    );
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toBe('hitl-park');
    expect(intents[0].issueId).toBe(42);
    expect(intents[0].project).toBe('mission-control');
    expect(intents[0].title).toContain('mission-control');
    expect(intents[0].title).toContain('42');
    expect(intents[0].body).toContain('parked');
  });

  it('a blocked park yields exactly one intent (reason blocked-park)', () => {
    const { intents } = decideNotifications(
      attentionEvent([item({ kind: 'blocked-run', issueId: 7 })]),
    );
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toBe('blocked-park');
    expect(intents[0].issueId).toBe(7);
  });

  it('a merge conflict yields exactly one intent (issueId null, files named)', () => {
    const { intents } = decideNotifications({
      type: 'merge-conflict',
      project: 'mission-control',
      slugs: ['12-a', '13-b'],
      conflictingFiles: ['src/x.ts'],
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toBe('merge-conflict');
    expect(intents[0].issueId).toBeNull();
    expect(intents[0].title).toContain('merge conflict');
    expect(intents[0].body).toContain('src/x.ts');
  });

  it('a stopped drain and a finished drain each yield exactly one, distinctly-keyed intent', () => {
    const stopped = decideNotifications({
      type: 'drain-ended',
      project: 'mc',
      outcome: 'stopped',
      reason: 'Stopped: the Run on issue 5 reported blocked.',
    });
    const finished = decideNotifications({
      type: 'drain-ended',
      project: 'mc',
      outcome: 'finished',
      reason: 'Stopped: no eligible issue remains.',
    });
    expect(stopped.intents).toHaveLength(1);
    expect(stopped.intents[0].reason).toBe('drain-stopped');
    expect(finished.intents).toHaveLength(1);
    expect(finished.intents[0].reason).toBe('drain-finished');
    // Distinct keys, so both can coexist / fire in one drain lifetime.
    expect(stopped.intents[0].key).not.toBe(finished.intents[0].key);
  });

  it('a scheduled drain skip (issue 191) yields exactly one intent naming the reason', () => {
    const { intents } = decideNotifications({
      type: 'scheduled-drain-skipped',
      project: 'mc',
      reason: 'scheduled drain skipped — main is mid-merge',
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toBe('scheduled-drain-skipped');
    expect(intents[0].issueId).toBeNull();
    expect(intents[0].title).toContain('scheduled drain skipped');
    expect(intents[0].body).toBe('scheduled drain skipped — main is mid-merge');
  });

  it('a scheduled drain skip with no project or reason yields nothing', () => {
    expect(
      decideNotifications({ type: 'scheduled-drain-skipped', project: '', reason: 'x' }).intents,
    ).toHaveLength(0);
    expect(
      decideNotifications({ type: 'scheduled-drain-skipped', project: 'mc', reason: '' }).intents,
    ).toHaveLength(0);
  });

  it('passive / routine attention kinds never notify', () => {
    const { intents } = decideNotifications(
      attentionEvent([
        item({ kind: 'curator-proposal' }),
        item({ kind: 'setup-gate', issueId: 3 }),
        item({ kind: 'new-repo-candidate' }),
        item({ kind: 'briefing' }),
      ]),
    );
    expect(intents).toHaveLength(0);
  });

  it('a routine flip (a done issue, no park) surfaces nothing — the snapshot just has no notifying item', () => {
    // A claim/done flip produces no hitl-park/blocked-run item; the attention
    // snapshot for such a project carries only quiet kinds (or nothing).
    const { intents } = decideNotifications(attentionEvent([item({ kind: 'briefing' })]));
    expect(intents).toHaveLength(0);
  });
});

describe('decideNotifications — dedupe (a re-scan must not re-ping)', () => {
  it('re-scanning the same attention state with the returned seen set yields nothing', () => {
    const event = attentionEvent([
      item({ kind: 'hitl-park', issueId: 42 }),
      item({ kind: 'blocked-run', issueId: 7 }),
    ]);
    const first = decideNotifications(event);
    expect(first.intents).toHaveLength(2);
    const second = decideNotifications(event, first.seen);
    expect(second.intents).toHaveLength(0);
  });

  it('only a genuinely new park pings on the next scan; the already-seen one stays quiet', () => {
    const first = decideNotifications(attentionEvent([item({ kind: 'hitl-park', issueId: 42 })]));
    const second = decideNotifications(
      attentionEvent([
        item({ kind: 'hitl-park', issueId: 42 }), // unchanged — already pinged
        item({ kind: 'hitl-park', issueId: 43 }), // new
      ]),
      first.seen,
    );
    expect(second.intents).toHaveLength(1);
    expect(second.intents[0].issueId).toBe(43);
  });

  it('dedupes duplicate keys within a single event batch', () => {
    const dup = item({ kind: 'hitl-park', issueId: 42 });
    const { intents } = decideNotifications(attentionEvent([dup, dup]));
    expect(intents).toHaveLength(1);
  });

  it('the same merge conflict set does not re-ping; a different set does', () => {
    const first = decideNotifications({ type: 'merge-conflict', project: 'mc', slugs: ['a', 'b'] });
    const again = decideNotifications(
      { type: 'merge-conflict', project: 'mc', slugs: ['b', 'a'] }, // same set, reordered
      first.seen,
    );
    const other = decideNotifications(
      { type: 'merge-conflict', project: 'mc', slugs: ['c'] },
      again.seen,
    );
    expect(first.intents).toHaveLength(1);
    expect(again.intents).toHaveLength(0);
    expect(other.intents).toHaveLength(1);
  });
});

describe('decideNotifications — defensive / total', () => {
  it('never throws on malformed input and yields nothing', () => {
    // @ts-expect-error — exercising the runtime guard with a junk event.
    expect(decideNotifications(null).intents).toHaveLength(0);
    // @ts-expect-error — junk items array.
    expect(decideNotifications({ type: 'attention', items: 'nope' }).intents).toHaveLength(0);
    expect(
      decideNotifications({ type: 'merge-conflict', project: '' }).intents,
    ).toHaveLength(0);
  });
});

describe('classifyDrainStop', () => {
  it('reads "no eligible issue remains" as finished', () => {
    expect(classifyDrainStop('Stopped: no eligible issue remains.')).toBe('finished');
  });

  it('reads a blocked / mid-merge / user stop as stopped', () => {
    expect(classifyDrainStop('Stopped: the Run on issue 5 reported blocked.')).toBe('stopped');
    expect(classifyDrainStop('Stopped: main is mid-merge — resolve the conflict …')).toBe('stopped');
    expect(classifyDrainStop('Drain stopped by you — in-flight Runs keep going.')).toBe('stopped');
  });

  it('defaults to stopped on absent/empty text', () => {
    expect(classifyDrainStop(null)).toBe('stopped');
    expect(classifyDrainStop('')).toBe('stopped');
  });
});
