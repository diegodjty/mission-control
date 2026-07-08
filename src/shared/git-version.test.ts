import { describe, it, expect } from 'vitest';
import {
  parseGitVersion,
  atLeast,
  supportsMergeTree,
  MERGE_TREE_MIN,
  GIT_FLOOR_NOTE,
} from './git-version';

describe('parseGitVersion (issue 104)', () => {
  it('parses a plain git version string', () => {
    expect(parseGitVersion('git version 2.42.0')).toEqual({ major: 2, minor: 42, patch: 0 });
  });

  it('parses an Apple git string, ignoring the (Apple Git-NNN) build tag', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual({
      major: 2,
      minor: 39,
      patch: 5,
    });
  });

  it('parses a Windows git string, ignoring the .windows.N suffix', () => {
    expect(parseGitVersion('git version 2.41.0.windows.1')).toEqual({
      major: 2,
      minor: 41,
      patch: 0,
    });
  });

  it('defaults a missing patch to 0 (bare MAJOR.MINOR)', () => {
    expect(parseGitVersion('git version 2.38')).toEqual({ major: 2, minor: 38, patch: 0 });
  });

  it('trims surrounding whitespace/newlines', () => {
    expect(parseGitVersion('  git version 2.40.1\n')).toEqual({ major: 2, minor: 40, patch: 1 });
  });

  it('returns null for unparseable / empty input', () => {
    expect(parseGitVersion('not a version')).toBeNull();
    expect(parseGitVersion('')).toBeNull();
    expect(parseGitVersion(null)).toBeNull();
    expect(parseGitVersion(undefined)).toBeNull();
  });
});

describe('atLeast', () => {
  it('compares major, then minor, then patch', () => {
    expect(atLeast({ major: 2, minor: 38, patch: 0 }, MERGE_TREE_MIN)).toBe(true);
    expect(atLeast({ major: 2, minor: 39, patch: 0 }, MERGE_TREE_MIN)).toBe(true);
    expect(atLeast({ major: 3, minor: 0, patch: 0 }, MERGE_TREE_MIN)).toBe(true);
    expect(atLeast({ major: 2, minor: 37, patch: 9 }, MERGE_TREE_MIN)).toBe(false);
    expect(atLeast({ major: 1, minor: 99, patch: 9 }, MERGE_TREE_MIN)).toBe(false);
  });
});

describe('supportsMergeTree (the ≥2.38 floor)', () => {
  it('is true at and above 2.38', () => {
    expect(supportsMergeTree({ major: 2, minor: 38, patch: 0 })).toBe(true);
    expect(supportsMergeTree({ major: 2, minor: 50, patch: 1 })).toBe(true);
  });

  it('is false below 2.38', () => {
    expect(supportsMergeTree({ major: 2, minor: 37, patch: 9 })).toBe(false);
    expect(supportsMergeTree({ major: 2, minor: 20, patch: 0 })).toBe(false);
  });

  it('is false for an unparseable version (degrade, do not error)', () => {
    expect(supportsMergeTree(null)).toBe(false);
  });

  it('exposes exactly one passive floor note naming the version', () => {
    expect(GIT_FLOOR_NOTE).toContain('2.38');
  });
});
