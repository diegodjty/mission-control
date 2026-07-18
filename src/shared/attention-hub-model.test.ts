/**
 * Unit tests for the PURE attention hub model (issue 125, ADR-0020).
 *
 * Two layers, one module:
 *  - per-project derivation (`deriveAttention`) — the same decision-table cases
 *    the old attention model pinned: each kind derives from fixture inputs,
 *    holds a stable id across re-derivation, and disappears when resolved;
 *  - cross-project presentation (`buildAttentionHub`, `needsYouCount`,
 *    `needsYouByProject`, `mergeBriefing`, `kindLabel`, last-seen ops) — the
 *    single source the surface, the rail badge, and the Launcher cards read, so
 *    they can never disagree.
 *
 * House PURE contract throughout: no I/O, any input yields a value, never a
 * throw; malformed artifacts degrade to no item + an explicit note.
 */
import { describe, it, expect } from 'vitest';
import { buildBacklog, type Backlog } from './backlog-model';
import { parseReceipt, type ReceiptRecord } from './receipt-parser';
import {
  advanceLastSeen,
  buildAttentionHub,
  deriveAttention,
  deriveCuratorReportItems,
  kindLabel,
  markDebriefSeen,
  markReportSeen,
  mergeBriefing,
  needsYouByProject,
  needsYouCount,
  parseLastSeen,
  parseSeenDebriefs,
  parseSeenReports,
  projectDirNameFromKey,
  scopeAttentionToWindow,
  serializeLastSeen,
  serializeSeenDebriefs,
  serializeSeenReports,
  shouldOfferDebrief,
  workbenchProjectPath,
  type AttentionInput,
  type AttentionItem,
  type CuratorReportFile,
} from './attention-hub-model';

// ===========================================================================
// Per-project derivation (deriveAttention)
// ===========================================================================

const issueFile = (
  name: string,
  status: string,
  opts: { hitl?: boolean; heading?: string } = {},
): { name: string; content: string } => ({
  name,
  content: [
    '---',
    `status: ${status}`,
    'depends_on: []',
    ...(opts.hitl ? ['hitl: true'] : []),
    '---',
    '',
    `# ${opts.heading ?? name.replace(/\.md$/, '').replace(/^(\d+)-/, '$1 — ')}`,
    '',
    '## What to build',
    '',
    'Fixture.',
  ].join('\n'),
});

/** Backlog: 05 = HITL wip, 07 = open, 08 = done, 12 = wip (non-HITL). */
function fixtureBacklog(overrides: Record<string, string> = {}): Backlog {
  return buildBacklog(
    [
      issueFile('05-manual-check.md', overrides['05'] ?? 'wip', { hitl: true }),
      issueFile('07-parallel-isolation.md', overrides['07'] ?? 'open'),
      issueFile('08-merge-runs.md', overrides['08'] ?? 'done'),
      issueFile('12-tile-panes.md', overrides['12'] ?? 'wip'),
    ],
    null,
  );
}

const receipt = (
  issue: number,
  slug: string,
  outcome: string,
  finished = '2026-07-01T10:00:00Z',
  body = '',
): ReceiptRecord =>
  parseReceipt(
    [
      '---',
      `issue: ${issue}`,
      `slug: ${slug}`,
      `outcome: ${outcome}`,
      `finished: ${finished}`,
      '---',
      body,
    ].join('\n'),
  );

const journalEntry = (name: string, ended: string, reason: string): { name: string; content: string } => ({
  name,
  content: [
    `# Drain journal — ${ended.slice(0, 10)}`,
    '',
    `- Ended: ${ended}`,
    `- Reason: ${reason}`,
    '',
    '## Runs',
    '',
    '- some-slug: completed — did the thing',
  ].join('\n'),
});

function input(partial: Partial<AttentionInput> = {}): AttentionInput {
  return {
    project: 'demo',
    backlog: fixtureBacklog(),
    receipts: [],
    coreProposedPresent: false,
    humanSetup: null,
    journal: [],
    lastSeen: null,
    ...partial,
  };
}

const itemsOfKind = (items: readonly AttentionItem[], kind: string) =>
  items.filter((i) => i.kind === kind);

