/**
 * Completion-block parser (PURE).
 *
 * A Worker's final output text → a structured Completion record. This is the
 * prerequisite for the Dispatcher (PRD-dispatcher, ADR-0009): the Dispatcher's
 * entire input is these captured blocks, so parsing must be robust to the three
 * real shapes an afk-issue-runner Worker emits as its final message —
 *
 *   1. the normal completion block (`## Completed issue NN — <slug>` with the
 *      **What changed / Try it yourself / Verified / Bookkeeping / Doc drift**
 *      sections, per `~/.claude/skills/afk-issue-runner/SKILL.md` §5),
 *   2. the "Ready for manual verification" (HITL) block, and
 *   3. the "blocked / no work available" report,
 *
 * plus malformed/partial input, which must degrade gracefully (best-effort
 * fields, `outcome: 'unknown'`) and NEVER throw.
 *
 * This module is PURE: no file/network/Electron I/O and no runtime imports, so
 * it is unit-testable in isolation and safe to share across main/renderer.
 * The capture edge (buffering PTY output, persisting to the Run log) lives in
 * an adapter; this only turns text into structure.
 */

/**
 * What a Run's final output says happened:
 *  - `completed` — a normal completion block (issue marked `done`).
 *  - `needs-verification` — a "Ready for manual verification" (HITL) block.
 *  - `blocked` — a blocked / no-work-available report.
 *  - `unknown` — none of the above could be recognised (malformed/partial).
 */
export type RunOutcome = 'completed' | 'needs-verification' | 'blocked' | 'unknown';

/** The structured shape parsed out of a Worker's final output text. */
export interface CompletionRecord {
  /** The issue descriptor from the block heading (`34 — <slug>`), or null. */
  issue: string | null;
  /** The numeric issue id, recovered from the heading/text, or null. */
  issueId: number | null;
  /** The "What changed" section body, or null when absent. */
  whatChanged: string | null;
  /** The "Try it yourself" section body, or null when absent. */
  tryIt: string | null;
  /** The "Verified" section body, or null when absent. */
  verified: string | null;
  /** The "Bookkeeping" section body, or null when absent. */
  bookkeeping: string | null;
  /** The "Doc drift" section body, or null when absent. */
  docDrift: string | null;
  /**
   * The free-form report body for shapes that carry no named sections — a
   * blocked / no-work report's reason, an HITL block's verification steps, or an
   * unknown/unparsed block's text. This is what keeps a blocked Run from
   * reaching the Dispatcher as a header with no substance: the meaningful body
   * survives here even when every section field is null. Null for a normal
   * completed block (its substance lives in the section fields).
   */
  detail: string | null;
  /** Which of the three block kinds this was (or `unknown`). */
  outcome: RunOutcome;
}

// A generous ANSI/control-sequence matcher: PTY output is littered with colour
// and cursor-move escapes, so strip them before pattern-matching prose. ESC
// () or the 8-bit CSI () introducer, then an optional parameter run.
// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/** Strip ANSI escapes and normalise CR/LF so the block reads as plain text. */
export function stripAnsi(input: string): string {
  return input
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// The five known section labels, in emit order, each mapped to its record key.
// Aliases keep the parser tolerant of minor wording drift ("Try it" vs "Try it
// yourself", "Doc-drift" vs "Doc drift").
type SectionKey = 'whatChanged' | 'tryIt' | 'verified' | 'bookkeeping' | 'docDrift';

function labelToKey(label: string): SectionKey | null {
  const l = label.toLowerCase().replace(/[\s-]+/g, ' ').trim();
  if (l.startsWith('what changed')) return 'whatChanged';
  if (l.startsWith('try it')) return 'tryIt';
  if (l === 'verified') return 'verified';
  if (l === 'bookkeeping') return 'bookkeeping';
  if (l.startsWith('doc drift')) return 'docDrift';
  return null;
}

// Matches the start of a labelled section anywhere at a line start: optional
// bullet / heading marker, optional bold, the label, optional bold close, and
// an optional separator (em/en dash, colon, hyphen). The label group is what we
// key on; everything up to the NEXT such header is that section's body.
const SECTION_HEADER =
  /(?:^|\n)[ \t]*(?:[-•]\s*)?(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:\*\*|__)?\s*(What changed|Try it yourself|Try it|Verified|Bookkeeping|Doc[\s-]?drift)\s*(?:\*\*|__)?\s*[:—–-]?[ \t]*/gi;

/** Pull each labelled section's body out of a block body. */
function extractSections(body: string): Record<SectionKey, string | null> {
  const out: Record<SectionKey, string | null> = {
    whatChanged: null,
    tryIt: null,
    verified: null,
    bookkeeping: null,
    docDrift: null,
  };

  const hits: { key: SectionKey; contentStart: number; headerStart: number }[] = [];
  SECTION_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_HEADER.exec(body)) !== null) {
    const key = labelToKey(m[1]);
    if (key) {
      hits.push({ key, contentStart: m.index + m[0].length, headerStart: m.index });
    }
  }

  for (let i = 0; i < hits.length; i++) {
    const { key, contentStart } = hits[i];
    // First occurrence of a label wins; a later stray mention can't clobber it.
    if (out[key] !== null) continue;
    const end = i + 1 < hits.length ? hits[i + 1].headerStart : body.length;
    const content = body.slice(contentStart, end).trim();
    out[key] = content.length > 0 ? content : null;
  }

  return out;
}

