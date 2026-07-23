/**
 * Guided QA `## QA Steps` schema + strict parser (PURE) — issue 196.
 *
 * A Receipt or an issue body may carry a `## QA Steps` block: an ordered list
 * of steps, each with an **action** (what the human does), an **expected**
 * outcome (what they should see), and an optional **command** (something to
 * run first). See `docs/adr/0025-guided-qa-schema-and-boundary.md` for the
 * full syntax and the batch's decisions.
 *
 * Deterministically parseable (no LLM at view time), tolerant of surrounding
 * prose in the rest of the document, and — like `completion-parser.ts` and
 * `checklist-model.ts` — never throws. Three outcomes:
 *
 *   - no `## QA Steps` heading at all → `null` (legacy 156 checklist path
 *     takes over — see `checklistSourceText`),
 *   - a heading with at least one well-formed step → `{ kind: 'steps', steps }`,
 *   - a heading whose body has no recognisable step (missing Action/Expected,
 *     or nothing at all) → `{ kind: 'error', message }` — a malformed block is
 *     a surfaced parse error, never silently half-parsed.
 *
 * PURE: no I/O, no runtime imports — unit-testable in isolation and safe to
 * share across main/renderer.
 */

export interface QaStep {
  /** What the human does. */
  action: string;
  /** What they should see. */
  expected: string;
  /** Something to run first, or null when the step names no command. */
  command: string | null;
}

export type QaStepsParseResult =
  | { kind: 'steps'; steps: QaStep[] }
  | { kind: 'error'; message: string }
  | null;

// The block's defining heading: a markdown heading whose text is "QA Steps".
const QA_HEADING = /(?:^|\n)[ \t]*#{1,6}[ \t]*QA Steps[ \t]*(?=\n|$)/i;

// The next markdown heading (any level) — where the block's body ends. A
// heading needs at least one non-space character after the `#`s so a lone
// `#` in prose (not a heading) can't prematurely close the block.
const NEXT_HEADING = /\n[ \t]*#{1,6}[ \t]+\S/;

// A top-level step marker: a bullet (`-`/`*`) or an ordinal (`1.`) flush left
// (allowing a little markdown looseness — up to 3 leading spaces). Field
// labels below (Action/Expected/Command) live on more-indented continuation
// lines, so they never look like a new step marker.
const STEP_MARKER = /(?:^|\n)[ \t]{0,3}(?:[-*]|\d+\.)[ \t]+/g;

// A labelled field line inside a step: optional bold, the label, optional
// bold close, then a separator (colon / dash variants).
const FIELD_HEADER =
  /(?:^|\n)[ \t]*(?:\*\*|__)?\s*(Action|Expected|Command)\s*(?:\*\*|__)?\s*[:—–-]\s*/gi;

type FieldKey = 'action' | 'expected' | 'command';

function fieldKey(label: string): FieldKey {
  return label.toLowerCase() as FieldKey;
}

/** Pull the labelled Action/Expected/Command fields out of one step's raw text. */
function extractFields(stepText: string): Record<FieldKey, string | null> {
  const out: Record<FieldKey, string | null> = { action: null, expected: null, command: null };

  const hits: { key: FieldKey; contentStart: number; headerStart: number }[] = [];
  FIELD_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_HEADER.exec(stepText)) !== null) {
    hits.push({ key: fieldKey(m[1]), contentStart: m.index + m[0].length, headerStart: m.index });
  }

  for (let i = 0; i < hits.length; i++) {
    const { key, contentStart } = hits[i];
    if (out[key] !== null) continue;
    const end = i + 1 < hits.length ? hits[i + 1].headerStart : stepText.length;
    // A field's value ends at the next field header, OR at a blank line —
    // whichever comes first. The blank-line cut is what keeps trailing prose
    // after the list (a sign-off line, the next markdown section) from being
    // swallowed into the last field of the last step.
    const slice = stepText.slice(contentStart, end);
    const blankLine = /\n[ \t]*\n/.exec(slice);
    const content = (blankLine ? slice.slice(0, blankLine.index) : slice).trim();
    out[key] = content.length > 0 ? content : null;
  }

  return out;
}

/** Split a `## QA Steps` block's body into its raw per-step chunks, in order. */
function splitSteps(body: string): string[] {
  STEP_MARKER.lastIndex = 0;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = STEP_MARKER.exec(body)) !== null) {
    starts.push(m.index + m[0].length);
  }
  return starts.map((start, i) => body.slice(start, i + 1 < starts.length ? starts[i + 1] : body.length));
}

/**
 * Parse a `## QA Steps` block out of a document. Tolerant by contract: any
 * input (including non-strings) yields a result — never a throw.
 */
export function parseQaSteps(input: unknown): QaStepsParseResult {
  if (typeof input !== 'string') return null;

  const heading = QA_HEADING.exec(input);
  if (!heading) return null;

  const bodyStart = heading.index + heading[0].length;
  const rest = input.slice(bodyStart);
  const nextHeading = NEXT_HEADING.exec(rest);
  const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();

  if (body.length === 0) {
    return { kind: 'error', message: 'QA Steps block is empty — no steps found.' };
  }

  const rawSteps = splitSteps(body).map((s) => s.trim()).filter((s) => s.length > 0);
  if (rawSteps.length === 0) {
    return {
      kind: 'error',
      message: 'QA Steps block has no recognisable steps (expected `- ` or `1. ` bullets).',
    };
  }

  const steps: QaStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const fields = extractFields(rawSteps[i]);
    if (fields.action === null || fields.expected === null) {
      return {
        kind: 'error',
        message: `QA Steps step ${i + 1} is missing a required Action or Expected field.`,
      };
    }
    steps.push({ action: fields.action, expected: fields.expected, command: fields.command });
  }

  return { kind: 'steps', steps };
}

/**
 * The source precedence for Guided QA (mirrors `checklistSourceText` in
 * `checklist-model.ts`, issue 156): the Receipt's `detail` body wins when it
 * carries a `## QA Steps` block, else the issue file's own body — so a
 * body-only block (a never-drained HITL walkthrough, per issue 195, whose
 * steps can only ever live in its body) still produces steps.
 */
export function resolveQaSteps(
  receiptDetail: string | null | undefined,
  issueBody: string | null | undefined,
): QaStepsParseResult {
  const fromReceipt = parseQaSteps(receiptDetail ?? null);
  if (fromReceipt !== null) return fromReceipt;
  return parseQaSteps(issueBody ?? null);
}
