import { describe, it, expect } from 'vitest';
import { suggestBranchName, sanitizeBranchName, checkBranchName } from './branch-name';
import type { BacklogIssue } from './backlog-model';

/** Minimal issue factory — only the fields branch-name suggestion reads. */
function mk(id: number, slug: string, parent: string | null = null): BacklogIssue {
  return {
    id,
    slug,
    fileName: `${String(id).padStart(2, '0')}-${slug}.md`,
    title: `${id} — ${slug}`,
    status: 'open',
    dependsOn: [],
    parent,
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    runTimeoutMinutes: null,
    touches: [],
    inBatch: parent !== null,
    standalone: parent === null,
    body: '',
  };
}

describe('suggestBranchName', () => {
  it('falls back to a generic name for an empty issue list', () => {
    expect(suggestBranchName([])).toBe('feat/branch');
  });

  it('suggests <id>-<slug> for a single issue', () => {
    const issue = mk(174, 'branch-name-suggestion-and-sanitization');
    expect(suggestBranchName([issue])).toBe('feat/174-branch-name-suggestion-and-sanitization');
  });

  it('suggests the shared parent theme when every issue links the same PRD/ADR', () => {
    const a = mk(163, 'dispatcher-split', 'PRD-dispatcher-refactor.md');
    const b = mk(166, 'batch-qa-walkthrough', 'PRD-dispatcher-refactor.md');
    expect(suggestBranchName([a, b])).toBe('feat/dispatcher-refactor');
  });

  it('suggests an id range + lowest slug when issues have no shared parent', () => {
    const a = mk(163, 'dispatcher-split', null);
    const b = mk(166, 'batch-qa-walkthrough', 'PRD-other.md');
    expect(suggestBranchName([a, b])).toBe('feat/163-166-dispatcher-split');
  });

  it('suggests an id range + lowest slug when issues have different parents', () => {
    const a = mk(163, 'dispatcher-split', 'PRD-a.md');
    const b = mk(166, 'batch-qa-walkthrough', 'PRD-b.md');
    expect(suggestBranchName([a, b])).toBe('feat/163-166-dispatcher-split');
  });

  it('is deterministic regardless of input order', () => {
    const a = mk(163, 'dispatcher-split');
    const b = mk(166, 'batch-qa-walkthrough');
    expect(suggestBranchName([b, a])).toBe(suggestBranchName([a, b]));
  });
});

describe('sanitizeBranchName', () => {
  it('leaves an already-legal name unchanged', () => {
    expect(sanitizeBranchName('feat/163-166-dispatcher-refactor')).toBe(
      'feat/163-166-dispatcher-refactor',
    );
  });

  it('lowercases and turns spaces into hyphens', () => {
    expect(sanitizeBranchName('distpacher refactor')).toBe('distpacher-refactor');
  });

  it('turns underscores into hyphens', () => {
    expect(sanitizeBranchName('fix_the_thing')).toBe('fix-the-thing');
  });

  it('strips characters git check-ref-format forbids', () => {
    expect(sanitizeBranchName('feat/foo~1^2:3?4*5[6\\7')).toBe('feat/foo1234567');
  });

  it('collapses consecutive dots', () => {
    expect(sanitizeBranchName('foo..bar')).toBe('foo-bar');
  });

  it('collapses consecutive slashes', () => {
    expect(sanitizeBranchName('foo//bar')).toBe('foo/bar');
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeBranchName('/-.foo-bar.-/')).toBe('foo-bar');
  });

  it('drops a trailing .lock', () => {
    expect(sanitizeBranchName('foo.lock')).toBe('foo');
  });

  it('drops empty path segments and bare dot segments', () => {
    expect(sanitizeBranchName('feat/./bar')).toBe('feat/bar');
  });

  it('caps length', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeBranchName(long).length).toBeLessThanOrEqual(60);
  });

  it('reduces to empty when nothing legal survives', () => {
    expect(sanitizeBranchName('~^:?*')).toBe('');
  });
});

describe('checkBranchName', () => {
  it('accepts an already-clean name with no error', () => {
    const result = checkBranchName('feat/163-dispatcher-split');
    expect(result).toEqual({
      sanitized: 'feat/163-dispatcher-split',
      wasClean: true,
      error: null,
    });
  });

  it('flags a sanitized correction (spaces) as not clean, but still accepted', () => {
    const result = checkBranchName('distpacher refactor');
    expect(result.wasClean).toBe(false);
    expect(result.sanitized).toBe('distpacher-refactor');
    expect(result.error).toBeNull();
  });

  it('rejects an input that sanitizes to empty', () => {
    const result = checkBranchName('~^:?*');
    expect(result.error).toBe('Enter a branch name — letters, numbers, and hyphens.');
  });

  it('rejects a name that already exists, by its sanitized form', () => {
    const result = checkBranchName('Dispatcher Refactor', ['dispatcher-refactor']);
    expect(result.sanitized).toBe('dispatcher-refactor');
    expect(result.error).toBe('Branch "dispatcher-refactor" already exists — pick another name.');
  });

  it('accepts a name that does not collide with any existing branch', () => {
    const result = checkBranchName('feat/new-thing', ['main', 'feat/other']);
    expect(result.error).toBeNull();
  });
});
