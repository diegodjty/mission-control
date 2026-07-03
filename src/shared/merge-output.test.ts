import { describe, it, expect } from 'vitest';
import { parseMergeSummary, classifyMergeFailure, parsePartialMerge } from './merge-output';

/**
 * These fixtures are the VERBATIM strings afk-merge.sh emits when piped (no TTY,
 * so no ANSI). Captured from running the real script against a scratch repo — see
 * run-merge.test.ts for the end-to-end integration proof.
 */
const cleanWithMissing = `. Project: /tmp/proj

=== 03-a ===
+ app: merged afk/03-a cleanly

=== 99-missing ===
. app: no afk/99-missing — skipping
! skipping tests (--no-test, or nothing was merged)

. --keep: leaving worktrees and branches in place.

=== summary ===
  03-a                               app  merged clean
  99-missing                         app  skip (no branch)

+ done.
`;

const alreadyMerged = `. Project: /tmp/proj

=== 03-a ===
. app: afk/03-a already in main — skipping

=== summary ===
  03-a                               app  already merged

+ done.
`;

const conflict = `. Project: /tmp/proj

=== 03-a ===
+ app: merged afk/03-a cleanly

=== 04-b ===
x app: conflict in afk/04-b needs you — not a clean append:
    - README.md

  The merge is left in place in /tmp/proj. Resolve those files, then:
      git -C "/tmp/proj" add <files> && git -C "/tmp/proj" commit --no-edit
  Then re-run for any slugs not yet integrated.
`;

const dirtyTree = `. Project: /tmp/proj
x app has uncommitted changes in /tmp/proj. Commit or stash them first — this guard stops merging on top of in-flight work.
`;

const wrongBranch = `. Project: /tmp/proj
x app is on 'feature', not main. Check out main in /tmp/proj first.
`;

describe('parseMergeSummary — which slugs actually merged', () => {
  it('counts a fresh "merged clean" row and excludes a "skip (no branch)" row', () => {
    const s = parseMergeSummary(cleanWithMissing);
    expect(s.mergedSlugs).toEqual(['03-a']);
    const missing = s.rows.find((r) => r.slug === '99-missing');
    expect(missing?.merged).toBe(false);
    expect(missing?.skipReason).toBe('no branch');
  });

  it('does NOT count an already-in-main branch as a fresh merge', () => {
    const s = parseMergeSummary(alreadyMerged);
    expect(s.mergedSlugs).toEqual([]);
    expect(s.rows[0]?.skipReason).toBe('already in main');
  });

  it('treats "merged (kept both: …)" as a fresh merge', () => {
    const out = `=== summary ===\n  07-x                               app  merged (kept both: src/lib/api.ts)\n\n+ done.\n`;
    const s = parseMergeSummary(out);
    expect(s.mergedSlugs).toEqual(['07-x']);
    expect(s.rows[0]?.result).toBe('merged (kept both: src/lib/api.ts)');
  });

  it('returns no rows when there is no summary block (conflict/preflight exit)', () => {
    expect(parseMergeSummary(conflict).rows).toEqual([]);
    expect(parseMergeSummary(conflict).mergedSlugs).toEqual([]);
  });

  it('dedupes a slug that merged across more than one repo/label', () => {
    const out = `=== summary ===\n  03-a                               api  merged clean\n  03-a                               web  merged clean\n\n+ done.\n`;
    expect(parseMergeSummary(out).mergedSlugs).toEqual(['03-a']);
  });

  it('ignores ANSI colour codes in a TTY-formatted summary', () => {
    const out = `[1m=== summary ===[0m\n  03-a                               app  merged clean\n`;
    expect(parseMergeSummary(out).mergedSlugs).toEqual(['03-a']);
  });
});

describe('classifyMergeFailure — the real cause, not a substring', () => {
  it('classifies the script conflict line as a conflict', () => {
    expect(classifyMergeFailure(conflict)).toBe('conflict');
  });

  it('classifies a dirty-tree preflight die as dirty-tree (not conflict)', () => {
    expect(classifyMergeFailure(dirtyTree)).toBe('dirty-tree');
  });

  it('classifies a wrong-branch preflight die as wrong-branch', () => {
    expect(classifyMergeFailure(wrongBranch)).toBe('wrong-branch');
  });

  it('falls back to tool-error for anything unrecognised', () => {
    expect(classifyMergeFailure('x missing config: /tmp/proj/issues/afk-merge.conf')).toBe(
      'tool-error',
    );
  });
});

describe('parsePartialMerge — the partial truth on a conflict exit (issue 24)', () => {
  it('reports the slug that merged before the conflict and the one that conflicted', () => {
    const s = parsePartialMerge(conflict);
    expect(s.mergedBeforeConflict).toEqual(['03-a']);
    expect(s.conflictedSlug).toBe('04-b');
    expect(s.conflictingFiles).toEqual(['README.md']);
  });

  it('recovers the facts when stdout and stderr are joined as separate blocks', () => {
    // The adapter joins stdout then stderr, so the `x conflict` line (stderr)
    // trails the `+ merged` and `  - file` lines (stdout) — order is lost. The
    // parser must still recover every fact.
    const split = [
      '. Project: /tmp/proj',
      '',
      '=== 03-a ===',
      '+ app: merged afk/03-a cleanly',
      '',
      '=== 05-c ===',
      '+ app: merged afk/05-c cleanly',
      '',
      '=== 04-b ===',
      '    - README.md',
      '    - src/app.ts',
      '',
      'x app: conflict in afk/04-b needs you — not a clean append:',
    ].join('\n');
    const s = parsePartialMerge(split);
    expect(s.mergedBeforeConflict).toEqual(['03-a', '05-c']);
    expect(s.conflictedSlug).toBe('04-b');
    expect(s.conflictingFiles).toEqual(['README.md', 'src/app.ts']);
  });

  it('treats a "kept both" clean merge as merged-before-conflict', () => {
    const out = [
      '=== 07-x ===',
      '+ app: merged afk/07-x (kept both in: src/lib/api.ts)',
      '=== 08-y ===',
      'x app: conflict in afk/08-y needs you — not a clean append:',
      '    - src/main.ts',
    ].join('\n');
    const s = parsePartialMerge(out);
    expect(s.mergedBeforeConflict).toEqual(['07-x']);
    expect(s.conflictedSlug).toBe('08-y');
  });

  it('strips the "union did not parse" annotation from a conflicting file', () => {
    const out = [
      'x app: conflict in afk/08-y needs you — not a clean append:',
      '    - config/urls.py (union did not parse — resolve by hand)',
    ].join('\n');
    expect(parsePartialMerge(out).conflictingFiles).toEqual(['config/urls.py']);
  });

  it('reports no merges when the very first slug conflicts', () => {
    const out = [
      '=== 04-b ===',
      'x app: conflict in afk/04-b needs you — not a clean append:',
      '    - README.md',
    ].join('\n');
    const s = parsePartialMerge(out);
    expect(s.mergedBeforeConflict).toEqual([]);
    expect(s.conflictedSlug).toBe('04-b');
  });

  it('dedupes a slug merged across more than one repo/label', () => {
    const out = [
      '+ api: merged afk/03-a cleanly',
      '+ web: merged afk/03-a cleanly',
      'x web: conflict in afk/04-b needs you — not a clean append:',
      '    - src/lib/api.ts',
    ].join('\n');
    expect(parsePartialMerge(out).mergedBeforeConflict).toEqual(['03-a']);
  });
});
