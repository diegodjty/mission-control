/**
 * Unit tests for the PURE ghost-commit guard (issue 153): given
 * `git diff --cached --name-status` output, which tracked files would this
 * commit DELETE (the ghost-deletion signature), and what refusal does the human
 * see. Renames/copies are moves, not ghost deletions, and never trip it.
 */
import { describe, it, expect } from 'vitest';
import { stagedDeletions, ghostCommitRefusal } from './ghost-commit-guard';

describe('stagedDeletions', () => {
  it('extracts only the pure-deletion (D) paths', () => {
    const nameStatus = ['A\tsrc/new.ts', 'M\tsrc/edited.ts', 'D\tCONTEXT.md'].join('\n');
    expect(stagedDeletions(nameStatus)).toEqual(['CONTEXT.md']);
  });

  it('returns every deletion, ascending and deduped', () => {
    const nameStatus = [
      'D\tvitest.e2e.config.ts',
      'D\tCONTEXT.md',
      'D\telectron.vite.config.ts',
      'D\tCONTEXT.md',
    ].join('\n');
    expect(stagedDeletions(nameStatus)).toEqual([
      'CONTEXT.md',
      'electron.vite.config.ts',
      'vitest.e2e.config.ts',
    ]);
  });

  it('does NOT count a rename as a deletion — a move is allowed', () => {
    // `git diff --cached --name-status` renders a rename as `R<score>\told\tnew`.
    const nameStatus = ['R100\tsrc/old-name.ts\tsrc/new-name.ts', 'M\tREADME.md'].join('\n');
    expect(stagedDeletions(nameStatus)).toEqual([]);
  });

  it('does NOT count a copy as a deletion', () => {
    expect(stagedDeletions('C75\tsrc/base.ts\tsrc/variant.ts')).toEqual([]);
  });

  it('is empty for an add-only / modify-only commit (the normal case)', () => {
    expect(stagedDeletions('A\ta.ts\nA\tb.ts\nM\tc.ts')).toEqual([]);
  });

  it('tolerates malformed / empty / non-string input without throwing', () => {
    expect(stagedDeletions('')).toEqual([]);
    expect(stagedDeletions('   \n  ')).toEqual([]);
    expect(stagedDeletions(null)).toEqual([]);
    expect(stagedDeletions(undefined)).toEqual([]);
    expect(stagedDeletions(42)).toEqual([]);
    expect(stagedDeletions('D')).toEqual([]); // no path after the code
  });

  it('tolerates CRLF line endings', () => {
    expect(stagedDeletions('A\tnew.ts\r\nD\told.ts\r\n')).toEqual(['old.ts']);
  });
});

describe('ghostCommitRefusal', () => {
  it('names the deleted files and the issue in a single-line refusal', () => {
    const msg = ghostCommitRefusal('183-hitl-walkthrough', ['CONTEXT.md', 'tsconfig.node.json']);
    expect(msg).toContain('183-hitl-walkthrough');
    expect(msg).toContain('CONTEXT.md');
    expect(msg).toContain('tsconfig.node.json');
    expect(msg).toContain('issue 153');
    expect(msg).not.toContain('\n');
  });

  it('uses singular phrasing for one file', () => {
    expect(ghostCommitRefusal('04-x', ['only.ts'])).toContain('a tracked file');
  });

  it('elides beyond the first several files so the message stays a one-liner', () => {
    const many = Array.from({ length: 12 }, (_, i) => `file-${String(i).padStart(2, '0')}.ts`);
    const msg = ghostCommitRefusal('04-x', many);
    expect(msg).toContain('file-00.ts');
    expect(msg).toContain('+4 more'); // 12 total − 8 listed
    expect(msg).toContain('12 tracked files');
  });

  it('returns empty string for an empty list (nothing to refuse)', () => {
    expect(ghostCommitRefusal('04-x', [])).toBe('');
  });
});
