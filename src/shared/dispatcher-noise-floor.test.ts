import { describe, expect, it } from 'vitest';
import { isRealCapture, isRealDocDrift, isStrongOverlap } from './dispatcher-noise-floor';
import type { CompletionRecord, RunOutcome } from './completion-parser';
import type { OverlapGroup, RunRef } from './dispatcher-synthesis';

/** A fully-null completion record; spread over to set only the fields a test needs. */
function record(over: Partial<CompletionRecord> & { outcome: RunOutcome }): CompletionRecord {
  return {
    issue: null,
    issueId: null,
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
    detail: null,
    ...over,
  };
}

function ref(runId: string, issueId: number | null = null): RunRef {
  return { runId, issueId, issue: null };
}

function overlap(seam: string, runIds: string[]): OverlapGroup {
  return { seam, runs: runIds.map((id, i) => ref(id, i + 1)) };
}

describe('isRealCapture — (a) the empty/boot-screen noise floor', () => {
  it('keeps every real terminal outcome (completed / blocked / needs-verification)', () => {
    expect(isRealCapture(record({ outcome: 'completed', whatChanged: 'did the thing' }))).toBe(true);
    // A real outcome surfaces even with no parsed sections — its substance is the
    // outcome itself (a blocker body, verification steps).
    expect(isRealCapture(record({ outcome: 'blocked', detail: '62 is wip' }))).toBe(true);
    expect(isRealCapture(record({ outcome: 'needs-verification', detail: 'run X' }))).toBe(true);
  });

  it('DROPS a genuinely empty capture (the dogfood empty case)', () => {
    expect(isRealCapture(record({ outcome: 'unknown' }))).toBe(false);
  });

  it('DROPS a boot-screen / raw-scroll unknown that parsed no section (the dogfood boot-screen case)', () => {
    // A boot screen has a non-empty raw body but no recognised completion section.
    const bootScreen = record({
      outcome: 'unknown',
      detail: '╭──────────╮\n│ Welcome to Claude Code │\n╰──────────╯\n> ',
    });
    expect(isRealCapture(bootScreen)).toBe(false);
  });

  it('treats a blank-only section as no substance', () => {
    expect(isRealCapture(record({ outcome: 'unknown', whatChanged: '   ' }))).toBe(false);
  });

  it('KEEPS a real unknown with genuine substance (a malformed block that still parsed a section)', () => {
    expect(isRealCapture(record({ outcome: 'unknown', whatChanged: 'added the retry loop' }))).toBe(true);
    expect(isRealCapture(record({ outcome: 'unknown', bookkeeping: 'touched src/foo.ts' }))).toBe(true);
  });
});

describe('isRealDocDrift — (b) doc-drift-on-none stays silent', () => {
  it('is false for absent / empty / "none"-marker drift (the dogfood doc-drift-on-none case)', () => {
    expect(isRealDocDrift({ docDrift: null })).toBe(false);
    expect(isRealDocDrift({ docDrift: '   ' })).toBe(false);
    expect(isRealDocDrift({ docDrift: 'none' })).toBe(false);
    expect(isRealDocDrift({ docDrift: 'None.' })).toBe(false);
  });

  it('is true for a real contradiction', () => {
    expect(isRealDocDrift({ docDrift: 'PRD assumes 13 months; the feed holds ~11 days.' })).toBe(true);
  });
});

describe('isStrongOverlap — (c) only a strong concrete overlap surfaces', () => {
  it('is true for ≥2 distinct Runs on the same concrete source file', () => {
    expect(isStrongOverlap(overlap('src/shared/dispatcher-merge.ts', ['a', 'b']))).toBe(true);
    expect(isStrongOverlap(overlap('the merge seam', ['a', 'b', 'c']))).toBe(true);
  });

  it('DROPS a weak overlap of only one Run (the dogfood weak-overlap case)', () => {
    expect(isStrongOverlap(overlap('src/shared/dispatcher-merge.ts', ['a']))).toBe(false);
  });

  it('DROPS a boilerplate seam even when ≥2 Runs mention it', () => {
    // The PRD, config, manifests and the skill file are quoted structurally by
    // (nearly) every block — a shared mention is not shared work.
    expect(isStrongOverlap(overlap('docs/prd.md', ['a', 'b']))).toBe(false);
    expect(isStrongOverlap(overlap('docs/prd-dispatcher.md', ['a', 'b', 'c']))).toBe(false);
    expect(isStrongOverlap(overlap('package.json', ['a', 'b']))).toBe(false);
    expect(isStrongOverlap(overlap('tsconfig.json', ['a', 'b']))).toBe(false);
    expect(isStrongOverlap(overlap('issues/config.md', ['a', 'b']))).toBe(false);
    expect(isStrongOverlap(overlap('docs/adr/0012-dispatcher-noise-floor.md', ['a', 'b']))).toBe(false);
    expect(isStrongOverlap(overlap('~/.claude/skills/afk-issue-runner/skill.md', ['a', 'b']))).toBe(false);
  });

  it('DROPS a non-concrete junk token', () => {
    expect(isStrongOverlap(overlap('consolidate', ['a', 'b']))).toBe(false);
  });
});
