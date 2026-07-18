/**
 * Attention Reader — the file-I/O adapter for the pure attention model
 * (issue 79, ADR-0016; the edge under issue 78's `deriveAttention`).
 *
 * Given the workbench root and one project's directory name, it reads that
 * project's workbench artifacts off disk — `issues/` (through the backlog
 * reader), `completions/` Receipts, `memory/CORE.proposed.md` presence,
 * `HUMAN-SETUP.md`, and `memory/journal/` entries — into the plain
 * `AttentionInput` value the pure model derives from. For the self-heal
 * detector (issue 95, ADR-0017) it also reads the project's `CONFIG.md`
 * (`workspace_root` + `repos:` map), the workspace root's top-level dirs (each
 * probed for a `.git`), and the workbench `registry.md`. All classification
 * logic lives in `src/shared/attention-hub-model`; this file only reads.
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
import type { AttentionInput, JournalFile } from '../shared/attention-hub-model';
import { EMPTY_BACKLOG } from '../shared/backlog-model';
import { parseReceipt, type ReceiptRecord } from '../shared/receipt-parser';
import type { SelfHealInput, WorkspaceEntry } from '../shared/self-heal';
import { expandTilde, parseProjectConfig } from '../shared/workbench-model';

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

/** True when `path` exists at all (a `.git` may be a dir OR a worktree file). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List the workspace root's top-level directories, each tagged with whether it
 * holds a `.git` — the self-heal detector's raw material (issue 95). A missing/
 * unreadable workspace root degrades to `[]` (nothing to detect). Only
 * directories are listed; a stray file at the workspace root is not a repo.
 */
async function readWorkspaceEntries(workspaceRoot: string): Promise<WorkspaceEntry[]> {
  let dirs: string[];
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // workspace root doesn't exist yet — no candidates
  }
  const out: WorkspaceEntry[] = [];
  for (const name of dirs) {
    out.push({ name, isGit: await pathExists(join(workspaceRoot, name, '.git')) });
  }
  return out;
}

/**
 * Gather the self-heal detector's input (issue 95, ADR-0017): the project's
 * CONFIG (for its `workspace_root` + `repos:` map), the workspace root's
 * top-level entries, and the whole workbench's registry. Read-only. When the
 * project declares no workspace root (legacy / pre-0017), returns null — there
 * is nothing to detect, so the pure model derives no candidates.
 */
async function readSelfHealInput(
  workbenchRoot: string,
  projectRoot: string,
  homeDir: string | null,
): Promise<SelfHealInput | null> {
  const configContent = await readFile(join(projectRoot, 'CONFIG.md'), 'utf8').catch(() => null);
  const config = parseProjectConfig(configContent);
  if (config.workspaceRoot === null) return null;

  const workspaceRoot = expandTilde(config.workspaceRoot, homeDir);
  const [entries, registryContent] = await Promise.all([
    readWorkspaceEntries(workspaceRoot),
    readFile(join(workbenchRoot, 'registry.md'), 'utf8').catch(() => null),
  ]);
  return { workspaceRoot, entries, repos: config.repos, registryContent, homeDir };
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
  homeDir: string | null = null,
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

  const selfHeal = await readSelfHealInput(workbenchRoot, projectRoot, homeDir);

  return { project, backlog, receipts, coreProposedPresent, humanSetup, journal, lastSeen, selfHeal };
}
