/**
 * Unit tests for the PURE attention model (issue 78, ADR-0016).
 *
 * The model turns one project's workbench artifacts — the parsed backlog,
 * parsed Receipts, memory/HUMAN-SETUP/journal facts — into typed attention
 * items: what needs the human. Decision-table style: each kind derives from
 * fixture inputs, holds a stable id across re-derivation, and disappears when
 * resolved. House PURE contract: no I/O, any input yields a value, never a
 * throw; malformed artifacts degrade to no item + an explicit note.
 */
import { describe, it, expect } from 'vitest';
import { buildBacklog, type Backlog } from './backlog-model';
import { parseReceipt, type ReceiptRecord } from './receipt-parser';
import {
  deriveAttention,
  type AttentionInput,
  type AttentionItem,
} from './attention-model';

// ---------------------------------------------------------------------------
// Fixtures — a small backlog with the shapes the five kinds key on, built
// through the real backlog model (the same parsed values issue 79's adapter
// will hand over).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (a) hitl-park — an hitl issue at wip whose latest Receipt declares
// needs-verification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (b) curator-proposal — memory/CORE.proposed.md present
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (c) blocked-run — latest Receipt declares blocked while the issue isn't done
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (d) setup-gate — an unchecked HUMAN-SETUP checkbox naming an open/wip issue
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (e) briefing — journal entries newer than the caller's last-seen stamp
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stability, ordering, and the never-throw contract
// ---------------------------------------------------------------------------

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
        backlog: { activePrd: null, issues: [] },
        receipts: null as never,
        coreProposedPresent: false,
        humanSetup: 42 as never,
        journal: null as never,
        lastSeen: null,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (f) new-repo-candidate — a git repo appeared under the workspace root but is
// not yet registered (issue 95, ADR-0017). The pure self-heal detector decides
// candidacy; the model shapes it into an item and writes NOTHING to disk.
// ---------------------------------------------------------------------------

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
