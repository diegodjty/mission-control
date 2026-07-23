/**
 * Session-end actions (PURE) — issue 199.
 *
 * The two explicit actions that close the Guided QA loop (issue 198):
 *
 *  - **Fail → prefilled draft.** A failed step offers a prefilled issue draft
 *    (title from the step's action, an expected-vs-observed body with
 *    provenance) that the human may edit before filing — never silently
 *    written (the Inbox rule).
 *  - **Green → done-flip.** An all-pass session offers a single confirm that
 *    flips the source issue to `done` through the same validated write path
 *    issue 89's editor already uses (`markVerifiedDoneText` +
 *    `writeIssueText`/`editIssueFile`) — this module only shapes the DRAFT
 *    text; the flip transform itself already lives in `checklist-model.ts`.
 *
 * PURE: no I/O, no runtime imports — the fs edge (numbering, atomic write,
 * recording the outcome on the QA pass) lives in `main/index.ts`, mirroring
 * the Quick fix (issue 81) split between `launcher-model.ts` and its handler.
 */
import { padIssueNumber } from './launcher-model';

/** The step shape a draft is built from — just what the draft body needs. */
export interface QaFollowupStep {
  action: string;
  expected: string;
}

/**
 * The draft's title, derived from the step's action: collapsed to one line,
 * trimmed, capped so a long action sentence doesn't produce an unwieldy
 * heading. Falls back to a generic label for an empty/garbage action, never ''.
 */
export function qaDraftTitle(step: QaFollowupStep): string {
  const action = (typeof step?.action === 'string' ? step.action : '').replace(/\s+/g, ' ').trim();
  const capped = action.slice(0, 120);
  return capped.length > 0 ? capped : 'Guided QA fail';
}

/** The provenance + expected-vs-observed a draft's body is prefilled with. */
export interface QaDraftPrefillInput {
  step: QaFollowupStep;
  /** The human's fail note ("what I actually saw"), or null/empty. */
  note: string | null;
  /** The source issue's plain file name (e.g. `198-guided-....md`). */
  sourceIssueFileName: string;
  /** The QA pass file name this fail was recorded in (`qaPassFileName`). */
  qaPassFileName: string;
  /**
   * The source issue's completion Receipt file name, when one exists (a
   * fresh issue with no Run yet has none) — `completions/<name>`.
   */
  receiptFileName: string | null;
}

/**
 * The draft's prefilled body: an expected-vs-observed section plus provenance
 * naming the QA pass file, the source issue, and its Receipt (when any) — so
 * filing the draft never loses the trail back to the session that found it.
 * The human may edit this freely before confirming; nothing here is written
 * until they do.
 */
export function qaDraftBody(input: QaDraftPrefillInput): string {
  const expected = (typeof input?.step?.expected === 'string' ? input.step.expected : '').trim();
  const note = (typeof input?.note === 'string' ? input.note : '').trim();
  const observed = note.length > 0 ? note : '(no note recorded)';

  const provenance = [
    `- QA receipt: \`qa/${input?.qaPassFileName ?? '(unknown pass)'}\``,
    `- Source issue: \`${input?.sourceIssueFileName ?? '(unknown issue)'}\``,
  ];
  if (input?.receiptFileName !== null && input?.receiptFileName !== undefined) {
    provenance.push(`- Completion Receipt: \`completions/${input.receiptFileName}\``);
  }

  return [
    '## Source',
    '',
    `Guided QA fail, from a step in ${input?.sourceIssueFileName ?? '(unknown issue)'}.`,
    '',
    ...provenance,
    '',
    '## Expected vs. observed',
    '',
    `**Expected:** ${expected.length > 0 ? expected : '(no expected outcome recorded)'}`,
    '',
    `**Observed:** ${observed}`,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The observed behavior above is fixed and matches the expected outcome.',
    '',
  ].join('\n');
}

/** The full content of a new draft issue: standalone (no `## Parent`), `status: open`. */
export interface QaDraftIssueInput {
  /** The issue number this file claims (from the numbering fs edge). */
  id: number;
  /** The draft's title (editable — seeded from `qaDraftTitle`). */
  title: string;
  /** The draft's body (editable — seeded from `qaDraftBody`). */
  body: string;
}

export function buildQaDraftIssue(input: QaDraftIssueInput): string {
  const num = padIssueNumber(input.id);
  const title = (typeof input?.title === 'string' ? input.title : '').replace(/\s+/g, ' ').trim();
  const body = (typeof input?.body === 'string' ? input.body : '').trim();
  return ['---', 'status: open', 'depends_on: []', '---', '', `# ${num} — ${title}`, '', body, ''].join(
    '\n',
  );
}
