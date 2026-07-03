/**
 * Unit tests for the PURE completion-block parser. Feeds the three real shapes
 * an afk-issue-runner Worker emits as its final message — the normal completion
 * block (SKILL.md §5), the "Ready for manual verification" (HITL) block, and
 * the "blocked / no work available" report — plus malformed input, and asserts
 * the structured fields and `outcome`. (PRD-dispatcher Testing Decisions.)
 */
import { describe, it, expect } from 'vitest';
import { parseCompletionBlock, stripAnsi } from './completion-parser';

// A realistic normal completion block, matching SKILL.md §5's shape (heading +
// the five bold-labelled sections).
const NORMAL = `## Completed issue 03 — run-issue-in-pane

**What changed** — You can now click Run on an eligible issue and a fresh Claude
session spins up in an embedded Pane scoped to that issue, in the Project repo.

**Try it yourself** — Run \`npm run dev\`, open the Map, pick any issue showing as
eligible, and click ▶ Run. A terminal Pane opens and starts the session.

**Verified** — Loaded the Map against this repo, clicked Run on a fresh eligible
issue, watched the Pane spawn \`claude\` and the status flip to running.

**Bookkeeping** — Touched \`src/renderer/src/Pane.tsx\`, \`src/main/index.ts\`; added
\`resolve-run-command.test.ts\`. No deviations from the acceptance criteria.

**Doc drift** — none.`;

describe('parseCompletionBlock — normal completion block', () => {
  const rec = parseCompletionBlock(NORMAL);

  it('classifies it as completed', () => {
    expect(rec.outcome).toBe('completed');
  });

  it('recovers the issue id and descriptor from the heading', () => {
    expect(rec.issueId).toBe(3);
    expect(rec.issue).toBe('3 — run-issue-in-pane');
  });

  it('extracts each section body', () => {
    expect(rec.whatChanged).toMatch(/click Run on an eligible issue/);
    expect(rec.tryIt).toMatch(/npm run dev/);
    expect(rec.verified).toMatch(/watched the Pane spawn/);
    expect(rec.bookkeeping).toMatch(/Pane\.tsx/);
    expect(rec.docDrift).toBe('none.');
  });

  it('does not bleed one section into the next', () => {
    expect(rec.whatChanged).not.toMatch(/Try it yourself/);
    expect(rec.verified).not.toMatch(/Bookkeeping/);
  });

  it('leaves detail null for a completed block (its substance is the sections)', () => {
    expect(rec.detail).toBeNull();
  });
});

describe('parseCompletionBlock — heading/section variants', () => {
  it('handles a plain (no-bold, colon-separated) block', () => {
    const rec = parseCompletionBlock(
      [
        '## Completed issue 12 — tile-concurrent-panes',
        '',
        'What changed: tiles now lay out in an adaptive grid.',
        'Verified: opened three Runs, saw a 2x2 grid.',
        'Doc drift: none',
      ].join('\n'),
    );
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(12);
    expect(rec.whatChanged).toMatch(/adaptive grid/);
    expect(rec.verified).toMatch(/2x2 grid/);
    expect(rec.tryIt).toBeNull();
  });

  it('captures the block even when preceded by terminal scroll', () => {
    const noise = 'npm run test\n> vitest run\n\nVerified earlier logs here\n\n';
    const rec = parseCompletionBlock(noise + NORMAL);
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(3);
    // The pre-heading "Verified earlier logs" line must not become the section.
    expect(rec.verified).toMatch(/watched the Pane spawn/);
  });
});

describe('parseCompletionBlock — Ready for manual verification (HITL)', () => {
  const HITL = `Ready for manual verification — issue 20 (isolate-manual-concurrent-runs)

This touches live git worktrees, so it needs a human to confirm on a real repo.

**Try it yourself** — Start two Runs at once and confirm each lands in its own
worktree with no collision on main.

**Verified** — Not runtime-verified: needs a real multi-worktree repo.`;

  const rec = parseCompletionBlock(HITL);

  it('classifies it as needs-verification', () => {
    expect(rec.outcome).toBe('needs-verification');
  });

  it('still recovers the issue id and any present sections', () => {
    expect(rec.issueId).toBe(20);
    expect(rec.tryIt).toMatch(/two Runs at once/);
    expect(rec.verified).toMatch(/Not runtime-verified/);
  });

  it('carries the full block body in detail (issue 42 — body must survive)', () => {
    expect(rec.detail).toContain('needs a human to confirm on a real repo');
    expect(rec.detail).toContain('Ready for manual verification');
  });

  // Issue 53 firing gap: a parked HITL Run's tail-truncated buffer can also carry
  // an EARLIER "Completed issue NN" line (prior narration, a relayed completion, a
  // quoted example). The old fixed precedence (completed-beats-HITL) misclassified
  // this as `completed` → `finished` → the hitl-waiting notification never fired.
  // The Worker's FINAL block is what its outcome is, so the LATER block-title wins.
  it('classifies a HITL block that FOLLOWS earlier completed scroll as needs-verification', () => {
    const scroll =
      '## Completed issue 03 — run-issue-in-pane\n\n' +
      '**What changed** — an earlier sibling that really did finish.\n\n' +
      'Completion block for issue 04 (completed) — relayed by the Dispatcher.\n\n';
    const rec2 = parseCompletionBlock(scroll + HITL);
    expect(rec2.outcome).toBe('needs-verification');
    expect(rec2.detail).toContain('Ready for manual verification');
  });

  // The guard on that fix: the phrase "ready for manual verification" appearing in
  // a genuine completed block's PROSE (mid-line, not a block title) must NOT flip
  // it to needs-verification — the completed heading is the later real block title.
  it('keeps a completed block whose prose mentions the HITL phrase as completed', () => {
    const rec3 = parseCompletionBlock(
      '## Completed issue 07 — parallel-worktree-isolation\n\n' +
        '**Verified** — type-check + build pass; live worktree behavior is ready ' +
        'for manual verification by a human on a real repo.\n\n' +
        '**Doc drift** — none',
    );
    expect(rec3.outcome).toBe('completed');
    expect(rec3.issueId).toBe(7);
  });
});

