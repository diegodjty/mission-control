import { describe, expect, it } from 'vitest';
import {
  buildQuickFixIssue,
  localDateStamp,
  nextIssueNumber,
  padIssueNumber,
  projectStateLine,
  quickFixDefaultDir,
  quickFixFileName,
  quickFixRunTarget,
  quickFixSlug,
  sortLauncherProjects,
  workbenchProjectNames,
} from './launcher-model';
import { buildBacklog } from './backlog-model';

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
