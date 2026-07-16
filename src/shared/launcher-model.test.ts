import { describe, expect, it } from 'vitest';
import {
  buildProjectGrid,
  buildQuickFixIssue,
  cardCountsLabel,
  livenessLabel,
  localDateStamp,
  nextIssueNumber,
  normalizeProjectView,
  orderProjectCards,
  padIssueNumber,
  PROJECT_VIEW_KEY,
  projectStateLine,
  quickFixDefaultDir,
  quickFixFileName,
  quickFixRunTarget,
  quickFixSlug,
  relativeActivityLabel,
  sortLauncherProjects,
  stageBadgeLabel,
  STAGE_LABELS,
  START_VERB_LABELS,
  startSomething,
  workbenchProjectNames,
  type ProjectCardSignals,
} from './launcher-model';
import { buildBacklog } from './backlog-model';
import type { LauncherProject } from './ipc-contract';

/** Idle signals (no live Runs, no parks, default stage, repo-backed). */
const IDLE: ProjectCardSignals = {
  liveRuns: 0,
  parkedHitl: 0,
  needsYou: 0,
  stage: 'backlog',
  repoless: false,
};

describe('nextIssueNumber', () => {
  it('is 1 for an empty directory', () => {
    expect(nextIssueNumber([])).toBe(1);
  });

  it('is one past the highest NN prefix', () => {
    expect(nextIssueNumber(['01-a.md', '03-b.md', '02-c.md'])).toBe(4);
  });

  it('never reuses a gap — numbers are history', () => {
    expect(nextIssueNumber(['01-a.md', '07-b.md'])).toBe(8);
  });

  it('ignores non-issue files (CONFIG, HUMAN-SETUP, dirs, dotfiles)', () => {
    expect(
      nextIssueNumber(['CONFIG.md', 'HUMAN-SETUP.md', 'completions', '.afk-parallel', '05-x.md']),
    ).toBe(6);
  });

  it('handles 3-digit ids', () => {
    expect(nextIssueNumber(['99-a.md', '112-b.md'])).toBe(113);
  });
});

describe('quickFixSlug / quickFixFileName', () => {
  it('lowercases and dashes a plain sentence', () => {
    expect(quickFixSlug('Fix the header flicker')).toBe('fix-the-header-flicker');
  });

  it('collapses punctuation and caps the word count', () => {
    expect(quickFixSlug("Don't re-render the whole Map on every single poll tick!!")).toBe(
      'don-t-re-render-the-whole',
    );
  });

  it('degrades to quick-fix when nothing usable remains', () => {
    expect(quickFixSlug('¡¡¡···!!!')).toBe('quick-fix');
    expect(quickFixSlug('')).toBe('quick-fix');
  });

  it('builds the padded NN-slug.md file name', () => {
    expect(quickFixFileName(7, 'Fix the thing')).toBe('07-fix-the-thing.md');
    expect(quickFixFileName(112, 'Fix the thing')).toBe('112-fix-the-thing.md');
  });

  it('pads issue numbers to at least two digits', () => {
    expect(padIssueNumber(5)).toBe('05');
    expect(padIssueNumber(112)).toBe('112');
  });
});

describe('buildQuickFixIssue', () => {
  const content = buildQuickFixIssue({
    id: 87,
    sentence: 'Make the drain message dismissible',
    date: '2026-07-05',
  });

  it('round-trips through the backlog model as a well-formed STANDALONE open issue', () => {
    const backlog = buildBacklog(
      [{ name: '87-make-the-drain-message-dismissible.md', content }],
      null,
    );
    expect(backlog.issues).toHaveLength(1);
    const issue = backlog.issues[0];
    expect(issue.id).toBe(87);
    expect(issue.status).toBe('open');
    expect(issue.dependsOn).toEqual([]);
    expect(issue.standalone).toBe(true); // no ## Parent section
    expect(issue.parent).toBeNull();
    expect(issue.source).toContain('Launcher quick fix, 2026-07-05');
    expect(issue.hitl).toBe(false);
    expect(issue.title).toBe('87 — Make the drain message dismissible');
  });

  it('collapses newlines in the sentence — the heading stays one line', () => {
    const multi = buildQuickFixIssue({ id: 3, sentence: 'fix\nthe\nthing', date: '2026-07-05' });
    expect(multi).toContain('# 03 — fix the thing');
  });
});

