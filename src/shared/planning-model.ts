/**
 * Planning-view model (PURE) — issue 83, ADR-0016.
 *
 * The thin Planning view puts a normal warm Pane beside a LIVE preview of the
 * documents planning writes: the project's workbench PRDs and issues, and the
 * repo's `CONTEXT.md` / `docs/adr/`. This module holds every decision that
 * doesn't need I/O:
 *
 *   - **watched-set derivation** — which files under the planning roots are
 *     planning documents, with a display label and group per doc;
 *   - **recency ordering** — most-recently-changed first, so the doc being
 *     written right now floats to the top of the preview's list;
 *   - **watch relevance** — which `fs.watch` events warrant a re-scan (the
 *     adapter filters through these, ADR-0006 discipline);
 *   - **read allowlist** — whether a renderer-requested path is one of the
 *     watched planning docs (the doc-read IPC must not be an arbitrary-file
 *     read);
 *   - **stage invocations** — the exact skill invocation each stage button
 *     (Grill / PRD / Issues) types into the Pane.
 *
 * Doc parsing (frontmatter + markdown blocks) moved to `rich-viewer-model.ts`
 * (issue 179) once a third view needed the exact same renderer — see that
 * module's header.
 *
 * PURE: no I/O, no Electron, no timers. Shared by main (watcher + read
 * handler) and renderer (preview rendering).
 */

/** The two roots planning documents live under. */
export interface PlanningRoots {
  /** The workbench project root (`~/Workbench/<project>`). */
  workbenchDir: string;
  /** The project's default code repo (`CONTEXT.md` / `docs/adr/` live here). */
  repoPath: string;
}

/** Where a planning doc lives — drives its badge in the preview list. */
export type PlanningDocGroup = 'workbench' | 'issue' | 'repo';

/** One watched planning document, as the preview list shows it. */
export interface PlanningDoc {
  /** Absolute path on disk. */
  path: string;
  /** Compact display label, e.g. `PRD.md`, `issues/83-planning-view-v1.md`. */
  label: string;
  group: PlanningDocGroup;
  /** Last-modified stamp (ms since epoch) — the recency-ordering key. */
  mtimeMs: number;
}

/** One file observed by the adapter's scan of a single directory. */
export interface ScannedFile {
  /** Base name within the scanned directory (no separators). */
  name: string;
  mtimeMs: number;
}

