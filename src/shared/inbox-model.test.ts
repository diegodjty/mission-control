import { describe, it, expect } from 'vitest';
import type { AttentionItem } from './attention-model';
import {
  advanceLastSeen,
  kindLabel,
  mergeBriefing,
  parseLastSeen,
  serializeLastSeen,
  splitInbox,
  workbenchProjectPath,
} from './inbox-model';

/**
 * The Inbox's pure presentation + last-seen logic (issue 80, ADR-0016):
 * grouping the aggregated attention list by project, splitting the briefing
 * out, badge labels, and the persisted last-seen stamp operations. All
 * house-PURE: any input yields a value, never a throw.
 */

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    project: 'alpha',
    kind: 'hitl-park',
    issueId: 5,
    fileRef: 'issues/05-x.md',
    text: 'issue 05 — x is parked (HITL) — awaiting your verification',
    id: 'alpha:hitl-park:5',
    ...overrides,
  };
}

describe('splitInbox', () => {
  it('splits briefing lines from actionable items and groups the latter by project, ascending', () => {
    const items: AttentionItem[] = [
      item({ project: 'beta', id: 'beta:hitl-park:5' }),
      item({
        project: 'beta',
        kind: 'briefing',
        issueId: null,
        fileRef: 'memory/journal/2026-07-04.md',
        id: 'beta:briefing:2026-07-04.md',
        text: '2026-07-04 — backlog drained; 3 runs',
      }),
      item({
        project: 'alpha',
        kind: 'curator-proposal',
        issueId: null,
        fileRef: 'memory/CORE.proposed.md',
        id: 'alpha:curator-proposal',
      }),
      item({ project: 'alpha', kind: 'blocked-run', issueId: 7, id: 'alpha:blocked-run:7' }),
    ];

    const view = splitInbox(items);
    expect(view.briefing.map((i) => i.id)).toEqual(['beta:briefing:2026-07-04.md']);
    expect(view.groups.map((g) => g.project)).toEqual(['alpha', 'beta']);
    expect(view.groups[0].items.map((i) => i.id)).toEqual([
      'alpha:curator-proposal',
      'alpha:blocked-run:7',
    ]);
    expect(view.groups[1].items.map((i) => i.id)).toEqual(['beta:hitl-park:5']);
  });

  it('preserves the aggregate order within a project (the model already ordered it)', () => {
    const items = [
      item({ id: 'alpha:hitl-park:5', issueId: 5 }),
      item({ kind: 'setup-gate', id: 'alpha:setup-gate:token', issueId: 7 }),
    ];
    expect(splitInbox(items).groups[0].items.map((i) => i.id)).toEqual([
      'alpha:hitl-park:5',
      'alpha:setup-gate:token',
    ]);
  });

  it('degrades non-array / malformed input to the empty view, never a throw', () => {
    expect(splitInbox(null as unknown as AttentionItem[])).toEqual({ briefing: [], groups: [] });
    expect(splitInbox(undefined as unknown as AttentionItem[])).toEqual({
      briefing: [],
      groups: [],
    });
    // A hole or junk entry is skipped, not fatal.
    const junk = [item({}), null, 42, { nope: true }] as unknown as AttentionItem[];
    expect(splitInbox(junk).groups[0].items).toHaveLength(1);
  });
});

describe('mergeBriefing', () => {
  it('unions the mount-frozen briefing with live items, deduped by id, live first', () => {
    const frozen = [
      item({ kind: 'briefing', id: 'a:briefing:2026-07-03.md', issueId: null }),
      item({ kind: 'briefing', id: 'a:briefing:2026-07-02.md', issueId: null }),
    ];
    const live = [
      item({ kind: 'briefing', id: 'a:briefing:2026-07-04.md', issueId: null }),
      item({ kind: 'briefing', id: 'a:briefing:2026-07-03.md', issueId: null }),
    ];
    expect(mergeBriefing(frozen, live).map((i) => i.id)).toEqual([
      'a:briefing:2026-07-04.md',
      'a:briefing:2026-07-03.md',
      'a:briefing:2026-07-02.md',
    ]);
  });

  it('handles empty / malformed sides', () => {
    expect(mergeBriefing([], [])).toEqual([]);
    const one = [item({ kind: 'briefing', id: 'x', issueId: null })];
    expect(mergeBriefing(one, null as unknown as AttentionItem[])).toHaveLength(1);
    expect(mergeBriefing(null as unknown as AttentionItem[], one)).toHaveLength(1);
  });
});

describe('kindLabel', () => {
  it('maps every attention kind to a short badge label', () => {
    expect(kindLabel('hitl-park')).toBe('HITL');
    expect(kindLabel('curator-proposal')).toBe('proposal');
    expect(kindLabel('blocked-run')).toBe('blocked');
    expect(kindLabel('setup-gate')).toBe('setup');
    expect(kindLabel('briefing')).toBe('journal');
  });
});

describe('last-seen stamps (userData, ADR-0016 — never workbench data)', () => {
  it('parse → serialize round-trips a stamp map', () => {
    const stamps = { alpha: '2026-07-04T10:00:00Z', beta: '2026-07-01T00:00:00Z' };
    expect(parseLastSeen(serializeLastSeen(stamps))).toEqual(stamps);
  });

  it('parse degrades malformed content to an empty map', () => {
    expect(parseLastSeen(null)).toEqual({});
    expect(parseLastSeen('')).toEqual({});
    expect(parseLastSeen('not json')).toEqual({});
    expect(parseLastSeen('[1,2]')).toEqual({});
    // Non-string values are dropped, string ones kept.
    expect(parseLastSeen('{"alpha":"2026-07-04","beta":42}')).toEqual({ alpha: '2026-07-04' });
  });

  it('advanceLastSeen stamps the given projects at now and preserves the rest', () => {
    const prior = { alpha: '2026-07-01T00:00:00Z', gamma: '2026-06-01T00:00:00Z' };
    const next = advanceLastSeen(prior, ['alpha', 'beta'], '2026-07-05T12:00:00Z');
    expect(next).toEqual({
      alpha: '2026-07-05T12:00:00Z',
      beta: '2026-07-05T12:00:00Z',
      gamma: '2026-06-01T00:00:00Z',
    });
    // The input map is not mutated.
    expect(prior.alpha).toBe('2026-07-01T00:00:00Z');
  });

  it('advanceLastSeen never moves a stamp backwards (clock skew safety)', () => {
    const prior = { alpha: '2026-07-06T00:00:00Z' };
    const next = advanceLastSeen(prior, ['alpha'], '2026-07-05T00:00:00Z');
    expect(next.alpha).toBe('2026-07-06T00:00:00Z');
  });

  it('advanceLastSeen skips junk project names and junk inputs', () => {
    const next = advanceLastSeen(
      null as unknown as Record<string, string>,
      ['alpha', '', 3 as unknown as string],
      '2026-07-05T00:00:00Z',
    );
    expect(next).toEqual({ alpha: '2026-07-05T00:00:00Z' });
  });
});

describe('workbenchProjectPath', () => {
  it('joins the snapshot root and the project directory name', () => {
    expect(workbenchProjectPath('/Users/x/Workbench', 'alpha')).toBe('/Users/x/Workbench/alpha');
  });

  it('refuses empty or path-shaped project names (never a guessed path)', () => {
    expect(workbenchProjectPath('', 'alpha')).toBeNull();
    expect(workbenchProjectPath('/root', '')).toBeNull();
    expect(workbenchProjectPath('/root', '../etc')).toBeNull();
    expect(workbenchProjectPath('/root', 'a/b')).toBeNull();
  });
});