// Issue 88 (walkthrough-86 finding): the issue was created in project A, but
// Run-now rebuilt its paths from the WINDOW's active project (B) — the Run
// spawned with B's repo + workbench and the Worker rightly refused. The Run
// target must carry the CREATED issue's project identity end-to-end.
describe('quickFixRunTarget', () => {
  const projectA = {
    defaultRepoPath: '/Users/dev/Developer/repo-a',
    issuesRoot: '/Users/dev/Workbench/project-a/issues',
    completionsRoot: '/Users/dev/Workbench/project-a/completions',
  };

  it("builds the Run entirely from the created issue's project — create-in-A always spawns with A's repo and workbench paths", () => {
    const target = quickFixRunTarget(projectA, {
      issueId: 7,
      fileName: '07-this-is-the-quick-fix-test.md',
      title: '07 — this is the quick fix test',
    });
    expect(target).toEqual({
      issueId: 7,
      issueFileName: '07-this-is-the-quick-fix-test.md',
      issueTitle: '07 — this is the quick fix test',
      projectPath: '/Users/dev/Developer/repo-a',
      workbench: {
        issuesRoot: '/Users/dev/Workbench/project-a/issues',
        completionsRoot: '/Users/dev/Workbench/project-a/completions',
      },
    });
  });

  it('has no window-active input at all — the identity mismatch is unrepresentable', () => {
    // The signature is the regression guard: nothing about the Window's
    // active project can reach the target. Assert the paths verbatim.
    const target = quickFixRunTarget(projectA, { issueId: 1, fileName: '01-x.md', title: '01 — x' });
    expect(target.projectPath).toBe(projectA.defaultRepoPath);
    expect(target.workbench).toEqual({
      issuesRoot: projectA.issuesRoot,
      completionsRoot: projectA.completionsRoot,
    });
  });
});

// Issue 116 (ADR-0019): ＋ Start something relocates the two per-Project entry
// verbs onto the Map. The pure resolver routes each verb to the EXISTING
// machinery and carries the project through — no window-active state, no new
// flow. The labels must be exactly the ADR's wording.
describe('startSomething (verb → target routing)', () => {
  const project = { workbenchDir: '/Users/dev/Workbench/proj', label: 'Proj' };

  it('routes "Grill a feature" to the Planning view', () => {
    const target = startSomething('grill', project);
    expect(target.route).toBe('planning');
    expect(target.label).toBe('Grill a feature');
    expect(target.project).toBe(project); // carried through, identity preserved
  });

  it('routes "Simple issue" to the quick-fix form', () => {
    const target = startSomething('simple', project);
    expect(target.route).toBe('quick-fix');
    expect(target.label).toBe('Simple issue');
    expect(target.project).toBe(project);
  });

  it('uses the exact ADR-0019 labels for both verbs', () => {
    expect(START_VERB_LABELS).toEqual({
      grill: 'Grill a feature',
      simple: 'Simple issue',
    });
  });
});

// Issue 88: the Quick fix dropdown silently defaulted to `projects[0]` — the
// issue landed in whatever sorted first. The default must be the project the
// user is visibly on, or nothing (forcing an explicit pick before submit).
describe('quickFixDefaultDir', () => {
  const projects = [
    { workbenchDir: '/Users/dev/Workbench/qa-sandbox' },
    { workbenchDir: '/Users/dev/Workbench/mission-control' },
  ];

  it("defaults to the Window's open project — never projects[0]", () => {
    expect(quickFixDefaultDir(projects, '/Users/dev/Workbench/mission-control')).toBe(
      '/Users/dev/Workbench/mission-control',
    );
  });

  it('is empty when the Window has no project open — an explicit pick is required', () => {
    expect(quickFixDefaultDir(projects, null)).toBe('');
  });

  it("is empty when the Window's project is not a listed workbench project (legacy repo)", () => {
    expect(quickFixDefaultDir(projects, '/Users/dev/Developer/legacy-repo')).toBe('');
  });

  it('is empty for an empty project list', () => {
    expect(quickFixDefaultDir([], '/Users/dev/Workbench/mission-control')).toBe('');
  });
});

