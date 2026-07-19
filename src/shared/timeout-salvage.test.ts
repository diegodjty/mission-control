import { describe, it, expect } from 'vitest';
import {
  parseTimeoutSalvageRecords,
  removeTimeoutSalvageRecord,
  salvageActionFor,
  serializeTimeoutSalvageRecords,
  timeoutSalvageRecordsFor,
  upsertTimeoutSalvageRecord,
  type TimeoutSalvageRecord,
} from './timeout-salvage';

const RECORD: TimeoutSalvageRecord = {
  project: 'mission-control',
  issueId: 161,
  slug: '161-app-refactor',
  worktreePath: '/Users/devteam/.afk-worktrees/161-app-refactor',
  timedOutAt: '2026-07-19T12:00:00.000Z',
};

describe('parseTimeoutSalvageRecords (issue 170) — never throws', () => {
  it('degrades missing/junk/malformed content to the empty list', () => {
    expect(parseTimeoutSalvageRecords(null)).toEqual([]);
    expect(parseTimeoutSalvageRecords(undefined)).toEqual([]);
    expect(parseTimeoutSalvageRecords('')).toEqual([]);
    expect(parseTimeoutSalvageRecords('not json')).toEqual([]);
    expect(parseTimeoutSalvageRecords('{}')).toEqual([]);
    expect(parseTimeoutSalvageRecords('[{"project":"x"}]')).toEqual([]); // missing fields
    expect(parseTimeoutSalvageRecords('[null, 42, "junk"]')).toEqual([]);
  });

  it('parses a well-formed list and drops only the malformed entries', () => {
    const content = JSON.stringify([RECORD, { project: 'x' }]);
    expect(parseTimeoutSalvageRecords(content)).toEqual([RECORD]);
  });

  it('round-trips through serialize', () => {
    const serialized = serializeTimeoutSalvageRecords([RECORD]);
    expect(parseTimeoutSalvageRecords(serialized)).toEqual([RECORD]);
  });
});

describe('upsertTimeoutSalvageRecord / removeTimeoutSalvageRecord', () => {
  it('adds a new record', () => {
    expect(upsertTimeoutSalvageRecord([], RECORD)).toEqual([RECORD]);
  });

  it('replaces an existing record for the same project+issue rather than duplicating', () => {
    const retimedOut = { ...RECORD, timedOutAt: '2026-07-19T13:00:00.000Z' };
    expect(upsertTimeoutSalvageRecord([RECORD], retimedOut)).toEqual([retimedOut]);
  });

  it('leaves other projects/issues untouched', () => {
    const other: TimeoutSalvageRecord = { ...RECORD, project: 'other-project', issueId: 5 };
    const result = upsertTimeoutSalvageRecord([RECORD], other);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([RECORD, other]));
  });

  it('removes exactly the named project+issue', () => {
    const other: TimeoutSalvageRecord = { ...RECORD, issueId: 5 };
    expect(removeTimeoutSalvageRecord([RECORD, other], RECORD.project, RECORD.issueId)).toEqual([
      other,
    ]);
  });

  it('remove is a no-op when nothing matches', () => {
    expect(removeTimeoutSalvageRecord([RECORD], 'other-project', 999)).toEqual([RECORD]);
  });
});

describe('timeoutSalvageRecordsFor', () => {
  it('filters to one project, ascending by issue id', () => {
    const a = { ...RECORD, issueId: 5 };
    const b = { ...RECORD, issueId: 2 };
    const foreign = { ...RECORD, project: 'other', issueId: 1 };
    expect(timeoutSalvageRecordsFor([a, b, foreign], RECORD.project)).toEqual([b, a]);
  });
});

describe('salvageActionFor', () => {
  it('offers complete-from-worktree when verify passed', () => {
    expect(salvageActionFor(true)).toBe('complete-from-worktree');
  });

  it('offers discard-and-requeue when verify failed', () => {
    expect(salvageActionFor(false)).toBe('discard-and-requeue');
  });
});
