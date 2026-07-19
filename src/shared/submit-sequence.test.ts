import { describe, expect, it } from 'vitest';
import {
  SUBMIT_KEY,
  TYPE_SETTLE_MS,
  SUBMIT_SETTLE_MS,
  flattenMessage,
  buildSubmitSequence,
  buildSubmitBatch,
  buildTypeOnlySequence,
} from './submit-sequence';

describe('submit-sequence builder', () => {
  it('types the text and submits with a SEPARATE Enter write (the issue-41 fix)', () => {
    const seq = buildSubmitSequence('hello dispatcher');
    expect(seq).toHaveLength(2);
    // The text write must NOT carry the submit — that was the bug.
    expect(seq[0].data).toBe('hello dispatcher');
    expect(seq[0].data).not.toContain('\r');
    expect(seq[0].data).not.toContain('\n');
    // Submit is its own, distinct write.
    expect(seq[1].data).toBe(SUBMIT_KEY);
    expect(seq[1].data).toBe('\r');
    // The type step settles before Enter; the submit step settles before the next.
    expect(seq[0].settleMs).toBe(TYPE_SETTLE_MS);
    expect(seq[1].settleMs).toBe(SUBMIT_SETTLE_MS);
  });

  it('flattens multi-line blocks so no bare newline pre-submits the input', () => {
    const block = 'Completion block for issue 03 (completed)\nWhat changed: it works\nTry it: click Run';
    const flat = flattenMessage(block);
    expect(flat).not.toContain('\n');
    expect(flat).not.toContain('\r');
    expect(flat).toContain('Completion block for issue 03 (completed)');
    expect(flat).toContain(' · ');
    // The typed step of the sequence is the flattened text.
    expect(buildSubmitSequence(block)[0].data).toBe(flat);
    expect(buildSubmitSequence(block)[0].data).not.toContain('\n');
  });

  it('collapses CRLF and repeated blank lines and trims', () => {
    expect(flattenMessage('a\r\n\r\nb')).toBe('a · b');
    expect(flattenMessage('  \n line one \n\n line two \n ')).toBe('line one · line two');
  });

  it('keeps two blocks DISTINCT — never concatenated into one input', () => {
    const steps = buildSubmitBatch(['block A', 'block B']);
    // Two messages → four steps: typeA, submitA, typeB, submitB.
    expect(steps.map((s) => s.data)).toEqual(['block A', SUBMIT_KEY, 'block B', SUBMIT_KEY]);
    // Each message's text is its own write — 'block A' is never fused with 'block B'.
    expect(steps[0].data).toBe('block A');
    expect(steps[2].data).toBe('block B');
    // Each block gets its own submit.
    expect(steps[1].data).toBe(SUBMIT_KEY);
    expect(steps[3].data).toBe(SUBMIT_KEY);
    // No single write contains both blocks.
    for (const s of steps) {
      expect(s.data.includes('block A') && s.data.includes('block B')).toBe(false);
    }
  });

  it('an empty batch produces no writes', () => {
    expect(buildSubmitBatch([])).toEqual([]);
  });
});

describe('type-only sequence (issue 91 — a prefix the user completes)', () => {
  it('is a single write with NO submit step and NO submit byte', () => {
    const seq = buildTypeOnlySequence('/grill-with-docs ');
    expect(seq).toHaveLength(1);
    expect(seq[0].data).toBe('/grill-with-docs ');
    expect(seq[0].data).not.toContain(SUBMIT_KEY);
    expect(seq[0].settleMs).toBe(TYPE_SETTLE_MS);
  });

  it('preserves the trailing space — the user types the topic right after it', () => {
    expect(buildTypeOnlySequence('/grill-with-docs ')[0].data.endsWith(' ')).toBe(true);
  });

  it('strips any CR/LF so a prefix can never self-submit', () => {
    const seq = buildTypeOnlySequence('/grill-with-docs \r\n');
    expect(seq[0].data).not.toContain('\r');
    expect(seq[0].data).not.toContain('\n');
    expect(seq[0].data).toBe('/grill-with-docs ');
  });
});