// Issue 88 (cosmetic): the `## Source` line stamped the UTC date — an evening
// quick fix landed "tomorrow". The stamp must be the user's local calendar day.
describe('localDateStamp', () => {
  it('formats the LOCAL calendar day, zero-padded', () => {
    // Constructed via local-time parts, so these hold in every timezone.
    expect(localDateStamp(new Date(2026, 6, 4, 12, 0, 0))).toBe('2026-07-04');
    expect(localDateStamp(new Date(2026, 0, 9, 3, 4, 5))).toBe('2026-01-09');
  });

  it('stays on the local day at both edges of midnight (where a UTC stamp drifts)', () => {
    // 00:05 local (a UTC-slice stamp is YESTERDAY in zones ahead of UTC) and
    // 23:55 local (a UTC-slice stamp is TOMORROW in zones behind UTC).
    expect(localDateStamp(new Date(2026, 6, 4, 0, 5, 0))).toBe('2026-07-04');
    expect(localDateStamp(new Date(2026, 6, 4, 23, 55, 0))).toBe('2026-07-04');
  });
});

describe('workbenchProjectNames', () => {
  it('unions registry-active projects with workbench project directories', () => {
    expect(workbenchProjectNames(['billing', 'atlas'], ['atlas', 'billing'])).toEqual([
      'atlas',
      'billing',
    ]);
  });

  it('includes a repo-less project present as a directory but absent from the registry', () => {
    // The issue-99 bug: New project wrote ~/Workbench/repoless-qa but no
    // registry entry (ADR-0017 defers registration), so a registry-only list
    // hid it even though its directory exists.
    expect(workbenchProjectNames(['billing'], ['billing', 'repoless-qa'])).toEqual([
      'billing',
      'repoless-qa',
    ]);
  });

  it('dedupes a project that is both registered and on disk', () => {
    expect(workbenchProjectNames(['billing', 'billing'], ['billing'])).toEqual(['billing']);
  });

  it('still lists a registered project whose directory listing was unreadable', () => {
    expect(workbenchProjectNames(['billing'], [])).toEqual(['billing']);
  });

  it('ignores empty/non-string names from either source', () => {
    expect(workbenchProjectNames(['', 'billing'], ['', 'repoless-qa'])).toEqual([
      'billing',
      'repoless-qa',
    ]);
  });

  it('returns an ascending, deterministic set', () => {
    expect(workbenchProjectNames(['zed', 'alpha'], ['mid'])).toEqual(['alpha', 'mid', 'zed']);
  });
});

describe('projectStateLine', () => {
  it('names the non-zero facts, parked called out for the human', () => {
    expect(projectStateLine({ open: 3, wip: 1, done: 10 }, 1)).toBe(
      '3 open · 1 wip · 1 parked awaiting you',
    );
  });

  it('omits zero parts', () => {
    expect(projectStateLine({ open: 5, wip: 0, done: 0 }, 0)).toBe('5 open');
  });

  it('says all done when nothing is open or in flight', () => {
    expect(projectStateLine({ open: 0, wip: 0, done: 7 }, 0)).toBe('all 7 done');
  });

  it('says empty backlog when there are no issues at all', () => {
    expect(projectStateLine({ open: 0, wip: 0, done: 0 }, 0)).toBe('empty backlog');
  });
});

