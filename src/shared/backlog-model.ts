/**
 * Backlog Model — the pure source of truth for the Map.
 *
 * Takes the RAW contents of a Project's `issues/*.md` files plus its
 * `issues/CONFIG.md`, and returns a structured backlog: per-issue status,
 * dependencies, Parent/Source, in-batch vs. standalone classification, and
 * HITL flags. It mirrors the afk-issue-runner's own pick logic.
 *
 * This module is PURE: it does no file/network/Electron I/O. The reading of
 * files off disk happens in an adapter (main process) that then calls
 * `buildBacklog`. Keeping it pure is what makes it unit-testable in isolation
 * (see PRD "Testing Decisions").
 */

export type IssueStatus = 'open' | 'wip' | 'done';

/** One raw issue file: its base name and full text content. */
export interface RawFile {
  /** Base file name, e.g. `02-open-project-backlog-map.md`. */
  name: string;
  /** Full markdown content of the file. */
  content: string;
}

export interface BacklogIssue {
  /** Numeric id parsed from the `NN` prefix of the file name. */
  id: number;
  /** The `slug` portion of `NN-slug.md`. */
  slug: string;
  /** Base file name, for adapters that need to write the file back. */
  fileName: string;
  /** The level-1 heading text, or the slug when there is no heading. */
  title: string;
  status: IssueStatus;
  /** Issue ids this one is blocked by (from `depends_on` frontmatter). */
  dependsOn: number[];
  /** The PRD path referenced in the `## Parent` section, or null (standalone). */
  parent: string | null;
  /** The pointer text in a `## Source` section, or null. */
  source: string | null;
  /** True if `hitl: true` in frontmatter, or `(HITL)` is in the heading. */
  hitl: boolean;
  /**
   * The issue's declared `repo:` frontmatter key — a key into its workbench
   * project CONFIG's `repos:` map (ADR-0015, issue 72). Null when omitted
   * (= the project's default repo; every legacy issue). One issue targets
   * exactly one repo.
   */
  repoKey: string | null;
  /** True when `parent` matches the active PRD from CONFIG. */
  inBatch: boolean;
  /** True when the issue has no `## Parent` section at all. */
  standalone: boolean;
  /** Full markdown body (everything after the frontmatter). */
  body: string;
}

export interface Backlog {
  /** The active PRD path from `issues/CONFIG.md`, or null if none set. */
  activePrd: string | null;
  /** Issues sorted ascending by id. */
  issues: BacklogIssue[];
}

const ISSUE_FILE = /^(\d+)-(.+)\.md$/;
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const BACKTICK = /`([^`]+)`/;

/** Split frontmatter (raw key/value block) from the markdown body. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER.exec(content);
  if (!match) return { frontmatter: '', body: content.trim() };
  return { frontmatter: match[1], body: content.slice(match[0].length).trim() };
}

/** Read a single `key: value` line out of a raw frontmatter block. */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(frontmatter);
  return match ? match[1].trim() : undefined;
}

/** Parse a `[1, 2, 3]`-style list into an array of numbers. */
function parseNumberList(raw: string | undefined): number[] {
  if (!raw) return [];
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

/** The text of a `## Heading` section, up to the next heading (or EOF). */
function sectionBody(body: string, heading: string): string | null {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim().replace(/\s+/g, ' ') === `## ${heading}`);
  if (start === -1) return null;
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

/** First backtick-quoted token in a chunk of text, else null. */
function firstBacktick(text: string | null): string | null {
  if (!text) return null;
  const match = BACKTICK.exec(text);
  return match ? match[1].trim() : null;
}

/** Level-1 heading text (`# ...`), or null if there is none. */
function firstHeading(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

/** Extract the active PRD path from `issues/CONFIG.md` content. */
export function parseActivePrd(configContent: string | null): string | null {
  if (!configContent) return null;
  return firstBacktick(sectionBody(configContent, 'Active PRD'));
}

function parseIssue(file: RawFile, id: number, slug: string): BacklogIssue {
  const { frontmatter, body } = splitFrontmatter(file.content);

  const statusRaw = frontmatterValue(frontmatter, 'status');
  const status: IssueStatus =
    statusRaw === 'wip' || statusRaw === 'done' ? statusRaw : 'open';

  const dependsOn = parseNumberList(frontmatterValue(frontmatter, 'depends_on'));
  const hitlFrontmatter = frontmatterValue(frontmatter, 'hitl') === 'true';
  // The optional `repo:` target (issue 72). Frontmatter only — a `repo:` line
  // in the body is prose. An empty value degrades to null (= default repo).
  const repoRaw = frontmatterValue(frontmatter, 'repo')?.replace(/^['"]|['"]$/g, '').trim();
  const repoKey = repoRaw !== undefined && repoRaw.length > 0 ? repoRaw : null;

  const heading = firstHeading(body);
  const title = heading ?? slug;
  const hitl = hitlFrontmatter || (heading?.includes('(HITL)') ?? false);

  // A `## Parent` section marks an in-batch/out-of-batch issue; its absence
  // marks a standalone issue. `sectionBody` returns null only when the section
  // is missing (an empty section returns '').
  const parentSection = sectionBody(body, 'Parent');
  const standalone = parentSection === null;
  const parent = firstBacktick(parentSection);
  const source = sectionBody(body, 'Source') || null;

  return {
    id,
    slug,
    fileName: file.name,
    title,
    status,
    dependsOn,
    parent,
    source,
    hitl,
    repoKey,
    inBatch: false, // set once we know the active PRD (below)
    standalone,
    body,
  };
}

/**
 * Build the structured backlog from raw issue files + CONFIG content.
 *
 * Files whose names don't match `NN-slug.md` (e.g. CONFIG.md, HUMAN-SETUP.md)
 * are ignored. Issues are returned sorted ascending by id.
 */
export function buildBacklog(files: RawFile[], configContent: string | null): Backlog {
  const activePrd = parseActivePrd(configContent);

  const issues: BacklogIssue[] = [];
  for (const file of files) {
    const match = ISSUE_FILE.exec(file.name);
    if (!match) continue;
    const id = Number(match[1]);
    const slug = match[2];
    const issue = parseIssue(file, id, slug);
    issue.inBatch =
      activePrd !== null && issue.parent !== null && issue.parent === activePrd;
    issues.push(issue);
  }

  issues.sort((a, b) => a.id - b.id);
  return { activePrd, issues };
}
