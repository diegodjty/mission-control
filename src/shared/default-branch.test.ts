import { describe, it, expect } from 'vitest';
import { resolveDefaultBranch, DEFAULT_BRANCH_FALLBACK } from './default-branch';

describe('resolveDefaultBranch — the branch the Merge path integrates into (issue 27)', () => {
  it('returns the branch name from a normal `symbolic-ref --short HEAD` output', () => {
    expect(resolveDefaultBranch('main\n')).toBe('main');
  });

  it('detects a non-`main` default branch (master), un-hardcoding the old literal', () => {
    expect(resolveDefaultBranch('master\n')).toBe('master');
    expect(resolveDefaultBranch('trunk\n')).toBe('trunk');
  });

  it('trims surrounding whitespace/newlines git may print', () => {
    expect(resolveDefaultBranch('  develop  \n')).toBe('develop');
  });

  it('falls back to `main` on empty output (nothing usable read)', () => {
    expect(resolveDefaultBranch('')).toBe(DEFAULT_BRANCH_FALLBACK);
    expect(resolveDefaultBranch('   \n')).toBe(DEFAULT_BRANCH_FALLBACK);
  });

  it('falls back to `main` when git failed and gave us null/undefined (detached HEAD)', () => {
    expect(resolveDefaultBranch(null)).toBe(DEFAULT_BRANCH_FALLBACK);
    expect(resolveDefaultBranch(undefined)).toBe(DEFAULT_BRANCH_FALLBACK);
  });
});