describe('sortLauncherProjects', () => {
  it('orders most-recently-active first, no-activity last alphabetically', () => {
    const sorted = sortLauncherProjects([
      { label: 'b-quiet', lastActivity: null },
      { label: 'old', lastActivity: '2026-06-01T00:00:00Z' },
      { label: 'fresh', lastActivity: '2026-07-05T12:00:00Z' },
      { label: 'a-quiet', lastActivity: null },
    ]);
    expect(sorted.map((p) => p.label)).toEqual(['fresh', 'old', 'a-quiet', 'b-quiet']);
  });

  it('does not mutate its input', () => {
    const input = [
      { label: 'x', lastActivity: null },
      { label: 'y', lastActivity: '2026-07-01T00:00:00Z' },
    ];
    const copy = [...input];
    sortLauncherProjects(input);
    expect(input).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Project grid — the project-first home (issue 115, ADR-0019)
// ---------------------------------------------------------------------------

describe('cardCountsLabel', () => {
  it('names ALL THREE counts, even zeros (a card is an at-a-glance tally)', () => {
    expect(cardCountsLabel({ open: 3, wip: 1, done: 8 })).toBe('3 open · 1 wip · 8 done');
    // Unlike projectStateLine, a card does NOT hide zeros — "0 open · 0 wip ·
    // 0 done" is a truthful "nothing here yet", not an omitted fact.
    expect(cardCountsLabel({ open: 0, wip: 0, done: 0 })).toBe('0 open · 0 wip · 0 done');
  });

  it('clamps negatives and defaults absent fields to zero (pure, never throws)', () => {
    expect(cardCountsLabel({ open: -1, wip: 2, done: -3 })).toBe('0 open · 2 wip · 0 done');
    expect(cardCountsLabel({} as { open: number; wip: number; done: number })).toBe(
      '0 open · 0 wip · 0 done',
    );
  });
});

describe('relativeActivityLabel', () => {
  const now = new Date('2026-07-10T12:00:00Z');

  it('degrades a null / empty / unparseable stamp to a quiet fallback', () => {
    expect(relativeActivityLabel(null, now)).toBe('no activity yet');
    expect(relativeActivityLabel('', now)).toBe('no activity yet');
    expect(relativeActivityLabel('not-a-date', now)).toBe('no activity yet');
  });

  it('reads sub-minute and clock-skewed (future) stamps as "just now"', () => {
    expect(relativeActivityLabel('2026-07-10T11:59:30Z', now)).toBe('just now');
    expect(relativeActivityLabel('2026-07-10T12:00:00Z', now)).toBe('just now');
    expect(relativeActivityLabel('2026-07-10T12:05:00Z', now)).toBe('just now'); // future
  });

  it('steps through minutes → hours → days → weeks → months → years', () => {
    expect(relativeActivityLabel('2026-07-10T11:55:00Z', now)).toBe('5m ago');
    expect(relativeActivityLabel('2026-07-10T10:30:00Z', now)).toBe('1h ago');
    expect(relativeActivityLabel('2026-07-09T11:00:00Z', now)).toBe('1d ago'); // 25h
    expect(relativeActivityLabel('2026-07-02T12:00:00Z', now)).toBe('1w ago'); // 8d
    expect(relativeActivityLabel('2026-05-31T12:00:00Z', now)).toBe('1mo ago'); // 40d
    expect(relativeActivityLabel('2025-06-05T12:00:00Z', now)).toBe('1y ago'); // ~400d
  });
});

// ---------------------------------------------------------------------------
// Full card stats — needs-you / liveness / stage / attention-float (issue 118)
// ---------------------------------------------------------------------------

describe('livenessLabel', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const empty = { open: 0, wip: 0, done: 0 };

  it('reads "N running" the moment there is at least one live Run', () => {
    expect(
      livenessLabel({ liveRuns: 1, counts: empty, lastActivity: null, repoless: false, now }),
    ).toBe('1 running');
    expect(
      livenessLabel({
        liveRuns: 3,
        counts: { open: 2, wip: 3, done: 5 },
        lastActivity: '2026-07-10T11:55:00Z',
        repoless: false,
        now,
      }),
    ).toBe('3 running');
  });

  it('says "not started" for a repo-less project with an empty backlog (idle)', () => {
    expect(
      livenessLabel({ liveRuns: 0, counts: empty, lastActivity: null, repoless: true, now }),
    ).toBe('not started');
  });

  it('does NOT say "not started" once a repo-less project has any backlog', () => {
    expect(
      livenessLabel({
        liveRuns: 0,
        counts: { open: 1, wip: 0, done: 0 },
        lastActivity: null,
        repoless: true,
        now,
      }),
    ).toBe('no activity yet');
  });

  it('shows the relative last-activity for an idle repo-backed project', () => {
    expect(
      livenessLabel({
        liveRuns: 0,
        counts: { open: 1, wip: 0, done: 4 },
        lastActivity: '2026-07-10T11:55:00Z',
        repoless: false,
        now,
      }),
    ).toBe('5m ago');
    // A repo-backed but empty backlog is idle, not "not started".
    expect(
      livenessLabel({ liveRuns: 0, counts: empty, lastActivity: null, repoless: false, now }),
    ).toBe('no activity yet');
  });

  it('running beats "not started" even for a repo-less empty project (total, clamps negatives)', () => {
    expect(
      livenessLabel({ liveRuns: 2, counts: empty, lastActivity: null, repoless: true, now }),
    ).toBe('2 running');
    // A negative/absent live count clamps to zero — never "-1 running".
    expect(
      livenessLabel({ liveRuns: -1, counts: empty, lastActivity: null, repoless: true, now }),
    ).toBe('not started');
  });
});

describe('stageBadgeLabel / STAGE_LABELS', () => {
  it('labels every pipeline stage', () => {
    expect(STAGE_LABELS).toEqual({
      planning: 'Planning',
      backlog: 'Backlog',
      executing: 'Executing',
      'merge-qa': 'Merge / QA',
    });
    expect(stageBadgeLabel('planning')).toBe('Planning');
    expect(stageBadgeLabel('executing')).toBe('Executing');
  });

  it('degrades an unknown stage to an empty label (pure, never throws)', () => {
    expect(stageBadgeLabel('nonsense' as never)).toBe('');
  });
});

describe('normalizeProjectView / PROJECT_VIEW_KEY (issue 119 — persisted view mode)', () => {
  it("selects 'list' only for the exact 'list' value", () => {
    expect(normalizeProjectView('list')).toBe('list');
  });

  it("keeps the explicit 'cards' value", () => {
    expect(normalizeProjectView('cards')).toBe('cards');
  });

  it("defaults to 'cards' when unset (null) — cards is the first-run default", () => {
    expect(normalizeProjectView(null)).toBe('cards');
  });

  it("defaults to 'cards' for empty / unknown / legacy / mis-cased values", () => {
    expect(normalizeProjectView('')).toBe('cards');
    expect(normalizeProjectView('grid')).toBe('cards');
    expect(normalizeProjectView('LIST')).toBe('cards');
    expect(normalizeProjectView(undefined)).toBe('cards');
  });

  it('persists under the mc.theme-style key', () => {
    expect(PROJECT_VIEW_KEY).toBe('mc.projectView');
  });
});

describe('orderProjectCards (attention-float, issue 118)', () => {
  const card = (over: Partial<Parameters<typeof orderProjectCards>[0][number]>) => ({
    label: 'x',
    lastActivity: null,
    liveRuns: 0,
    parkedHitl: 0,
    ...over,
  });

  it('floats live Runs to the very top, above parks and recency', () => {
    const ordered = orderProjectCards([
      card({ label: 'freshest', lastActivity: '2026-07-10T12:00:00Z' }),
      card({ label: 'parked', parkedHitl: 4, lastActivity: '2026-01-01T00:00:00Z' }),
      card({ label: 'running', liveRuns: 1, lastActivity: '2020-01-01T00:00:00Z' }),
    ]);
    expect(ordered.map((c) => c.label)).toEqual(['running', 'parked', 'freshest']);
  });

  it('orders by live Runs desc, then parked HITL desc', () => {
    const ordered = orderProjectCards([
      card({ label: 'run1', liveRuns: 1 }),
      card({ label: 'run3', liveRuns: 3 }),
      card({ label: 'park2', parkedHitl: 2 }),
      card({ label: 'park5', parkedHitl: 5 }),
    ]);
    expect(ordered.map((c) => c.label)).toEqual(['run3', 'run1', 'park5', 'park2']);
  });

  it('breaks live/park ties by recency desc, then label asc (nulls last)', () => {
    const ordered = orderProjectCards([
      card({ label: 'b-quiet', lastActivity: null }),
      card({ label: 'old', lastActivity: '2026-06-01T00:00:00Z' }),
      card({ label: 'fresh', lastActivity: '2026-07-05T12:00:00Z' }),
      card({ label: 'a-quiet', lastActivity: null }),
    ]);
    // With no live Runs and no parks, the float order degrades to the recency
    // sort — the exact behavior issue 115 shipped.
    expect(ordered.map((c) => c.label)).toEqual(['fresh', 'old', 'a-quiet', 'b-quiet']);
  });

  it('does not mutate its input', () => {
    const input = [card({ label: 'x', liveRuns: 1 }), card({ label: 'y' })];
    const copy = [...input];
    orderProjectCards(input);
    expect(input).toEqual(copy);
  });
});

// The aggregator join (issue 118): the portfolio aggregator gathers each
// project's signals (backlog counts + last-activity from listLauncherProjects,
// PLUS the joined live-Run / parked-HITL / stage / repoless signals) and
// delegates ALL shaping + ordering to the pure card model. `buildProjectGrid`
// IS that delegation — this exercises it across a mid-drain Project, an idle
// Project, and a repo-less/empty Project, standing in for the aggregator join.
describe('buildProjectGrid', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const project = (over: Partial<LauncherProject>): LauncherProject => ({
    dirName: 'p',
    label: 'P',
    workbenchDir: '/Users/dev/Workbench/p',
    defaultRepoPath: '/Users/dev/Developer/p',
    issuesRoot: '/Users/dev/Workbench/p/issues',
    completionsRoot: '/Users/dev/Workbench/p/completions',
    counts: { open: 0, wip: 0, done: 0 },
    lastActivity: null,
    ...over,
  });

  // idle billing (repo-backed, 5m ago), a mid-drain project (2 live Runs, 1
  // parked HITL), and a brand-new repo-less project with an empty backlog.
  const fixtures: LauncherProject[] = [
    project({
      dirName: 'billing',
      label: 'Billing',
      workbenchDir: '/w/billing',
      counts: { open: 3, wip: 1, done: 8 },
      lastActivity: '2026-07-10T11:55:00Z', // 5m ago
    }),
    project({
      dirName: 'atlas',
      label: 'Atlas',
      workbenchDir: '/w/atlas',
      counts: { open: 2, wip: 2, done: 12 },
      lastActivity: '2026-07-10T09:00:00Z', // 3h ago
    }),
    project({
      dirName: 'newthing',
      label: 'Newthing',
      workbenchDir: '/w/newthing',
      counts: { open: 0, wip: 0, done: 0 },
      lastActivity: null,
    }),
  ];

  const signals: Record<string, ProjectCardSignals> = {
    // billing: 1 parked HITL + 1 more actionable item ⇒ needsYou 2 (needs-you
    // is the full actionable set, not just parks — issue 125).
    '/w/billing': { liveRuns: 0, parkedHitl: 1, needsYou: 2, stage: 'backlog', repoless: false },
    // atlas: no parks but one actionable item (e.g. a blocked run) ⇒ needsYou 1.
    '/w/atlas': { liveRuns: 2, parkedHitl: 0, needsYou: 1, stage: 'executing', repoless: false },
    '/w/newthing': { liveRuns: 0, parkedHitl: 0, needsYou: 0, stage: 'planning', repoless: true },
  };
  const signalsFor = (p: LauncherProject): ProjectCardSignals => signals[p.workbenchDir] ?? IDLE;

  const cards = buildProjectGrid(fixtures, signalsFor, now);

  it('floats the mid-drain Project first (live Runs), then the parked one, then idle', () => {
    // atlas: 2 running → top. billing: 1 parked → next. newthing: idle → last.
    expect(cards.map((c) => c.label)).toEqual(['Atlas', 'Billing', 'Newthing']);
  });

  it('shapes the liveness label per project (running / relative / not started)', () => {
    const [atlas, billing, newthing] = cards;
    expect(atlas.livenessLabel).toBe('2 running');
    expect(billing.livenessLabel).toBe('5m ago');
    expect(newthing.livenessLabel).toBe('not started');
  });

  it('carries the parked-HITL ordering tier, the needs-you badge count, and the stage badge', () => {
    const [atlas, billing, newthing] = cards;
    // parkedHitl stays the parks-only ordering tier (issue 118)...
    expect(billing.parkedHitl).toBe(1);
    expect(atlas.parkedHitl).toBe(0);
    // ...while needsYou is the full actionable count the badge shows (issue 125),
    // distinct from parkedHitl — atlas has a needs-you item with zero parks.
    expect(billing.needsYou).toBe(2);
    expect(atlas.needsYou).toBe(1);
    expect(newthing.needsYou).toBe(0);
    expect(atlas.liveRuns).toBe(2);
    expect(atlas.stage).toBe('executing');
    expect(atlas.stageLabel).toBe('Executing');
    expect(billing.stageLabel).toBe('Backlog');
    expect(newthing.stageLabel).toBe('Planning');
  });

  it('still shapes the open·wip·done tally and keeps activityLabel (issue 115)', () => {
    const billing = cards.find((c) => c.label === 'Billing')!;
    expect(billing.countsLabel).toBe('3 open · 1 wip · 8 done');
    expect(billing.activityLabel).toBe('5m ago');
  });

  it('is a superset of LauncherProject — the card carries the raw open handle', () => {
    // The renderer clicks a card and hands `workbenchDir` to the in-place switch.
    const atlas = cards[0];
    expect(atlas.workbenchDir).toBe('/w/atlas');
    expect(atlas.dirName).toBe('atlas');
    expect(atlas.lastActivity).toBe('2026-07-10T09:00:00Z');
  });

  it('is total — an empty portfolio yields an empty grid, never a throw', () => {
    expect(buildProjectGrid([], signalsFor, now)).toEqual([]);
  });
});
