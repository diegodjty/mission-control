/**
 * Unit tests for the PURE Receipt parser (issue 55, ADR-0013). A Receipt file
 * (`issues/completions/NN-slug.md`) declares its machine-facing facts in YAML
 * frontmatter (`issue`, `slug`, `outcome`, `finished`) with the Worker's
 * verbatim final block as the body. Declared facts win: a valid frontmatter
 * `outcome` classifies the record with no heading regexes or heuristics; a
 * missing/broken frontmatter degrades to the existing §5 block parser over the
 * body, flagged `inferred`. Any input yields a record — never a throw.
 */
import { describe, it, expect } from 'vitest';
import { parseReceipt } from './receipt-parser';

// The §5 completion block a Worker emits — used as the body of a well-formed
// completed Receipt.
const COMPLETED_BLOCK = `## Completed issue 55 — receipt-parser-frontmatter-first

**What changed** — Receipts written by Workers are now parsed frontmatter-first,
so the Dispatcher reads declared outcomes instead of inferring them.

**Try it yourself** — Run \`npm run test\` and watch the receipt-parser suite pass.

**Verified** — Unit tests cover all three declared outcomes plus fallback.

**Bookkeeping** — Added \`src/shared/receipt-parser.ts\` and its test.

**Doc drift** — none.`;

const COMPLETED_RECEIPT = `---
issue: 55
slug: receipt-parser-frontmatter-first
outcome: completed
finished: 2026-07-03T14:22:31Z
---

${COMPLETED_BLOCK}`;

describe('parseReceipt — well-formed completed Receipt', () => {
  const rec = parseReceipt(COMPLETED_RECEIPT);

  it('classifies from the declared frontmatter outcome', () => {
    expect(rec.outcome).toBe('completed');
    expect(rec.outcomeSource).toBe('declared');
  });

  it('reads issue id, slug, and finished stamp from the frontmatter', () => {
    expect(rec.issueId).toBe(55);
    expect(rec.slug).toBe('receipt-parser-frontmatter-first');
    expect(rec.finished).toBe('2026-07-03T14:22:31Z');
  });

  it('builds the display descriptor from the declared fields', () => {
    expect(rec.issue).toBe('55 — receipt-parser-frontmatter-first');
  });

  it("extracts the block's sections from the body", () => {
    expect(rec.whatChanged).toMatch(/parsed frontmatter-first/);
    expect(rec.tryIt).toMatch(/npm run test/);
    expect(rec.verified).toMatch(/all three declared outcomes/);
    expect(rec.bookkeeping).toMatch(/receipt-parser\.ts/);
    expect(rec.docDrift).toBe('none.');
  });
});

describe('parseReceipt — declared outcome beats body shape', () => {
  it('a needs-verification declaration wins over a completed-looking body', () => {
    const receipt = `---
issue: 12
slug: tile-concurrent-panes
outcome: needs-verification
finished: 2026-07-03T09:00:00Z
---

## Completed issue 12 — tile-concurrent-panes

**What changed** — Panes now tile.

## Ready for manual verification

1. Open two Panes and check the tiling.`;
    const rec = parseReceipt(receipt);
    expect(rec.outcome).toBe('needs-verification');
    expect(rec.outcomeSource).toBe('declared');
    expect(rec.issueId).toBe(12);
  });

  it('a completed declaration wins over an HITL-looking body', () => {
    const receipt = `---
issue: 7
slug: parallel-worktree-isolation
outcome: completed
finished: 2026-07-01T08:00:00Z
---

Verified everything. Note: an earlier draft said "Ready for manual verification"
but the runtime check landed, so this shipped as done.`;
    const rec = parseReceipt(receipt);
    expect(rec.outcome).toBe('completed');
    expect(rec.outcomeSource).toBe('declared');
  });

  it('a blocked declaration wins over a body with no blocked heuristics', () => {
    const receipt = `---
issue: 9
slug: multiple-projects-windows
outcome: blocked
finished: 2026-07-02T10:30:00Z
---

Issue 62 is wip with uncommitted partial work; 63-66 depend on it.`;
    const rec = parseReceipt(receipt);
    expect(rec.outcome).toBe('blocked');
    expect(rec.outcomeSource).toBe('declared');
    // A non-completed shape still carries its substance in detail.
    expect(rec.detail).toMatch(/uncommitted partial work/);
  });
});

