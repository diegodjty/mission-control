/**
 * Attention Reader — the file-I/O adapter for the pure attention model
 * (issue 79, ADR-0016; the edge under issue 78's `deriveAttention`).
 *
 * Given the workbench root and one project's directory name, it reads that
 * project's workbench artifacts off disk — `issues/` (through the backlog
 * reader), `completions/` Receipts, `memory/CORE.proposed.md` presence,
 * `HUMAN-SETUP.md`, and `memory/journal/` entries — into the plain
 * `AttentionInput` value the pure model derives from. All classification
 * logic lives in `src/shared/attention-model`; this file only reads.
 *
 * Read-only by contract (the whole issue-79 service is): nothing here writes,
 * creates, or commits anything, ever.
 *
 * Never throws: a missing directory or unreadable file degrades to the empty
 * shape (`[]`, `null`, `false`) — an unregistered-looking project simply
 * derives no items. Only `.md` files are read from `completions/` and
 * `memory/journal/` (issue 78's doc-drift note: a `.gitkeep` or stray editor
 * artifact is not a Receipt and not a journal entry).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readBacklogAt } from './backlog-reader';
import type { AttentionInput, JournalFile } from '../shared/attention-model';
import type { Backlog } from '../shared/backlog-model';
import { parseReceipt, type ReceiptRecord } from '../shared/receipt-parser';

/** The empty backlog — what a project with no readable `issues/` derives from. */
const EMPTY_BACKLOG: Backlog = { activePrd: null, issues: [] };

/** Read a directory's `.md` files as `{ name, content }`, sorted by name. */
async function readMarkdownFiles(dir: string): Promise<JournalFile[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no such directory (yet) — nothing to read
  }
  const files: JournalFile[] = [];
  for (const name of names) {
    try {
      files.push({ name, content: await readFile(join(dir, name), 'utf8') });
    } catch {
      // Deleted between the listing and the read — skip it, keep the rest.
    }
  }
  return files;
}

/** True when `path` exists as a regular file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read one workbench project's artifacts into the pure model's input shape.
 * `lastSeen` is the caller's briefing stamp (app userData, issue 80) — this
 * adapter never persists or invents one.
 */
export async function readAttentionInput(
  workbenchRoot: string,
  project: string,
  lastSeen: string | null,
): Promise<AttentionInput> {
  const projectRoot = join(workbenchRoot, project);

  const backlog = await readBacklogAt(join(projectRoot, 'issues')).catch(() => EMPTY_BACKLOG);

  const receipts: ReceiptRecord[] = (
    await readMarkdownFiles(join(projectRoot, 'completions'))
  ).map((f) => parseReceipt(f.content));

  const coreProposedPresent = await fileExists(join(projectRoot, 'memory', 'CORE.proposed.md'));

  const humanSetup = await readFile(join(projectRoot, 'HUMAN-SETUP.md'), 'utf8').catch(
    () => null,
  );

  const journal = await readMarkdownFiles(join(projectRoot, 'memory', 'journal'));

  return { project, backlog, receipts, coreProposedPresent, humanSetup, journal, lastSeen };
}
