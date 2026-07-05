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
 *     (Grill / PRD / Issues) types into the Pane;
 *   - **doc parsing** — frontmatter + a small legible markdown-block parse for
 *     the read-only preview (this repo deliberately has no markdown
 *     dependency; the preview needs "legible", not CommonMark).
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

/** Button rendering order + labels for the Planning view's stage bar. */
export const PLANNING_STAGES: ReadonlyArray<{ stage: PlanningStage; label: string }> = [
  { stage: 'grill', label: 'Grill' },
  { stage: 'prd', label: 'PRD' },
  { stage: 'issues', label: 'Issues' },
];

/**
 * The exact skill invocation a stage button types into the Pane (through the
 * submit pump — typed then submitted, honoring the typing gate).
 */
export function stageInvocation(stage: PlanningStage): string {
  switch (stage) {
    case 'grill':
      return '/grill-with-docs';
    case 'prd':
      return '/to-prd';
    case 'issues':
      return '/to-issues';
  }
}

// --- Preview parsing (frontmatter + legible markdown blocks) ---------------------

/** One `key: value` frontmatter line (issue files: status / depends_on / hitl). */
export interface FrontmatterField {
  /** The key, or '' for a line that isn't `key: value` (kept verbatim). */
  key: string;
  value: string;
}

/** One list item; `checked` is null for a plain (non-checkbox) item. */
export interface PlanningListItem {
  text: string;
  checked: boolean | null;
}

/** The block shapes the preview renders. Legible, not CommonMark. */
export type PlanningBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'list'; ordered: boolean; items: PlanningListItem[] };

export interface ParsedPlanningDoc {
  frontmatter: FrontmatterField[];
  blocks: PlanningBlock[];
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const ORDERED_ITEM_RE = /^\s*\d+[.)]\s+/;
const CHECKBOX_RE = /^\[([ xX])\]\s*(.*)$/;

/**
 * Parse one document into frontmatter fields + markdown blocks for the
 * read-only preview. Handles what the pipeline's documents actually use:
 * a leading `---` frontmatter block, ATX headings, fenced code, blockquotes,
 * horizontal rules, ordered/unordered lists with `- [ ]` checkboxes, and
 * paragraphs. Never throws; unrecognized lines are paragraph text.
 */
export function parsePlanningDoc(content: string): ParsedPlanningDoc {
  const frontmatter: FrontmatterField[] = [];
  let body = content;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    for (const raw of fmMatch[1].split(/\r?\n/)) {
      if (raw.trim().length === 0) continue;
      const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(raw.trim());
      if (kv) frontmatter.push({ key: kv[1].trim(), value: kv[2].trim() });
      else frontmatter.push({ key: '', value: raw.trim() });
    }
  }

  const blocks: PlanningBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: PlanningListItem[] } | null = null;

  const flushPara = (): void => {
    if (para.length > 0) blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  const flushQuote = (): void => {
    if (quote.length > 0) blocks.push({ kind: 'quote', text: quote.join(' ') });
    quote = [];
  };
  const flushList = (): void => {
    if (list !== null && list.items.length > 0)
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushAll = (): void => {
    flushPara();
    flushQuote();
    flushList();
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');

    if (code !== null) {
      if (line.trim().startsWith('```')) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushAll();
      code = [];
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    if (line.startsWith('>')) {
      flushPara();
      flushList();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      const ordered = ORDERED_ITEM_RE.test(line);
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      const checkbox = CHECKBOX_RE.exec(item[1]);
      list.items.push(
        checkbox
          ? { text: checkbox[2], checked: checkbox[1] !== ' ' }
          : { text: item[1], checked: null },
      );
      continue;
    }

    // A continuation line while a list is open belongs to its last item.
    if (list !== null && /^\s+\S/.test(raw)) {
      const last = list.items[list.items.length - 1];
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }

    flushQuote();
    flushList();
    para.push(line.trim());
  }

  if (code !== null && code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') });
  flushAll();

  return { frontmatter, blocks };
}

// --- Inline formatting -------------------------------------------------------------

/** One inline run of a block's text: plain, `code`, or **bold**. */
export interface InlineSegment {
  kind: 'text' | 'code' | 'bold';
  text: string;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

/**
 * Split a block's text into inline segments — code spans and bold runs — so
 * the preview renders them legibly without a markdown dependency. Anything
 * else stays literal text.
 */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) segments.push({ kind: 'text', text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith('`')) segments.push({ kind: 'code', text: token.slice(1, -1) });
    else segments.push({ kind: 'bold', text: token.slice(2, -2) });
    last = idx + token.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