/** Recover a numeric issue id from an `issue NN` mention, or null. */
function findIssueId(text: string): number | null {
  const byWord = /\bissue\s+#?(\d+)/i.exec(text);
  if (byWord) return Number(byWord[1]);
  return null;
}

// A completion block's defining heading: `## Completed issue NN — <slug>`.
const COMPLETED_HEADING = /(?:^|\n)[ \t]*#{0,6}\s*Completed issue\s+(\d+)\s*[—–-]?\s*([^\n]*)/i;

// The HITL block is explicitly labelled "Ready for manual verification".
const NEEDS_VERIFICATION = /ready for manual verification/i;

/** Heuristics for a "blocked / no work available" report. */
function looksBlocked(text: string): boolean {
  return (
    /no\s+work\s+available/i.test(text) ||
    /no\s+afk[- ]eligible\s+work/i.test(text) ||
    /(?:^|\n)[ \t]*#{0,6}\s*blocked\b/i.test(text) ||
    /\bstopped because\b/i.test(text) ||
    /\bblocked\b[\s\S]{0,60}\b(?:wip|depend|recommend|bottleneck)/i.test(text)
  );
}

const EMPTY: CompletionRecord = {
  issue: null,
  issueId: null,
  whatChanged: null,
  tryIt: null,
  verified: null,
  bookkeeping: null,
  docDrift: null,
  detail: null,
  outcome: 'unknown',
};

/**
 * The report body to carry for a non-completed shape (blocked / needs-
 * verification / unknown): the whole ANSI-stripped block, trimmed. Captured
 * verbatim so the reason a Run gives — its blocker, its verification steps, or
 * whatever an unparsed block managed to say — reaches the record instead of
 * being dropped. Null only when there is nothing but whitespace.
 */
function captureDetail(text: string): string | null {
  const body = text.trim();
  return body.length > 0 ? body : null;
}

/**
 * Parse a Worker's final output text into a structured Completion record.
 * Tolerant by contract: any input (including non-strings, empty, or pure noise)
 * yields a record — never a throw.
 */
export function parseCompletionBlock(input: unknown): CompletionRecord {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ...EMPTY };
  }

  const text = stripAnsi(input);

  const completed = COMPLETED_HEADING.exec(text);
  if (completed) {
    const id = Number(completed[1]);
    const slug = completed[2].trim();
    // Scope section extraction to the block body (from the heading onward) so a
    // "Verified"-like word in earlier terminal scroll can't be mistaken for a
    // section header.
    const body = text.slice(completed.index);
    const sections = extractSections(body);
    return {
      issue: slug ? `${id} — ${slug}` : String(id),
      issueId: Number.isFinite(id) ? id : null,
      ...sections,
      // A completed block's substance is its section fields; no free-form body.
      detail: null,
      outcome: 'completed',
    };
  }

  if (NEEDS_VERIFICATION.test(text)) {
    const sections = extractSections(text);
    return {
      issue: null,
      issueId: findIssueId(text),
      ...sections,
      detail: captureDetail(text),
      outcome: 'needs-verification',
    };
  }

  if (looksBlocked(text)) {
    const sections = extractSections(text);
    return {
      issue: null,
      issueId: findIssueId(text),
      ...sections,
      detail: captureDetail(text),
      outcome: 'blocked',
    };
  }

  // Malformed / unrecognised: still best-effort any sections that happen to be
  // present, but flag it `unknown` so nothing downstream treats it as a real
  // completion. Carry the body verbatim so an unparsed block isn't silently
  // reduced to an empty header.
  const sections = extractSections(text);
  return {
    issue: null,
    issueId: findIssueId(text),
    ...sections,
    detail: captureDetail(text),
    outcome: 'unknown',
  };
}
