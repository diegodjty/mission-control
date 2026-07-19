import { describe, expect, it } from 'vitest';
import { isRealCapture, isRealDocDrift } from './notification-noise-floor';
import type { CompletionRecord, RunOutcome } from './completion-parser';

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