describe('hitl-park', () => {
  it('derives from an hitl wip issue with a needs-verification Receipt', () => {
    const { items, notes } = deriveAttention(
      input({ receipts: [receipt(5, 'manual-check', 'needs-verification')] }),
    );
    const parks = itemsOfKind(items, 'hitl-park');
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({
      project: 'demo',
      kind: 'hitl-park',
      issueId: 5,
      fileRef: 'issues/05-manual-check.md',
      id: 'demo:hitl-park:5',
    });
    expect(parks[0].text).toMatch(/manual-check/);
    expect(notes).toEqual([]);
  });

  it('does NOT derive from a needs-verification Receipt on a non-HITL issue', () => {
    const { items } = deriveAttention(
      input({ receipts: [receipt(12, 'tile-panes', 'needs-verification')] }),
    );
    expect(itemsOfKind(items, 'hitl-park')).toEqual([]);
  });

  it('does not derive without a Receipt declaring the park', () => {
    const { items } = deriveAttention(input());
    expect(itemsOfKind(items, 'hitl-park')).toEqual([]);
  });

  it('disappears when the issue flips done', () => {
    const { items } = deriveAttention(
      input({
        backlog: fixtureBacklog({ '05': 'done' }),
        receipts: [receipt(5, 'manual-check', 'needs-verification')],
      }),
    );
    expect(itemsOfKind(items, 'hitl-park')).toEqual([]);
  });

  it('judges only the LATEST Receipt — a newer completed re-run clears the park', () => {
    const { items } = deriveAttention(
      input({
        receipts: [
          receipt(5, 'manual-check', 'needs-verification', '2026-07-01T10:00:00Z'),
          receipt(5, 'manual-check', 'completed', '2026-07-02T10:00:00Z'),
        ],
      }),
    );
    expect(itemsOfKind(items, 'hitl-park')).toEqual([]);
  });
});

describe('curator-proposal', () => {
  it('derives when CORE.proposed.md is present, with the file reference', () => {
    const { items } = deriveAttention(input({ coreProposedPresent: true }));
    const proposals = itemsOfKind(items, 'curator-proposal');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'curator-proposal',
      issueId: null,
      fileRef: 'memory/CORE.proposed.md',
      id: 'demo:curator-proposal',
    });
  });

  it('disappears when the proposal file is gone', () => {
    const { items } = deriveAttention(input({ coreProposedPresent: false }));
    expect(itemsOfKind(items, 'curator-proposal')).toEqual([]);
  });
});

describe('blocked-run', () => {
  it('derives from a blocked Receipt on an open issue', () => {
    const { items } = deriveAttention(
      input({ receipts: [receipt(7, 'parallel-isolation', 'blocked')] }),
    );
    const blocked = itemsOfKind(items, 'blocked-run');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      issueId: 7,
      fileRef: 'issues/07-parallel-isolation.md',
      id: 'demo:blocked-run:7',
    });
  });

  it('derives from a blocked Receipt on a wip issue', () => {
    const { items } = deriveAttention(
      input({ receipts: [receipt(12, 'tile-panes', 'blocked')] }),
    );
    expect(itemsOfKind(items, 'blocked-run')).toHaveLength(1);
  });

  it('disappears once the issue is done', () => {
    const { items } = deriveAttention(
      input({ receipts: [receipt(8, 'merge-runs', 'blocked')] }),
    );
    expect(itemsOfKind(items, 'blocked-run')).toEqual([]);
  });

  it('a Receipt naming an issue not in the backlog degrades to a note, no item', () => {
    const { items, notes } = deriveAttention(
      input({ receipts: [receipt(99, 'ghost', 'blocked')] }),
    );
    expect(itemsOfKind(items, 'blocked-run')).toEqual([]);
    expect(notes.some((n) => n.includes('99'))).toBe(true);
  });
});