/** Everything the adapter's scan of the planning roots observed. */
export interface PlanningScan {
  /** Top-level files of the workbench project dir (PRDs, CONFIG, …). */
  workbenchFiles: ScannedFile[];
  /** Files of the workbench `issues/` dir. */
  issueFiles: ScannedFile[];
  /** The repo `CONTEXT.md` mtime, or null when it doesn't exist. */
  contextMtimeMs: number | null;
  /** Files of the repo's `docs/adr/` dir. */
  adrFiles: ScannedFile[];
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
 * Order docs most-recently-changed FIRST (ties: label ascending, so the order
 * is deterministic when a scan stamps several files identically). This is what
 * floats the doc being written right now to the top of the preview list.
 */
export function orderPlanningDocs(docs: PlanningDoc[]): PlanningDoc[] {
  return [...docs].sort((a, b) => b.mtimeMs - a.mtimeMs || a.label.localeCompare(b.label));
}

/**
 * Turn one scan of the planning roots into the ordered watched set: workbench
 * top-level `.md` files (the PRDs, CONFIG, HUMAN-SETUP), the backlog's issue
 * files, and the repo's `CONTEXT.md` + ADRs — labeled, grouped, and ordered by
 * recency.
 */
export function derivePlanningDocs(roots: PlanningRoots, scan: PlanningScan): PlanningDoc[] {
  const workbenchDir = normalizeDir(roots.workbenchDir);
  const repoPath = normalizeDir(roots.repoPath);
  const docs: PlanningDoc[] = [];
  for (const f of scan.workbenchFiles) {
    if (!isMarkdownName(f.name)) continue;
    docs.push({
      path: `${workbenchDir}/${f.name}`,
      label: f.name,
      group: 'workbench',
      mtimeMs: f.mtimeMs,
    });
  }
  for (const f of scan.issueFiles) {
    if (!isMarkdownName(f.name)) continue;
    docs.push({
      path: `${workbenchDir}/issues/${f.name}`,
      label: `issues/${f.name}`,
      group: 'issue',
      mtimeMs: f.mtimeMs,
    });
  }
  if (scan.contextMtimeMs !== null) {
    docs.push({
      path: `${repoPath}/CONTEXT.md`,
      label: 'CONTEXT.md',
      group: 'repo',
      mtimeMs: scan.contextMtimeMs,
    });
  }
  for (const f of scan.adrFiles) {
    if (!isMarkdownName(f.name)) continue;
    docs.push({
      path: `${repoPath}/docs/adr/${f.name}`,
      label: `docs/adr/${f.name}`,
      group: 'repo',
      mtimeMs: f.mtimeMs,
    });
  }
  return orderPlanningDocs(docs);
}

// --- Watch relevance (which fs.watch events warrant a re-scan) -----------------

/**
 * Is a change reported by the WORKBENCH project-dir watch (recursive) one the
 * planning preview reads from? Top-level `.md` files and `issues/` — NOT
 * `completions/` (Receipts), `memory/` (journal churn), or `.git/` (the
 * workbench auto-commit after every Run event would otherwise re-scan
 * constantly). A null name (platform gave none) re-scans to be safe.
 */
export function isWorkbenchPlanningChange(rel: string | null): boolean {
  if (rel === null) return true;
  const norm = rel.split('\\').join('/');
  if (norm === '.git' || norm.startsWith('.git/')) return false;
  if (norm === 'issues' || norm.startsWith('issues/')) return true;
  return !norm.includes('/') && isMarkdownName(norm);
}

/**
 * Is a change reported by the REPO-ROOT watch (non-recursive) relevant?
 * Only `CONTEXT.md` lives at the repo root; `docs/` is also relevant because
 * `docs/adr/` may be created after the watch attached (the adapter re-tries
 * its ADR watch on the re-scan this triggers).
 */
export function isRepoPlanningChange(rel: string | null): boolean {
  if (rel === null) return true;
  const norm = rel.split('\\').join('/');
  return norm === 'CONTEXT.md' || norm === 'docs';
}

/** Is a change reported by the `docs/adr/` watch (non-recursive) relevant? */
export function isAdrPlanningChange(rel: string | null): boolean {
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
 * May the doc-read IPC serve this path? Exactly the watched locations — a
 * top-level workbench `.md`, an `issues/*.md`, the repo `CONTEXT.md`, or a
 * `docs/adr/*.md` — and nothing else. `..` segments never pass, so the preview
 * channel can't be steered at arbitrary files.
 */
export function isAllowedPlanningDoc(roots: PlanningRoots, path: string): boolean {
  if (!path.endsWith('.md')) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!isMarkdownName(name)) return false;
  const workbenchDir = normalizeDir(roots.workbenchDir);
  const repoPath = normalizeDir(roots.repoPath);
  const dir = dirOf(path);
  return (
    dir === workbenchDir ||
    dir === `${workbenchDir}/issues` ||
    path === `${repoPath}/CONTEXT.md` ||
    dir === `${repoPath}/docs/adr`
  );
}

// --- Stage buttons ---------------------------------------------------------------

/** The three planning stages, in pipeline order (grill → PRD → issues). */
export type PlanningStage = 'grill' | 'prd' | 'issues';

/**
 * Button rendering order, labels, and hover hints for the Planning view's
 * stage bar. The label/hint difference is deliberate (issue 91): Grill reads
 * as an unfinished sentence — clicking it only types the prefix — while PRD
 * and Issues read as one-click submits.
 */
export const PLANNING_STAGES: ReadonlyArray<{
  stage: PlanningStage;
  label: string;
  hint: string;
}> = [
  {
    stage: 'grill',
    label: 'Grill…',
    hint: 'Types /grill-with-docs into the session — you finish the sentence with the topic and press Enter (waits for your typing to finish)',
  },
  {
    stage: 'prd',
    label: 'PRD',
    hint: 'Types and submits /to-prd — turns the conversation into a PRD (waits for your typing to finish)',
  },
  {
    stage: 'issues',
    label: 'Issues',
    hint: 'Types and submits /to-issues — breaks the PRD into issues (waits for your typing to finish)',
  },
];

/** What a stage button types into the Pane, and whether it presses Enter. */
export interface StageInvocation {
  /** The exact text typed (a prefix keeps its trailing space). */
  text: string;
  /**
   * `true` = typed then submitted (the invocation takes no argument and acts
   * on conversation context). `false` = typed as a PREFIX only — the user
   * completes the sentence and presses Enter themselves (issue 91).
   */
  submit: boolean;
}

/**
 * The exact invocation each stage button delivers through the submit pump
 * (honoring the defer-while-typing gate either way). Grill needs its topic
 * ("what are we grilling?"), so it is a prefix with a trailing space and NO
 * submit; PRD and Issues take no argument and stay typed+submitted.
 */
export function stageInvocation(stage: PlanningStage): StageInvocation {
  switch (stage) {
    case 'grill':
      return { text: '/grill-with-docs ', submit: false };
    case 'prd':
      return { text: '/to-prd', submit: true };
    case 'issues':
      return { text: '/to-issues', submit: true };
  }
}

