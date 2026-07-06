/**
 * Issue File Ops — the pure validation logic behind the Map's Edit / Delete
 * affordances on issue files (issue 89, ADR-0016 walkthrough finding).
 *
 * The Map is read-only EXCEPT for issue files: the detail panel offers a raw
 * text editor (frontmatter + body, saved back verbatim) and a delete. Every
 * save is validated here — through the REAL backlog parser, so what the
 * editor accepts is exactly what the Map can re-render — and a save that
 * would break parsing is refused with the reason instead of written. Deletes
 * of `wip` issues are refused: a `wip` flip is a claim, someone owns it.
 *
 * PURE: no file/network/Electron I/O. The fs edge lives in
 * `src/main/issue-file-store.ts`; this module only decides.
 */
import { buildBacklog, type IssueStatus } from './backlog-model';

/** A validated edit: write it; or a refusal naming exactly what's wrong. */
export type EditValidation = { ok: true } | { ok: false; reason: string };

const ISSUE_FILE_NAME = /^\d+-[^/\\]+\.md$/;
const FRONTMATTER_BLOCK = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;
const LEGAL_STATUSES: readonly string[] = ['open', 'wip', 'done'];

/**
 * True when `name` is a plain `NN-slug.md` issue file name — no directories,
 * no traversal. Everything the edit/delete edge touches must pass this first,
 * because the file name crosses IPC from the renderer.
 */
export function isIssueFileName(name: string): boolean {
  return ISSUE_FILE_NAME.test(name);
}

/** One raw `key: value` line out of a frontmatter block, or undefined. */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(frontmatter);
  return match ? match[1].trim() : undefined;
}

/**
 * Validate the full replacement text of one issue file before it is written.
 *
 * The backlog parser is deliberately tolerant — a missing frontmatter block or
 * an unknown status silently degrades to `open` when the Map READS a file.
 * For a WRITE that tolerance is a trap (a typo'd `status:` would silently
 * un-claim or re-open an issue), so the editor refuses anything the parser
 * would have to guess about:
 *
 * - the name must be a plain `NN-slug.md`;
 * - the text must open with a closed `---` frontmatter block;
 * - `status:` must be present and one of open | wip | done;
 * - `depends_on:`, when present, must be a `[n, n, …]` list of numbers;
 * - and the result must round-trip through the real `buildBacklog`.
 */
export function validateIssueEdit(fileName: string, text: string): EditValidation {
  if (!isIssueFileName(fileName)) {
    return { ok: false, reason: `"${fileName}" is not an issue file (expected NN-slug.md).` };
  }

  const block = FRONTMATTER_BLOCK.exec(text);
  if (!block) {
    return {
      ok: false,
      reason:
        'The file must start with a closed frontmatter block: a `---` line, ' +
        'the `status:`/`depends_on:` lines, then a closing `---` line.',
    };
  }
  const frontmatter = block[1];

  const status = frontmatterValue(frontmatter, 'status');
  if (status === undefined) {
    return { ok: false, reason: 'The frontmatter has no `status:` line (open | wip | done).' };
  }
  if (!LEGAL_STATUSES.includes(status)) {
    return {
      ok: false,
      reason: `"${status}" is not a legal status — use open, wip or done.`,
    };
  }

  const dependsOn = frontmatterValue(frontmatter, 'depends_on');
  if (dependsOn !== undefined) {
    const inner = dependsOn.replace(/^\[/, '').replace(/\]$/, '').trim();
    const tokens = inner === '' ? [] : inner.split(',').map((t) => t.trim());
    const bad = tokens.find((t) => t === '' || !Number.isFinite(Number(t)));
    if (bad !== undefined) {
      return {
        ok: false,
        reason: `depends_on holds "${bad}", which is not an issue number — use e.g. [12, 30].`,
      };
    }
  }

  // Belt-and-braces: the text must round-trip through the REAL backlog parser
  // to exactly one issue. Given the checks above this always holds, but the
  // parser — not this validator — is the authority on what the Map renders.
  const parsed = buildBacklog([{ name: fileName, content: text }], null);
  if (parsed.issues.length !== 1) {
    return { ok: false, reason: 'The backlog parser could not read this text as one issue.' };
  }

  return { ok: true };
}

/**
 * Why a delete of an issue with this status is refused, or null when it may
 * proceed. `wip` is refused outright — the flip is a claim; a Run or session
 * owns that issue and deleting the file under it steps on the owner. `done`
 * deletes are allowed (the UI puts them behind a "delete anyway" confirm —
 * Receipts and git history survive the file).
 */
export function deleteRefusal(status: IssueStatus): string | null {
  if (status === 'wip') {
    return 'Refused: this issue is wip — a Run or session owns it. Wait for it to finish (or flip it back to open) before deleting.';
  }
  return null;
}
