import { describe, it, expect } from 'vitest';
import {
  splitAdoptablePaths,
  adoptionCommitMessage,
  RECEIPT_DIR,
} from './receipt-adoption';

describe('splitAdoptablePaths — the adopt/halt decision (issue 62)', () => {
  it('adopts dirty files under issues/completions/ (the known-artifact set)', () => {
    const split = splitAdoptablePaths(['issues/completions/05-manual-check.md']);
    expect(split.adopt).toEqual(['issues/completions/05-manual-check.md']);
    expect(split.foreign).toEqual([]);
  });

  it('treats anything outside issues/completions/ as foreign (issue-59 halt keeps it)', () => {
    const split = splitAdoptablePaths(['docs/PRD.md', 'src/feature.ts']);
    expect(split.adopt).toEqual([]);
    expect(split.foreign).toEqual(['docs/PRD.md', 'src/feature.ts']);
  });

  it('splits a mixed dirty set: Receipts adopted, the rest foreign', () => {
    const split = splitAdoptablePaths([
      'issues/completions/02-run-me.md',
      'docs/PRD.md',
      'issues/completions/04-tracer.md',
    ]);
    expect(split.adopt).toEqual([
      'issues/completions/02-run-me.md',
      'issues/completions/04-tracer.md',
    ]);
    expect(split.foreign).toEqual(['docs/PRD.md']);
  });

  it('does NOT generalize: a path merely containing the dir name is foreign', () => {
    const split = splitAdoptablePaths([
      'other/issues/completions/01-x.md',
      'issues/completions-archive/01-x.md',
    ]);
    expect(split.adopt).toEqual([]);
    expect(split.foreign).toEqual([
      'other/issues/completions/01-x.md',
      'issues/completions-archive/01-x.md',
    ]);
  });

  it('the dir entry itself (no file) is not adoptable', () => {
    // `git status --porcelain` can list an untracked dir as `issues/completions/`.
    const split = splitAdoptablePaths([RECEIPT_DIR]);
    expect(split.adopt).toEqual([]);
    expect(split.foreign).toEqual([]);
  });

  it("excludes the Run's OWN Receipt from adoption (it belongs to the run commit, issue 59)", () => {
    const own = 'issues/completions/25-solo.md';
    const split = splitAdoptablePaths(
      [own, 'issues/completions/07-stray.md', 'src/solo-feature.ts'],
      own,
    );
    // The own Receipt is neither adopted (the ONE run commit captures it) nor
    // foreign (it must not read as an issue-59 halt cause).
    expect(split.adopt).toEqual(['issues/completions/07-stray.md']);
    expect(split.foreign).toEqual(['src/solo-feature.ts']);
  });

  it('dedupes while preserving first-seen order', () => {
    const split = splitAdoptablePaths([
      'issues/completions/02-b.md',
      'issues/completions/01-a.md',
      'issues/completions/02-b.md',
    ]);
    expect(split.adopt).toEqual([
      'issues/completions/02-b.md',
      'issues/completions/01-a.md',
    ]);
  });

  it('empty input → nothing to adopt, nothing foreign (clean tree)', () => {
    const split = splitAdoptablePaths([]);
    expect(split.adopt).toEqual([]);
    expect(split.foreign).toEqual([]);
  });
});

describe('adoptionCommitMessage', () => {
  it('names the adopted files in a dedicated chore message', () => {
    expect(
      adoptionCommitMessage([
        'issues/completions/02-run-me.md',
        'issues/completions/04-tracer.md',
      ]),
    ).toBe(
      'chore: adopt stray Receipt(s) — issues/completions/02-run-me.md, issues/completions/04-tracer.md',
    );
  });
});
