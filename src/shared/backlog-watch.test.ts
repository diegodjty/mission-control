import { describe, it, expect } from 'vitest';
import { isRelevantChange, backlogChanged } from './backlog-watch';
import type { Backlog, BacklogIssue, IssueStatus } from './backlog-model';

/** Minimal issue factory — only the fields the watch diff reads. */
function mk(id: number, status: IssueStatus, over: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue ${id}`,
    status,
    dependsOn: [],
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    touches: [],
    inBatch: true,
    standalone: false,
    body: 'body',
    ...over,
  };
}

function backlog(issues: BacklogIssue[], activePrd: string | null = 'docs/PRD.md'): Backlog {
  return { activePrd, workerModel: 'sonnet', escalationCeiling: 'opus', workerEffort: null, runTimeoutMinutes: 30, hotFiles: [], issues };
}

describe('isRelevantChange', () => {
  it('reloads for issue markdown files', () => {
    expect(isRelevantChange('05-live-map-updates.md')).toBe(true);
  });

  it('reloads for CONFIG.md (active PRD affects classification)', () => {
    expect(isRelevantChange('CONFIG.md')).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isRelevantChange('07-Thing.MD')).toBe(true);
  });

  it('ignores non-markdown noise (swap files, .DS_Store)', () => {
    expect(isRelevantChange('.DS_Store')).toBe(false);
    expect(isRelevantChange('05-live-map-updates.md.swp')).toBe(false);
  });

  it('reloads when the platform gives no filename (err toward safety)', () => {
    expect(isRelevantChange(null)).toBe(true);
    expect(isRelevantChange(undefined)).toBe(true);
  });
});

describe('backlogChanged', () => {
  it('is false when both snapshots are null', () => {
    expect(backlogChanged(null, null)).toBe(false);
  });

  it('is true when one side is null', () => {
    expect(backlogChanged(null, backlog([mk(1, 'open')]))).toBe(true);
    expect(backlogChanged(backlog([mk(1, 'open')]), null)).toBe(true);
  });

  it('is false when nothing the Map renders changed', () => {
    expect(backlogChanged(backlog([mk(1, 'open')]), backlog([mk(1, 'open')]))).toBe(false);
  });

  it('detects a status flip (the Run-reaches-done case)', () => {
    expect(backlogChanged(backlog([mk(1, 'wip')]), backlog([mk(1, 'done')]))).toBe(true);
  });

  it('detects an added issue file', () => {
    expect(
      backlogChanged(backlog([mk(1, 'open')]), backlog([mk(1, 'open'), mk(2, 'open')])),
    ).toBe(true);
  });

  it('detects a removed issue file', () => {
    expect(
      backlogChanged(backlog([mk(1, 'open'), mk(2, 'open')]), backlog([mk(1, 'open')])),
    ).toBe(true);
  });

  it('detects a changed active PRD', () => {
    expect(backlogChanged(backlog([], 'docs/PRD.md'), backlog([], 'docs/OTHER.md'))).toBe(true);
  });

  it('detects a body edit (detail pane must refresh)', () => {
    expect(
      backlogChanged(backlog([mk(1, 'open', { body: 'a' })]), backlog([mk(1, 'open', { body: 'b' })])),
    ).toBe(true);
  });

  it('detects a dependency change', () => {
    expect(
      backlogChanged(
        backlog([mk(1, 'open', { dependsOn: [] })]),
        backlog([mk(1, 'open', { dependsOn: [2] })]),
      ),
    ).toBe(true);
  });
});
