import { describe, expect, it, vi } from 'vitest';
import { NotificationController } from './notification-controller';
import type { NotificationIntent } from '../shared/attention-notifications';
import type { AttentionItem, AttentionKind } from '../shared/attention-hub-model';

function item(kind: AttentionKind, issueId: number | null, project = 'mc'): AttentionItem {
  const disc = issueId !== null ? `:${issueId}` : '';
  return {
    project,
    kind,
    issueId,
    fileRef: null,
    text: `${kind} line`,
    id: `${project}:${kind}${disc}`,
  };
}

/** A controller wired to a spy `show`, returning the flattened fired intents. */
function harness(): { ctrl: NotificationController; fired: NotificationIntent[]; show: ReturnType<typeof vi.fn> } {
  const fired: NotificationIntent[] = [];
  const show = vi.fn((intents: NotificationIntent[]) => fired.push(...intents));
  return { ctrl: new NotificationController({ show }), fired, show };
}

describe('NotificationController — launch seed', () => {
  it('the FIRST attention snapshot seeds (no ping) for parks already on disk', () => {
    const { ctrl, show } = harness();
    ctrl.attentionChanged([item('hitl-park', 42), item('blocked-run', 7)]);
    expect(show).not.toHaveBeenCalled();
  });

  it('a park appearing AFTER the seed pings once, and a re-scan does not re-ping', () => {
    const { ctrl, fired, show } = harness();
    ctrl.attentionChanged([]); // seed: nothing on disk
    ctrl.attentionChanged([item('hitl-park', 42)]); // new park
    expect(fired).toHaveLength(1);
    expect(fired[0].reason).toBe('hitl-park');
    ctrl.attentionChanged([item('hitl-park', 42)]); // re-scan of same state
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('fires only the notifying kinds when a mixed snapshot arrives after seeding', () => {
    const { ctrl, fired } = harness();
    ctrl.attentionChanged([]);
    ctrl.attentionChanged([
      item('hitl-park', 1),
      item('curator-proposal', null),
      item('setup-gate', 2),
      item('blocked-run', 3),
      item('briefing', null),
    ]);
    expect(fired.map((i) => i.reason).sort()).toEqual(['blocked-park', 'hitl-park']);
  });
});

describe('NotificationController — merge conflicts', () => {
  it('pings once on a conflict and dedupes a retry of the same set', () => {
    const { ctrl, show } = harness();
    ctrl.attentionChanged([]); // seed
    ctrl.mergeConflicted('mc', ['12-a', '13-b'], ['src/x.ts']);
    ctrl.mergeConflicted('mc', ['13-b', '12-a']); // same set reordered
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationController — drain end (per drain)', () => {
  it('pings on every drain end, even for the same project across drains', () => {
    const { ctrl, fired } = harness();
    ctrl.attentionChanged([]); // seed
    ctrl.drainEnded('mc', 'finished', 'Stopped: no eligible issue remains.');
    ctrl.drainEnded('mc', 'stopped', 'Drain stopped by you — in-flight Runs keep going.');
    ctrl.drainEnded('mc', 'finished'); // a second finished drain, same project
    expect(fired.map((i) => i.reason)).toEqual([
      'drain-finished',
      'drain-stopped',
      'drain-finished',
    ]);
  });
});
