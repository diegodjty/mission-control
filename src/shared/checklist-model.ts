/**
 * HITL checklist parser (PURE) — issue 156.
 *
 * A parked HITL issue's Receipt carries a "Ready for manual verification"
 * block whose steps are ordinary markdown checkbox lines (`- [ ] step` /
 * `- [x] step`) — the same syntax `~/.claude/skills/afk-issue-runner/SKILL.md`
 * already uses for a Receipt's own "Acceptance criteria"-style lists. This
 * module turns that markdown into an ordered checklist model the detail panel
 * can render as real tickable checkboxes.
 *
 * Source precedence (per the issue): the parked Receipt's `detail` body when
 * it actually contains a checklist — that is where a Worker's HITL block's
 * steps live (see `completion-parser.ts`'s `captureDetail`) — else the issue
 * file's own body, so an issue authored with a checklist in its body (no
 * Receipt yet, or a Receipt whose detail is prose with no `- [ ]` lines)
 * still renders one instead of being shadowed by a checkbox-less Receipt.
 *
 * PURE: no I/O. Tolerant by contract — any input (missing, empty, no checkbox
 * lines) yields an empty list, never a throw.
 */

export interface ChecklistItem {
  /** The step text, trimmed of the checkbox marker and surrounding space. */
  text: string;
  /** Whether the source line was already checked (`- [x]`) when parsed. */
  checked: boolean;
}

// A markdown checkbox list item: an optional leading bullet marker (`-`/`*`),
// the `[ ]`/`[x]`/`[X]` checkbox, then the step text to end of line.
const CHECKLIST_LINE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/gm;

/**
 * Extract the ordered checklist from markdown text. Non-checkbox lines
 * (prose, headings, other bullets) are ignored — only real `- [ ]`/`- [x]`
 * lines become items, in source order. Never throws.
 */
export function parseChecklist(input: unknown): ChecklistItem[] {
  if (typeof input !== 'string' || input.trim() === '') return [];
  const items: ChecklistItem[] = [];
  CHECKLIST_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHECKLIST_LINE.exec(input)) !== null) {
    items.push({ text: match[2].trim(), checked: match[1].toLowerCase() === 'x' });
  }
  return items;
}

/**
 * The text to parse a parked issue's checklist from: the Receipt's `detail`
 * body when it actually contains checkbox lines, else the issue file's own
 * body. A non-empty Receipt detail that carries no `- [ ]` lines (e.g. a
 * prose "Try it yourself" numbered list) is not a checklist source — it
 * falls through to the body instead of shadowing it (issue 189).
 */
export function checklistSourceText(
  receiptDetail: string | null | undefined,
  issueBody: string | null | undefined,
): string {
  if (typeof receiptDetail === 'string' && parseChecklist(receiptDetail).length > 0) {
    return receiptDetail;
  }
  return typeof issueBody === 'string' ? issueBody : '';
}

// The closed frontmatter fence — same shape `issue-file-ops.ts` validates
// against: a `---` line, the raw block, a closing `---` line.
const FRONTMATTER_FENCE = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;
const STATUS_LINE = /^(\s*status\s*:\s*)wip(\s*)$/m;

/**
 * Build the full replacement text for a human's "Mark verified & done": the
 * frontmatter's `status: wip` flips to `status: done`, and a one-line
 * sign-off note (with the date) is appended to the body — never a silent
 * flip (the issue's own requirement). Null when the text has no closed
 * frontmatter fence or no `status: wip` line (nothing to flip) — the caller
 * should not write in that case.
 */
export function markVerifiedDoneText(fileText: string, dateIso: string): string | null {
  const fence = FRONTMATTER_FENCE.exec(fileText);
  if (!fence) return null;
  const frontmatter = fence[1];
  if (!STATUS_LINE.test(frontmatter)) return null;
  const flippedFrontmatter = frontmatter.replace(STATUS_LINE, '$1done$2');
  const fenceEnd = fence.index + fence[0].length;
  const body = fileText.slice(fenceEnd);
  const note = `\n_Verified and marked done by human sign-off on ${dateIso}._\n`;
  return `---\n${flippedFrontmatter}\n---\n${body.replace(/\s*$/, '')}\n${note}`;
}
