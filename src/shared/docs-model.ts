/**
 * Docs-tab model (PURE) — issue 182, ADR-0023.
 *
 * The Docs tab browses the active project's default-repo documentation
 * through the shared rich viewer (issue 179): `docs/ARCHITECTURE.md` (the
 * four living diagrams) first, then `CONTEXT.md`, then the `docs/adr/` list —
 * file-watched like the Planning view's live preview (issue 83), but scoped
 * to the repo alone (no workbench PRDs/issues to watch).
 *
 * PURE: no I/O, no Electron, no timers.
 */

/** The one root Docs documents live under. */
export interface DocsRoots {
  /** The active project's default code repo. */
  repoPath: string;
}

/** Which section of the picker a doc belongs to. */
export type DocGroup = 'architecture' | 'context' | 'adr';

/** One entry in the Docs picker. */
export interface DocEntry {
  /** Absolute path on disk. */
  path: string;
  /** Compact display label, e.g. `CONTEXT.md`, `docs/adr/0001-x.md`. */
  label: string;
  group: DocGroup;
  /**
   * Last-modified stamp (ms since epoch). The picker doesn't sort or show
   * this — it exists so a content-only edit (no file added/removed) still
   * changes the pushed set, which is what tells the view to refetch the
   * selected doc's content (mirrors the Planning-view watch pattern).
   */
  mtimeMs: number;
}

/** One file observed by the adapter's scan of `docs/adr/`. */
export interface ScannedDocFile {
  name: string;
  mtimeMs: number;
}

/** Everything the adapter's scan of the repo's doc locations observed. */
export interface DocsScan {
  /** ARCHITECTURE.md's mtime, or null when it doesn't exist. */
  architectureMtimeMs: number | null;
  /** CONTEXT.md's mtime, or null when it doesn't exist. */
  contextMtimeMs: number | null;
  adrFiles: ScannedDocFile[];
}

/** A visible markdown file (dotfiles and non-`.md` files are not docs). */
function isMarkdownName(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.');
}

/** Strip trailing slashes so path comparisons don't depend on caller style. */
function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '');
}

/**
 * Turn one scan of the repo's doc locations into the picker's entries:
 * ARCHITECTURE.md first (the primary surface the issue calls out), then
 * CONTEXT.md, then the ADRs in file-name order (their `NNNN-` prefix already
 * sorts them chronologically). Missing files/dirs simply contribute nothing.
 */
export function deriveDocEntries(roots: DocsRoots, scan: DocsScan): DocEntry[] {
  const repoPath = normalizeDir(roots.repoPath);
  const entries: DocEntry[] = [];

  if (scan.architectureMtimeMs !== null) {
    entries.push({
      path: `${repoPath}/docs/ARCHITECTURE.md`,
      label: 'ARCHITECTURE.md',
      group: 'architecture',
      mtimeMs: scan.architectureMtimeMs,
    });
  }
  if (scan.contextMtimeMs !== null) {
    entries.push({
      path: `${repoPath}/CONTEXT.md`,
      label: 'CONTEXT.md',
      group: 'context',
      mtimeMs: scan.contextMtimeMs,
    });
  }
  const adrFiles = scan.adrFiles
    .filter((f) => isMarkdownName(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const f of adrFiles) {
    entries.push({
      path: `${repoPath}/docs/adr/${f.name}`,
      label: `docs/adr/${f.name}`,
      group: 'adr',
      mtimeMs: f.mtimeMs,
    });
  }

  return entries;
}

// --- Watch relevance (which fs.watch events warrant a re-scan) -----------------

/**
 * Is a change reported by the REPO-ROOT watch (non-recursive) relevant?
 * `CONTEXT.md` lives at the root; `docs` is also relevant because
 * `docs/ARCHITECTURE.md` and `docs/adr/` may appear after the watch attached
 * (the adapter re-tries those attaches on the re-scan this triggers).
 */
export function isRepoDocsChange(rel: string | null): boolean {
  if (rel === null) return true;
  const norm = rel.split('\\').join('/');
  return norm === 'CONTEXT.md' || norm === 'docs';
}

/**
 * Is a change reported by the `docs/` watch (non-recursive) relevant?
 * `ARCHITECTURE.md` lives here directly; `adr` is also relevant because the
 * ADR directory may be created after the watch attached.
 */
export function isDocsDirChange(rel: string | null): boolean {
  if (rel === null) return true;
  const norm = rel.split('\\').join('/');
  return norm === 'ARCHITECTURE.md' || norm === 'adr';
}

/** Is a change reported by the `docs/adr/` watch (non-recursive) relevant? */
export function isAdrDocsChange(rel: string | null): boolean {
  if (rel === null) return true;
  return isMarkdownName(rel.split('\\').join('/'));
}

// --- Read allowlist -------------------------------------------------------------

/** The directory part of an absolute path (empty when there is no separator). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * May the doc-read IPC serve this path? Exactly `docs/ARCHITECTURE.md`,
 * `CONTEXT.md`, or a `docs/adr/*.md` file under this repo — and nothing else.
 * `..` segments never pass, so the read channel can't be steered at arbitrary
 * files.
 */
export function isAllowedDoc(roots: DocsRoots, path: string): boolean {
  if (!path.endsWith('.md')) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!isMarkdownName(name)) return false;
  const repoPath = normalizeDir(roots.repoPath);
  const dir = dirOf(path);
  return (
    path === `${repoPath}/docs/ARCHITECTURE.md` ||
    path === `${repoPath}/CONTEXT.md` ||
    dir === `${repoPath}/docs/adr`
  );
}
