import { describe, expect, it } from 'vitest';
import {
  buildQuickFixIssue,
  nextIssueNumber,
  padIssueNumber,
  projectStateLine,
  quickFixFileName,
  quickFixSlug,
  sortLauncherProjects,
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