describe('parseCompletionBlock — blocked / no work available', () => {
  it('classifies a no-work-available report', () => {
    const rec = parseCompletionBlock(
      'No AFK-eligible work available. Issue 62 is wip with uncommitted partial ' +
        'work; issues 63–66 all depend on it and are blocked.',
    );
    expect(rec.outcome).toBe('blocked');
    expect(rec.issueId).toBe(62);
  });

  it('classifies an explicit blocked report heading', () => {
    const rec = parseCompletionBlock(
      '## Blocked\n\nStopped because the dependency issue 07 is not actually done in the code.',
    );
    expect(rec.outcome).toBe('blocked');
    expect(rec.issueId).toBe(7);
  });

  it('captures the blocker reason in detail (issue 42 — body must survive)', () => {
    const report =
      'No AFK-eligible work available. Issue 62 is wip with uncommitted partial ' +
      'work in packages/state-machine/src/transfer-phase.ts; issues 63–66 all ' +
      'depend on it and are blocked. Recommend reverting or finishing 62.';
    const rec = parseCompletionBlock(report);
    expect(rec.outcome).toBe('blocked');
    // The whole reason survives — not just the header — so the Dispatcher gets
    // substance instead of an empty "blocked" line.
    expect(rec.detail).toContain('transfer-phase.ts');
    expect(rec.detail).toContain('Recommend reverting or finishing 62');
    // ...and every named section field is still null (this shape has none).
    expect(rec.whatChanged).toBeNull();
    expect(rec.tryIt).toBeNull();
  });
});

describe('parseCompletionBlock — malformed / graceful degradation', () => {
  it('returns unknown with all-null fields for empty input', () => {
    const rec = parseCompletionBlock('');
    expect(rec).toEqual({
      issue: null,
      issueId: null,
      whatChanged: null,
      tryIt: null,
      verified: null,
      bookkeeping: null,
      docDrift: null,
      detail: null,
      outcome: 'unknown',
    });
  });

  it('never throws on non-string input', () => {
    expect(() => parseCompletionBlock(undefined)).not.toThrow();
    expect(() => parseCompletionBlock(null)).not.toThrow();
    expect(() => parseCompletionBlock(42)).not.toThrow();
    expect(() => parseCompletionBlock({ nope: true })).not.toThrow();
    expect(parseCompletionBlock(undefined).outcome).toBe('unknown');
  });

  it('flags random prose as unknown', () => {
    const rec = parseCompletionBlock(
      'the quick brown fox jumped over the lazy dog and then went home',
    );
    expect(rec.outcome).toBe('unknown');
  });

  it('carries a body-only / unknown block into detail (issue 42 — body survives)', () => {
    // A block that names no section headers and matches no known shape: its
    // text must still reach the record so nothing meaningful is silently lost.
    const rec = parseCompletionBlock(
      'Hit a wall reconciling the migration; leaving notes here for the human to pick up.',
    );
    expect(rec.outcome).toBe('unknown');
    expect(rec.detail).toContain('reconciling the migration');
    expect(rec.whatChanged).toBeNull();
  });

  it('best-effort extracts sections from a partial block but keeps outcome honest', () => {
    // A completion heading with a truncated body (streaming cut off mid-block):
    // it IS a completed block, but only What changed made it through.
    const rec = parseCompletionBlock(
      '## Completed issue 09 — multiple-projects-windows\n\n**What changed** — multi-window support.',
    );
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(9);
    expect(rec.whatChanged).toMatch(/multi-window support/);
    expect(rec.verified).toBeNull();
    expect(rec.docDrift).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes colour escapes and normalises CRLF', () => {
    const raw = '\x1b[32mgreen\x1b[0m\r\nnext\r\n';
    expect(stripAnsi(raw)).toBe('green\nnext\n');
  });

  it('lets the parser read a block wrapped in ANSI colour', () => {
    const raw = '\x1b[1m## Completed issue 05 — live-map-updates\x1b[0m\r\n\r\n**Doc drift** — none';
    const rec = parseCompletionBlock(raw);
    expect(rec.outcome).toBe('completed');
    expect(rec.issueId).toBe(5);
    expect(rec.docDrift).toBe('none');
  });
});