describe('parseReceipt — fallback to the block parser', () => {
  it('no frontmatter at all: infers from the §5 block', () => {
    const rec = parseReceipt(COMPLETED_BLOCK);
    expect(rec.outcome).toBe('completed');
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.issueId).toBe(55);
    expect(rec.slug).toBe('receipt-parser-frontmatter-first');
    expect(rec.finished).toBeNull();
    expect(rec.whatChanged).toMatch(/frontmatter-first/);
  });

  it('unterminated frontmatter fence: infers over the whole text', () => {
    const receipt = `---\nissue: 55\noutcome: completed\n\n${COMPLETED_BLOCK}`;
    const rec = parseReceipt(receipt);
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(55);
  });

  it('frontmatter with a missing outcome falls back but keeps declared ids', () => {
    const receipt = `---
issue: 55
slug: receipt-parser-frontmatter-first
finished: 2026-07-03T14:22:31Z
---

${COMPLETED_BLOCK}`;
    const rec = parseReceipt(receipt);
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(55);
    expect(rec.slug).toBe('receipt-parser-frontmatter-first');
    expect(rec.finished).toBe('2026-07-03T14:22:31Z');
  });

  it('frontmatter with an invalid outcome value falls back to the body parse', () => {
    const receipt = `---
issue: 55
slug: receipt-parser-frontmatter-first
outcome: shipped-it
finished: 2026-07-03T14:22:31Z
---

## Ready for manual verification

1. Check the thing by hand.`;
    const rec = parseReceipt(receipt);
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.outcome).toBe('needs-verification');
    expect(rec.detail).toMatch(/Check the thing by hand/);
  });

  it('an HITL body with no frontmatter infers needs-verification', () => {
    const rec = parseReceipt(
      '## Ready for manual verification\n\n1. Open the app.\n2. Click the button.'
    );
    expect(rec.outcome).toBe('needs-verification');
    expect(rec.outcomeSource).toBe('inferred');
  });
});

describe('parseReceipt — declared frontmatter tolerances', () => {
  it('accepts quoted values and surrounding whitespace', () => {
    const receipt = `---
issue: "55"
slug: 'receipt-parser-frontmatter-first'
outcome:   completed
finished: "2026-07-03T14:22:31Z"
---

body text`;
    const rec = parseReceipt(receipt);
    expect(rec.outcomeSource).toBe('declared');
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(55);
    expect(rec.slug).toBe('receipt-parser-frontmatter-first');
    expect(rec.finished).toBe('2026-07-03T14:22:31Z');
  });

  it('accepts outcome case-insensitively', () => {
    const rec = parseReceipt('---\noutcome: Needs-Verification\n---\nsteps');
    expect(rec.outcome).toBe('needs-verification');
    expect(rec.outcomeSource).toBe('declared');
  });

  it('a non-numeric issue field leaves issueId null without breaking the declaration', () => {
    const rec = parseReceipt('---\nissue: fifty-five\noutcome: blocked\n---\nreason');
    expect(rec.outcome).toBe('blocked');
    expect(rec.outcomeSource).toBe('declared');
    expect(rec.issueId).toBeNull();
  });
});

describe('parseReceipt — junk and empty input never throw', () => {
  it('empty string yields an unknown record', () => {
    const rec = parseReceipt('');
    expect(rec.outcome).toBe('unknown');
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.issueId).toBeNull();
    expect(rec.slug).toBeNull();
    expect(rec.finished).toBeNull();
  });

  it('whitespace-only yields an unknown record', () => {
    expect(parseReceipt('   \n\n  ').outcome).toBe('unknown');
  });

  it('junk text yields an unknown record with the text preserved as detail', () => {
    const rec = parseReceipt('lorem ipsum dolor sit amet');
    expect(rec.outcome).toBe('unknown');
    expect(rec.outcomeSource).toBe('inferred');
    expect(rec.detail).toBe('lorem ipsum dolor sit amet');
  });

  it('non-string inputs yield an unknown record', () => {
    expect(parseReceipt(undefined).outcome).toBe('unknown');
    expect(parseReceipt(null).outcome).toBe('unknown');
    expect(parseReceipt(42).outcome).toBe('unknown');
    expect(parseReceipt({ outcome: 'completed' }).outcome).toBe('unknown');
  });

  it('malformed YAML lines inside a well-fenced frontmatter do not throw', () => {
    const receipt = `---
:::: not yaml at all ::::
[broken
outcome: completed
---

body`;
    const rec = parseReceipt(receipt);
    // The one readable line still declares the outcome.
    expect(rec.outcome).toBe('completed');
    expect(rec.outcomeSource).toBe('declared');
  });
});