describe('setup-gate', () => {
  const HUMAN_SETUP = [
    '# Human setup',
    '',
    '- [ ] **git** on PATH (worktree support). Unblocks: 07, 08.',
    '- [x] **`claude` CLI** installed. Unblocks: 05.',
    '- [ ] Install Obsidian (optional viewer — nothing depends on it).',
    '- [ ] Issue 12 sitting: apply the prepped changes.',
  ].join('\n');

  it('derives one item per unchecked checkbox gating an open/wip issue', () => {
    const { items } = deriveAttention(input({ humanSetup: HUMAN_SETUP }));
    const gates = itemsOfKind(items, 'setup-gate');
    expect(gates).toHaveLength(2); // the git box (gates 07) + the issue-12 box
    expect(gates[0].fileRef).toBe('HUMAN-SETUP.md');
    expect(gates.some((g) => g.text.includes('7'))).toBe(true);
    expect(gates.some((g) => g.text.includes('12'))).toBe(true);
  });

  it('a checked box derives nothing even when it names an open/wip issue', () => {
    const { items } = deriveAttention(
      input({ humanSetup: '- [x] Do the thing. Unblocks: 07.' }),
    );
    expect(itemsOfKind(items, 'setup-gate')).toEqual([]);
  });

  it('an unchecked box naming only done issues derives nothing', () => {
    const { items } = deriveAttention(
      input({ humanSetup: '- [ ] Do the thing. Unblocks: 08.' }),
    );
    expect(itemsOfKind(items, 'setup-gate')).toEqual([]);
  });

  it('an unchecked box naming no issues derives nothing', () => {
    const { items } = deriveAttention(
      input({ humanSetup: '- [ ] Install Obsidian (optional).' }),
    );
    expect(itemsOfKind(items, 'setup-gate')).toEqual([]);
  });

  it('bare numbers in prose (e.g. "Node 22") do not count as issue references', () => {
    const { items } = deriveAttention(
      input({
        backlog: buildBacklog([issueFile('22-something.md', 'open')], null),
        humanSetup: '- [ ] **Node 22** on PATH via nvm.',
      }),
    );
    expect(itemsOfKind(items, 'setup-gate')).toEqual([]);
  });
});

