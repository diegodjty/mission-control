/**
 * Unit tests for the PURE Guided QA `## QA Steps` parser (issue 196).
 */
import { describe, it, expect } from 'vitest';
import { parseQaSteps, resolveQaSteps } from './qa-steps-model';
import { parseChecklist } from './checklist-model';

const WELL_FORMED = `## Ready for manual verification — issue 42 — example

Some prep notes before the steps.

## QA Steps

- Action: Start the dev server with \`npm run dev\`.
  Expected: The Map window opens with the backlog loaded.
  Command: npm run dev

- Action: Select any HITL issue in the list.
  Expected: The detail panel expands below the row.

Let me know once you've walked through these.`;

describe('parseQaSteps', () => {
  it('parses a well-formed block into ordered steps', () => {
    const result = parseQaSteps(WELL_FORMED);
    expect(result).toEqual({
      kind: 'steps',
      steps: [
        {
          action: 'Start the dev server with `npm run dev`.',
          expected: 'The Map window opens with the backlog loaded.',
          command: 'npm run dev',
        },
        {
          action: 'Select any HITL issue in the list.',
          expected: 'The detail panel expands below the row.',
          command: null,
        },
      ],
    });
  });

  it('accepts numbered-ordinal step markers', () => {
    const result = parseQaSteps(`## QA Steps

1. Action: Open the app.
   Expected: It loads.
2. Action: Close it.
   Expected: It quits.`);
    expect(result?.kind).toBe('steps');
    expect(result?.kind === 'steps' && result.steps).toHaveLength(2);
  });

  it('returns null when there is no QA Steps heading at all', () => {
    expect(parseQaSteps('Just some prose.\n\n- [ ] a checklist item')).toBeNull();
  });

  it('surfaces a parse error for an empty QA Steps block', () => {
    const result = parseQaSteps('## QA Steps\n\n## Next section\nsomething');
    expect(result).toEqual({
      kind: 'error',
      message: 'QA Steps block is empty — no steps found.',
    });
  });

  it('surfaces a parse error when a step is missing Action or Expected', () => {
    const result = parseQaSteps(`## QA Steps

- Action: Do the thing.
  (no expected outcome given)`);
    expect(result?.kind).toBe('error');
  });

  it('surfaces a parse error rather than silently half-parsing a mixed block', () => {
    // First step well-formed, second malformed — the WHOLE block is an error,
    // not a partial list of just the good step.
    const result = parseQaSteps(`## QA Steps

- Action: Good step.
  Expected: Works.
- Action: Bad step with no expected field.`);
    expect(result?.kind).toBe('error');
  });

  it('tolerates surrounding prose before and after the block', () => {
    const result = parseQaSteps(`# Some heading

Prose before.

## QA Steps

- Action: A.
  Expected: B.

## Doc drift

None.`);
    expect(result).toEqual({
      kind: 'steps',
      steps: [{ action: 'A.', expected: 'B.', command: null }],
    });
  });

  it('never throws on non-string / empty / whitespace-only input', () => {
    expect(parseQaSteps(null)).toBeNull();
    expect(parseQaSteps(undefined)).toBeNull();
    expect(parseQaSteps(42)).toBeNull();
    expect(parseQaSteps('')).toBeNull();
    expect(parseQaSteps('   \n  ')).toBeNull();
  });
});

describe('resolveQaSteps', () => {
  const BODY_BLOCK = `## QA Steps

- Action: Body-only step.
  Expected: Works from the issue body.`;

  it('prefers the Receipt detail block when it carries one', () => {
    const receiptBlock = `## QA Steps

- Action: Receipt step.
  Expected: Wins over the body.`;
    const result = resolveQaSteps(receiptBlock, BODY_BLOCK);
    expect(result).toEqual({
      kind: 'steps',
      steps: [{ action: 'Receipt step.', expected: 'Wins over the body.', command: null }],
    });
  });

  it('falls back to the issue body when the Receipt detail has no block (body-only HITL walkthrough, issue 195)', () => {
    const result = resolveQaSteps(null, BODY_BLOCK);
    expect(result).toEqual({
      kind: 'steps',
      steps: [{ action: 'Body-only step.', expected: 'Works from the issue body.', command: null }],
    });
  });

  it('falls back to the issue body when the Receipt detail is prose with no block', () => {
    const result = resolveQaSteps('Just prose, no heading.', BODY_BLOCK);
    expect(result).toEqual({
      kind: 'steps',
      steps: [{ action: 'Body-only step.', expected: 'Works from the issue body.', command: null }],
    });
  });

  it('returns null when neither source has a block', () => {
    expect(resolveQaSteps(null, 'plain body, no block')).toBeNull();
    expect(resolveQaSteps(undefined, undefined)).toBeNull();
  });

  it('coexists with the issue-156 checklist: a block-less HITL body still renders its checklist unchanged (issue 196)', () => {
    const legacyBody = `## Ready for manual verification — issue 42 — example

- [ ] Start the dev server with \`npm run dev\`.
- [x] Open the Map and select any HITL issue.`;
    // No `## QA Steps` heading anywhere → Guided QA stays out of the way...
    expect(resolveQaSteps(legacyBody, null)).toBeNull();
    // ...and the 156 checklist parser sees exactly what it always has.
    expect(parseChecklist(legacyBody)).toEqual([
      { text: 'Start the dev server with `npm run dev`.', checked: false },
      { text: 'Open the Map and select any HITL issue.', checked: true },
    ]);
  });

  it('surfaces a Receipt-side parse error even though the body has a valid block', () => {
    const malformedReceipt = `## QA Steps

- Action: no expected here.`;
    const result = resolveQaSteps(malformedReceipt, BODY_BLOCK);
    expect(result?.kind).toBe('error');
  });
});
