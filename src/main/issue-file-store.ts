/**
 * Issue File Store — the fs edge for the Map's Edit / Delete of issue files
 * (issue 89, ADR-0016 walkthrough finding).
 *
 * All decisions live in the pure `shared/issue-file-ops` (what a valid save
 * is; why a delete is refused); this module only touches disk. Every entry
 * point re-validates the renderer-supplied file name (plain `NN-slug.md`,
 * nothing else — the issues root is the only directory this module can see)
 * and re-reads current on-disk state before acting, so a stale renderer can
 * never delete a freshly-claimed (`wip`) issue.
 *
 * Failures are reported, never thrown — a refused save/delete is a normal
 * outcome the UI shows, not an exception.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBacklog } from '../shared/backlog-model';
import { deleteRefusal, isIssueFileName, validateIssueEdit } from '../shared/issue-file-ops';

export interface IssueReadOutcome {
  /** The raw file text, or null when it could not be read. */
  content: string | null;
  /** Why reading failed, else null. */
  error: string | null;
}

export interface IssueFileOutcome {
  /** True when the write/delete landed on disk. */
  ok: boolean;
  /** The refusal or fs failure, else null. */
  error: string | null;
}

function badName(fileName: string): string {
  return `"${fileName}" is not an issue file (expected NN-slug.md).`;
}

function describe(err: unknown, fileName: string): string {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return `No issue file named ${fileName} exists in this backlog.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Read one issue file's raw text (frontmatter + body) for the editor. */
export async function readIssueText(
  issuesRoot: string,
  fileName: string,
): Promise<IssueReadOutcome> {
  if (!isIssueFileName(fileName)) return { content: null, error: badName(fileName) };
  try {
    const content = await readFile(join(issuesRoot, fileName), 'utf8');
    return { content, error: null };
  } catch (err) {
    return { content: null, error: describe(err, fileName) };
  }
}

/**
 * Save one issue file's full replacement text, verbatim (byte-what-was-typed
 * — no normalization). Edit is not create: a file that doesn't exist is
 * refused, and a save the pure validator (the real backlog parser's rules)
 * refuses never reaches disk.
 */
export async function writeIssueText(
  issuesRoot: string,
  fileName: string,
  content: string,
): Promise<IssueFileOutcome> {
  if (!isIssueFileName(fileName)) return { ok: false, error: badName(fileName) };
  const validation = validateIssueEdit(fileName, content);
  if (!validation.ok) return { ok: false, error: validation.reason };
  const path = join(issuesRoot, fileName);
  try {
    // Existence check: editing only. (A racing delete between this read and
    // the write would re-create the file — accepted; both ops are the same
    // human at the same detail panel.)
    await readFile(path, 'utf8');
    await writeFile(path, content, 'utf8');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: describe(err, fileName) };
  }
}

/**
 * Delete one issue file. The CURRENT on-disk status decides — a `wip` issue
 * is refused (the flip is a claim; someone owns it) even when the caller's
 * view was stale.
 */
export async function deleteIssueFile(
  issuesRoot: string,
  fileName: string,
): Promise<IssueFileOutcome> {
  if (!isIssueFileName(fileName)) return { ok: false, error: badName(fileName) };
  const path = join(issuesRoot, fileName);
  try {
    const content = await readFile(path, 'utf8');
    const parsed = buildBacklog([{ name: fileName, content }], null);
    const status = parsed.issues[0]?.status ?? 'open';
    const refusal = deleteRefusal(status);
    if (refusal !== null) return { ok: false, error: refusal };
    await unlink(path);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: describe(err, fileName) };
  }
}