describe('briefing', () => {
  const OLD = journalEntry('2026-06-30.md', '2026-06-30T20:00:00Z', 'backlog drained');
  const NEW = journalEntry('2026-07-02.md', '2026-07-02T21:15:00Z', 'stopped by user');

  it('derives one quiet line per entry newer than last-seen', () => {
    const { items } = deriveAttention(
      input({ journal: [OLD, NEW], lastSeen: '2026-07-01T00:00:00Z' }),
    );
    const briefing = itemsOfKind(items, 'briefing');
    expect(briefing).toHaveLength(1);
    expect(briefing[0]).toMatchObject({
      issueId: null,
      fileRef: 'memory/journal/2026-07-02.md',
      id: 'demo:briefing:2026-07-02.md',
    });
    expect(briefing[0].text).toMatch(/stopped by user/);
  });

  it('a null last-seen means never looked — every entry is new', () => {
    const { items } = deriveAttention(input({ journal: [OLD, NEW], lastSeen: null }));
    expect(itemsOfKind(items, 'briefing')).toHaveLength(2);
  });

  it('entries at or before last-seen derive nothing', () => {
    const { items } = deriveAttention(
      input({ journal: [OLD, NEW], lastSeen: '2026-07-02T21:15:00Z' }),
    );
    expect(itemsOfKind(items, 'briefing')).toEqual([]);
  });

  it('newest entries order first', () => {
    const { items } = deriveAttention(input({ journal: [OLD, NEW], lastSeen: null }));
    const briefing = itemsOfKind(items, 'briefing');
    expect(briefing.map((b) => b.fileRef)).toEqual([
      'memory/journal/2026-07-02.md',
      'memory/journal/2026-06-30.md',
    ]);
  });

  it('non-markdown journal files (.gitkeep) are not entries — no item, no note', () => {
    const { items, notes } = deriveAttention(
      input({ journal: [{ name: '.gitkeep', content: '' }], lastSeen: null }),
    );
    expect(itemsOfKind(items, 'briefing')).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('an entry with no derivable stamp degrades to a note when last-seen is set', () => {
    const undated = { name: 'undated.md', content: 'scrambled\ncontent' };
    const { items, notes } = deriveAttention(
      input({ journal: [undated], lastSeen: '2026-07-01T00:00:00Z' }),
    );
    expect(itemsOfKind(items, 'briefing')).toEqual([]);
    expect(notes.some((n) => n.includes('undated.md'))).toBe(true);
  });
});

describe('stability and degradation', () => {
  it('re-derivation from the same inputs yields identical items (stable ids)', () => {
    const full = input({
      receipts: [
        receipt(5, 'manual-check', 'needs-verification'),
        receipt(7, 'parallel-isolation', 'blocked'),
      ],
      coreProposedPresent: true,
      humanSetup: '- [ ] Prep the sandbox. Unblocks: 12.',
      journal: [journalEntry('2026-07-02.md', '2026-07-02T21:15:00Z', 'drained')],
      lastSeen: null,
    });
    const first = deriveAttention(full);
    const second = deriveAttention(full);
    expect(second).toEqual(first);
    expect(new Set(first.items.map((i) => i.id)).size).toBe(first.items.length);
  });

  it('every item carries the project and a kind-prefixed stable id', () => {
    const { items } = deriveAttention(
      input({
        receipts: [receipt(5, 'manual-check', 'needs-verification')],
        coreProposedPresent: true,
      }),
    );
    for (const item of items) {
      expect(item.project).toBe('demo');
      expect(item.id.startsWith(`demo:${item.kind}`)).toBe(true);
      expect(item.text.includes('\n')).toBe(false);
    }
  });

  it('a Receipt with no readable issue id degrades to a note, never a throw', () => {
    const junk = parseReceipt('total junk, no frontmatter, no block');
    const { items, notes } = deriveAttention(input({ receipts: [junk] }));
    expect(items).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('malformed top-level inputs yield an empty result, never a throw', () => {
    expect(() =>
      deriveAttention({
        project: 'demo',
        backlog: { activePrd: null, workerModel: 'sonnet', escalationCeiling: 'opus', workerEffort: null, issues: [] },
        receipts: null as never,
        coreProposedPresent: false,
        humanSetup: 42 as never,
        journal: null as never,
        lastSeen: null,
      }),
    ).not.toThrow();
  });
});

describe('new-repo-candidate', () => {
  const selfHeal = (partial: Record<string, unknown> = {}) => ({
    workspaceRoot: '/home/dev/Developer/demo',
    entries: [{ name: 'api', isGit: true }],
    repos: {},
    registryContent: null,
    homeDir: '/home/dev',
    ...partial,
  });

  it('derives exactly one item for one appeared, unregistered repo — for the right project', () => {
    const { items, notes } = deriveAttention(input({ selfHeal: selfHeal() }));
    const candidates = itemsOfKind(items, 'new-repo-candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      project: 'demo',
      kind: 'new-repo-candidate',
      issueId: null,
      fileRef: null,
      id: 'demo:new-repo-candidate:api',
      candidate: { path: '/home/dev/Developer/demo/api', name: 'api', suggestedKey: 'api' },
    });
    expect(candidates[0].text).toMatch(/new repo "api" appeared under \/home\/dev\/Developer\/demo/);
    expect(notes).toEqual([]);
  });

  it('produces NO item for an already-registered repo', () => {
    const registered = deriveAttention(
      input({ selfHeal: selfHeal({ repos: { api: '/home/dev/Developer/demo/api' } }) }),
    );
    expect(itemsOfKind(registered.items, 'new-repo-candidate')).toEqual([]);

    const inRegistry = deriveAttention(
      input({
        selfHeal: selfHeal({
          registryContent:
            '- repo: /home/dev/Developer/demo/api\n  project: demo\n  status: active\n',
        }),
      }),
    );
    expect(itemsOfKind(inRegistry.items, 'new-repo-candidate')).toEqual([]);
  });

  it('a non-git subdir under the workspace root produces no item', () => {
    const { items } = deriveAttention(
      input({ selfHeal: selfHeal({ entries: [{ name: 'notes', isGit: false }] }) }),
    );
    expect(itemsOfKind(items, 'new-repo-candidate')).toEqual([]);
  });

  it('no selfHeal input (legacy / pre-0017 project) derives no candidates', () => {
    const { items } = deriveAttention(input());
    expect(itemsOfKind(items, 'new-repo-candidate')).toEqual([]);
    const nulled = deriveAttention(input({ selfHeal: null }));
    expect(itemsOfKind(nulled.items, 'new-repo-candidate')).toEqual([]);
  });

  it('derivation is pure — the same input yields the same items and stable ids', () => {
    const once = deriveAttention(input({ selfHeal: selfHeal() }));
    const twice = deriveAttention(input({ selfHeal: selfHeal() }));
    expect(twice.items).toEqual(once.items);
  });
});

// ===========================================================================
// Cross-project presentation (buildAttentionHub / needs-you / mergeBriefing)
// ===========================================================================

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

describe('buildAttentionHub — grouping + parked-HITL-first urgency', () => {
  it('splits the briefing out and groups actionable items by Project', () => {
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

    const hub = buildAttentionHub(items);
    expect(hub.briefing.map((i) => i.id)).toEqual(['beta:briefing:2026-07-04.md']);
    // beta has the park → it floats above alpha (which has none), regardless of
    // alphabetical order. The top of the list is the right next thing.
    expect(hub.groups.map((g) => g.project)).toEqual(['beta', 'alpha']);
    expect(hub.groups[0].items.map((i) => i.id)).toEqual(['beta:hitl-park:5']);
    expect(hub.groups[1].items.map((i) => i.id)).toEqual([
      'alpha:curator-proposal',
      'alpha:blocked-run:7',
    ]);
  });

  it('orders groups by parked-HITL count desc, then project name asc', () => {
    const items: AttentionItem[] = [
      item({ project: 'zeta', kind: 'blocked-run', id: 'zeta:blocked-run:1', issueId: 1 }),
      item({ project: 'delta', id: 'delta:hitl-park:2', issueId: 2 }),
      item({ project: 'delta', id: 'delta:hitl-park:3', issueId: 3 }),
      item({ project: 'gamma', id: 'gamma:hitl-park:4', issueId: 4 }),
    ];
    const hub = buildAttentionHub(items);
    // delta (2 parks) → gamma (1 park) → zeta (0 parks); the zero-park group
    // sinks below the parked ones even though 'z' sorts last anyway.
    expect(hub.groups.map((g) => g.project)).toEqual(['delta', 'gamma', 'zeta']);
    expect(hub.groups.map((g) => g.parkedHitl)).toEqual([2, 1, 0]);
  });

  it('ties (equal parked-HITL counts) break alphabetically by project', () => {
    const items: AttentionItem[] = [
      item({ project: 'yankee', kind: 'setup-gate', id: 'yankee:setup-gate:x', issueId: 1 }),
      item({ project: 'xray', kind: 'blocked-run', id: 'xray:blocked-run:2', issueId: 2 }),
    ];
    const hub = buildAttentionHub(items);
    expect(hub.groups.map((g) => g.project)).toEqual(['xray', 'yankee']);
  });

  it('preserves the aggregate order within a project (the model already ordered it)', () => {
    const items = [
      item({ id: 'alpha:hitl-park:5', issueId: 5 }),
      item({ kind: 'setup-gate', id: 'alpha:setup-gate:token', issueId: 7 }),
    ];
    expect(buildAttentionHub(items).groups[0].items.map((i) => i.id)).toEqual([
      'alpha:hitl-park:5',
      'alpha:setup-gate:token',
    ]);
  });

  it('degrades non-array / malformed input to an empty hub, never a throw', () => {
    const empty = { briefing: [], groups: [], needsYou: 0 };
    expect(buildAttentionHub(null as unknown as AttentionItem[])).toEqual(empty);
    expect(buildAttentionHub(undefined as unknown as AttentionItem[])).toEqual(empty);
    const junk = [item({}), null, 42, { nope: true }] as unknown as AttentionItem[];
    const hub = buildAttentionHub(junk);
    expect(hub.groups).toHaveLength(1);
    expect(hub.groups[0].items).toHaveLength(1);
  });
});

describe('needs-you counting — the one number everywhere', () => {
  const mixed: AttentionItem[] = [
    item({ project: 'alpha', id: 'alpha:hitl-park:5', issueId: 5 }),
    item({ project: 'alpha', kind: 'blocked-run', id: 'alpha:blocked-run:7', issueId: 7 }),
    item({ project: 'beta', kind: 'curator-proposal', id: 'beta:curator-proposal', issueId: null }),
    item({
      project: 'beta',
      kind: 'briefing',
      id: 'beta:briefing:2026-07-04.md',
      issueId: null,
      fileRef: 'memory/journal/2026-07-04.md',
    }),
  ];

  it('needsYouCount counts actionable items only (the briefing never counts)', () => {
    expect(needsYouCount(mixed)).toBe(3);
    expect(needsYouCount([])).toBe(0);
    expect(needsYouCount(null as unknown as AttentionItem[])).toBe(0);
  });

  it('needsYouByProject gives per-project actionable counts (briefing-only projects absent)', () => {
    const by = needsYouByProject(mixed);
    expect(by.get('alpha')).toBe(2);
    expect(by.get('beta')).toBe(1); // the briefing does not count
  });

  it('the rail total, the surface total, and the per-project counts always agree', () => {
    const hub = buildAttentionHub(mixed);
    const by = needsYouByProject(mixed);
    // Surface total == rail total == sum of per-project counts == sum of groups.
    expect(hub.needsYou).toBe(needsYouCount(mixed));
    expect([...by.values()].reduce((n, v) => n + v, 0)).toBe(needsYouCount(mixed));
    for (const g of hub.groups) expect(g.needsYou).toBe(by.get(g.project));
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
    expect(kindLabel('hitl-park')).toBe('PARKED');
    expect(kindLabel('curator-proposal')).toBe('PROPOSAL');
    expect(kindLabel('blocked-run')).toBe('BLOCKED');
    expect(kindLabel('setup-gate')).toBe('SETUP');
    expect(kindLabel('new-repo-candidate')).toBe('NEW REPO');
    expect(kindLabel('briefing')).toBe('JOURNAL');
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

describe('projectDirNameFromKey — the inverse of workbenchProjectPath (issue 150)', () => {
  it('recovers the directory name when the key sits directly under the root', () => {
    expect(projectDirNameFromKey('/Users/x/Workbench', '/Users/x/Workbench/alpha')).toBe('alpha');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(projectDirNameFromKey('/Users/x/Workbench/', '/Users/x/Workbench/alpha')).toBe('alpha');
  });

  it('is null for a legacy key (a repo path elsewhere, not under the root)', () => {
    expect(projectDirNameFromKey('/Users/x/Workbench', '/Users/x/repo-a')).toBeNull();
  });

  it('is null for a nested path (not a bare directory name) or malformed input', () => {
    expect(projectDirNameFromKey('/Users/x/Workbench', '/Users/x/Workbench/alpha/sub')).toBeNull();
    expect(projectDirNameFromKey('', '/Users/x/Workbench/alpha')).toBeNull();
    expect(projectDirNameFromKey('/Users/x/Workbench', '')).toBeNull();
    expect(projectDirNameFromKey('/Users/x/Workbench', '/Users/x/Workbench/')).toBeNull();
  });

  it('round-trips with workbenchProjectPath', () => {
    const path = workbenchProjectPath('/Users/x/Workbench', 'alpha');
    expect(projectDirNameFromKey('/Users/x/Workbench', path as string)).toBe('alpha');
  });
});

describe('scopeAttentionToWindow — own project first-class, elsewhere collapsed (issue 150)', () => {
  const items: AttentionItem[] = [
    item({ project: 'alpha', id: 'alpha:hitl-park:5', issueId: 5 }),
    item({ project: 'alpha', kind: 'blocked-run', id: 'alpha:blocked-run:7', issueId: 7 }),
    item({ project: 'beta', id: 'beta:hitl-park:1', issueId: 1 }),
    item({ project: 'gamma', kind: 'setup-gate', id: 'gamma:setup-gate:x', issueId: 2 }),
  ];

  it('shows the own project expanded and groups everything else as elsewhere counts', () => {
    const hub = buildAttentionHub(items);
    const view = scopeAttentionToWindow(hub, 'alpha');
    expect(view.own?.project).toBe('alpha');
    expect(view.own?.items.map((i) => i.id)).toEqual(['alpha:hitl-park:5', 'alpha:blocked-run:7']);
    // beta has the park, so it floats first even collapsed — the hub's urgency
    // order carries straight through to the collapsed line.
    expect(view.elsewhere).toEqual([
      { project: 'beta', needsYou: 1 },
      { project: 'gamma', needsYou: 1 },
    ]);
    expect(view.elsewhereTotal).toBe(2);
  });

  it('own is null when the Window project has no actionable items', () => {
    const hub = buildAttentionHub(items);
    const view = scopeAttentionToWindow(hub, 'delta');
    expect(view.own).toBeNull();
    expect(view.elsewhere.map((e) => e.project)).toEqual(['alpha', 'beta', 'gamma']);
    expect(view.elsewhereTotal).toBe(4);
  });

  it('own is null and every group is elsewhere when no project is open (null)', () => {
    const hub = buildAttentionHub(items);
    const view = scopeAttentionToWindow(hub, null);
    expect(view.own).toBeNull();
    expect(view.elsewhere).toHaveLength(3);
    expect(view.elsewhereTotal).toBe(4);
  });

  it('empty states: no items at all yields no own group and no elsewhere', () => {
    const view = scopeAttentionToWindow(buildAttentionHub([]), 'alpha');
    expect(view.own).toBeNull();
    expect(view.elsewhere).toEqual([]);
    expect(view.elsewhereTotal).toBe(0);
  });

  it('elsewhere is empty when the own project is the only one with items', () => {
    const hub = buildAttentionHub([item({ project: 'alpha', id: 'alpha:hitl-park:5', issueId: 5 })]);
    const view = scopeAttentionToWindow(hub, 'alpha');
    expect(view.own?.project).toBe('alpha');
    expect(view.elsewhere).toEqual([]);
    expect(view.elsewhereTotal).toBe(0);
  });
});

// ===========================================================================
// Curator reports — report-file → item mapping + seen-state (issue 151)
// ===========================================================================

const reportFile = (name: string, frontmatter: string): CuratorReportFile => ({
  name,
  content: `---\n${frontmatter}\n---\n# Curator pass\n\nbody`,
});

describe('deriveCuratorReportItems — report-file → item summary mapping', () => {
  it('derives one item per unseen report, summarizing outcome + proposal count', () => {
    const items = deriveCuratorReportItems(
      [reportFile('2026-07-17.md', 'outcome: defects-found\nproposals: 2\nfinished: 2026-07-17T14:57:52Z')],
      new Set(),
    );
    expect(items).toEqual([
      {
        project: 'tools',
        kind: 'curator-report',
        issueId: null,
        fileRef: 'tools/curator-reports/2026-07-17.md',
        text: 'curator pass 2026-07-17 — defects-found · 2 proposals',
        id: 'curator-report:2026-07-17.md',
      },
    ]);
  });

  it('singular "proposal" for exactly one, and omits the count entirely for zero', () => {
    const [one] = deriveCuratorReportItems(
      [reportFile('2026-07-05.md', 'outcome: clean\nproposals: 1')],
      new Set(),
    );
    expect(one.text).toBe('curator pass 2026-07-05 — clean · 1 proposal');

    const [zero] = deriveCuratorReportItems(
      [reportFile('2026-07-05.md', 'outcome: clean\nproposals: 0')],
      new Set(),
    );
    expect(zero.text).toBe('curator pass 2026-07-05 — clean');
  });

  it('a seen report name is excluded — the seen-once-opened rule', () => {
    const files = [
      reportFile('2026-07-05.md', 'outcome: clean\nproposals: 0'),
      reportFile('2026-07-17.md', 'outcome: defects-found\nproposals: 2'),
    ];
    const items = deriveCuratorReportItems(files, new Set(['2026-07-05.md']));
    expect(items.map((i) => i.id)).toEqual(['curator-report:2026-07-17.md']);
  });

  it('orders newest report first (by file name)', () => {
    const items = deriveCuratorReportItems(
      [reportFile('2026-07-05.md', 'outcome: clean'), reportFile('2026-07-17.md', 'outcome: clean')],
      new Set(),
    );
    expect(items.map((i) => i.fileRef)).toEqual([
      'tools/curator-reports/2026-07-17.md',
      'tools/curator-reports/2026-07-05.md',
    ]);
  });

  it('a non-.md file (the curator\'s log files) never derives an item', () => {
    const items = deriveCuratorReportItems(
      [{ name: 'launchd.log', content: 'outcome: clean' }],
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it('malformed/missing frontmatter degrades to a generic label, never a throw', () => {
    const items = deriveCuratorReportItems([{ name: '2026-07-17.md', content: 'no frontmatter here' }], new Set());
    expect(items[0].text).toBe('curator pass 2026-07-17 — unknown outcome');
  });

  it('is total against junk input: non-array, null entries, missing fields', () => {
    // @ts-expect-error deliberately malformed input — must never throw
    expect(deriveCuratorReportItems(null, new Set())).toEqual([]);
    expect(deriveCuratorReportItems([null as unknown as CuratorReportFile], new Set())).toEqual([]);
  });

  it('kindLabel renders the curator-report badge text', () => {
    expect(kindLabel('curator-report')).toBe('REPORT');
  });
});

describe('curator-report seen-state transitions', () => {
  it('parseSeenReports: missing/empty content is the empty list (everything unseen)', () => {
    expect(parseSeenReports(null)).toEqual([]);
    expect(parseSeenReports('')).toEqual([]);
  });

  it('parseSeenReports: junk JSON or a non-array degrades to empty', () => {
    expect(parseSeenReports('not json')).toEqual([]);
    expect(parseSeenReports('{"a":1}')).toEqual([]);
  });

  it('parseSeenReports: filters non-string / empty-string entries', () => {
    expect(parseSeenReports(JSON.stringify(['a.md', 42, '', null, 'b.md']))).toEqual(['a.md', 'b.md']);
  });

  it('markReportSeen: adds a new name, is idempotent, and dedupes existing input', () => {
    expect(markReportSeen([], '2026-07-17.md')).toEqual(['2026-07-17.md']);
    expect(markReportSeen(['2026-07-17.md'], '2026-07-17.md')).toEqual(['2026-07-17.md']);
    expect(markReportSeen(['a.md', 'a.md', 'b.md'], 'c.md').sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('markReportSeen: a blank/non-string name is a no-op (still deduped)', () => {
    expect(markReportSeen(['a.md', 'a.md'], '')).toEqual(['a.md']);
  });

  it('serializeSeenReports: sorted, deduped, parses back to the same set', () => {
    const serialized = serializeSeenReports(['b.md', 'a.md', 'a.md']);
    expect(parseSeenReports(serialized)).toEqual(['a.md', 'b.md']);
  });

  it('round-trips through a full mark → serialize → parse cycle', () => {
    let names = parseSeenReports(null);
    names = markReportSeen(names, '2026-07-05.md');
    const serialized = serializeSeenReports(names);
    expect(parseSeenReports(serialized)).toEqual(['2026-07-05.md']);
  });
});

// ===========================================================================
// Debrief affordance — once-per-drain offer decision (issue 152)
// ===========================================================================

describe('debrief affordance — once-per-journal-entry offer', () => {
  it('a new journal-entry key offers the affordance', () => {
    expect(shouldOfferDebrief('mission-control:2026-07-18.md', new Set())).toBe(true);
  });

  it('a seen journal-entry key never offers again', () => {
    expect(
      shouldOfferDebrief('mission-control:2026-07-18.md', new Set(['mission-control:2026-07-18.md'])),
    ).toBe(false);
  });

  it('a blank key never offers — no journal entry landed, nothing to debrief', () => {
    expect(shouldOfferDebrief('', new Set())).toBe(false);
  });

  it('markDebriefSeen: adds a new key, is idempotent, and dedupes existing input', () => {
    expect(markDebriefSeen([], 'a:2026-07-18.md')).toEqual(['a:2026-07-18.md']);
    expect(markDebriefSeen(['a:2026-07-18.md'], 'a:2026-07-18.md')).toEqual(['a:2026-07-18.md']);
    expect(markDebriefSeen(['a', 'a', 'b'], 'c').sort()).toEqual(['a', 'b', 'c']);
  });

  it('markDebriefSeen: a blank/non-string key is a no-op (still deduped)', () => {
    expect(markDebriefSeen(['a', 'a'], '')).toEqual(['a']);
  });

  it('round-trips through mark → serialize → parse, and the offer decision flips', () => {
    const key = 'mission-control:2026-07-18.md';
    let seen = parseSeenDebriefs(null);
    expect(shouldOfferDebrief(key, new Set(seen))).toBe(true);
    seen = markDebriefSeen(seen, key);
    const serialized = serializeSeenDebriefs(seen);
    const reparsed = parseSeenDebriefs(serialized);
    expect(reparsed).toEqual([key]);
    expect(shouldOfferDebrief(key, new Set(reparsed))).toBe(false);
  });
});
