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
import {
  DEFAULT_ESCALATION_CEILING,
  DEFAULT_WORKER_MODEL,
  parseEffort,
  parseTier,
  parseWorkerTieringConfig,
  type WorkerEffort,
  type WorkerModelTier,
} from './worker-model';
import {
  DEFAULT_RUN_TIMEOUT_MINUTES,
  parseIssueRunTimeoutMinutes,
  parseRunTimeoutMinutes,
} from './run-timeout';
import { parseHotFiles } from './file-overlap';

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
  /**
   * The issue's declared `model:` frontmatter tier (issue 154) — the tier this
   * issue's DRAIN Worker starts on, overriding the project CONFIG's
   * `worker_model` default. Null when omitted (= the CONFIG default) or when the
   * value isn't a known tier. Hand-settable and set by the issue-producing
   * skills at authoring time; it is the STARTING tier, not a lock (escalation
   * still walks up from it). Interactive Runs ignore it — tiering is drain-only.
   */
  model: WorkerModelTier | null;
  /**
   * The issue's declared `effort:` frontmatter level (issue 155) — the
   * reasoning effort this issue's DRAIN Worker spawns on, overriding both the
   * CONFIG `worker_effort` and the tier-derived default. Null when omitted (=
   * derive from tier, or the CONFIG override) or when the value isn't a known
   * level. A per-issue `effort:` PINS the level across escalation; a null one
   * lets effort re-derive as the tier climbs. Drain-only — interactive Runs
   * ignore it, exactly like `model`.
   */
  effort: WorkerEffort | null;
  /**
   * The issue's declared `run_timeout` frontmatter override, in MINUTES (issue
   * 170) — a big-refactor issue that knows it needs more runway than the
   * project CONFIG default declares its own budget, exactly like `model:`/
   * `effort:`. Null when omitted or malformed (= the CONFIG default, scaled by
   * the resolved effort tier at the drain spawn site). Drain-only, like
   * `model`/`effort` above.
   */
  runTimeoutMinutes: number | null;
  /**
   * The issue's declared `touches:` frontmatter (issue 171) — a hand-authored
   * list of file globs this issue is expected to touch, the precise footprint
   * source the Run Coordinator prefers over its own body-scan guess when
   * deciding whether two eligible issues must serialize. Empty when omitted
   * (the coordinator then falls back to scanning the body for CONFIG
   * `hot_files` mentions).
   */
  touches: string[];
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
  /**
   * The project's default DRAIN-worker tier from CONFIG `worker_model` (issue
   * 154), resolved to a known tier (`sonnet` when unset/unknown). Surfaced here
   * — beside `activePrd` — so the renderer's drain spawn site has it without a
   * second CONFIG read; interactive Runs never consult it (tiering is drain-only).
   */
  workerModel: WorkerModelTier;
  /**
   * The tier the failure-escalation ladder may climb to, inclusive, from CONFIG
   * `escalation_ceiling` (issue 154), resolved to a known tier (`opus` when
   * unset/unknown).
   */
  escalationCeiling: WorkerModelTier;
  /**
   * The project-wide drain-worker effort override from CONFIG `worker_effort`
   * (issue 155), or null when unset/unknown. Null means "derive effort from each
   * worker's resolved tier" — the derivation happens at the drain spawn site
   * (`resolveWorkerEffort`), not here. Surfaced beside `workerModel` so the
   * renderer resolves effort without a second CONFIG read.
   */
  workerEffort: WorkerEffort | null;
  /**
   * The headless drain kill timeout, in MINUTES, from CONFIG `run_timeout`
   * (issue 141), resolved to a known value (30 when unset/malformed). A
   * headless Run watched past this many minutes is killed by the Headless
   * Session Manager and lands in the existing no-Receipt handling. Surfaced
   * here so the drain spawn site has it without a second CONFIG read.
   */
  runTimeoutMinutes: number;
  /**
   * The project CONFIG's `hot_files` list (issue 171) — file paths any two
   * eligible issues both predicted to touch must serialize against each
   * other. Surfaced here so the drive loop's `planDrain` call has it without a
   * second CONFIG read. Empty when unset (no project-declared god files).
   */
  hotFiles: string[];
  /** Issues sorted ascending by id. */
  issues: BacklogIssue[];
}

/**
 * The empty backlog — what a project with no readable `issues/` derives from,
 * at the documented tiering defaults (sonnet / opus). One source of truth so a
 * new `Backlog` field never has to be back-filled at every empty-backlog site.
 */
export const EMPTY_BACKLOG: Backlog = {
  activePrd: null,
  workerModel: DEFAULT_WORKER_MODEL,
  escalationCeiling: DEFAULT_ESCALATION_CEILING,
  workerEffort: null,
  runTimeoutMinutes: DEFAULT_RUN_TIMEOUT_MINUTES,
  hotFiles: [],
  issues: [],
};

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

/** Parse a `[a, b, c]`-style flow list into trimmed, unquoted strings. */
function parseStringList(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
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
  // The optional `model:` tier (issue 154). Frontmatter only; an unknown or
  // empty value degrades to null (= the project's `worker_model` default).
  const model = parseTier(frontmatterValue(frontmatter, 'model'));
  // The optional `effort:` level (issue 155). Frontmatter only; an unknown or
  // empty value degrades to null (= the CONFIG `worker_effort` override, else
  // the tier-derived default). When set it pins the level across escalation.
  const effort = parseEffort(frontmatterValue(frontmatter, 'effort'));
  // The optional per-issue `run_timeout` override (issue 170), in minutes.
  // Reuses run-timeout.ts's own frontmatter parse (it re-derives the block
  // from `file.content` itself) so the malformed/degrade rules live in one
  // place rather than being duplicated here.
  const runTimeoutMinutes = parseIssueRunTimeoutMinutes(file.content);
  // The optional `touches:` footprint (issue 171), same flow-list shape as
  // `depends_on:`. Absent/empty ⇒ [] (the coordinator falls back to a
  // hot-files body scan for this issue).
  const touches = parseStringList(frontmatterValue(frontmatter, 'touches'));

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
    model,
    effort,
    runTimeoutMinutes,
    touches,
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
  // Drain-worker tiering keys (issues 154/155), read from the CONFIG frontmatter
  // and resolved to their defaults, so the renderer gets them with the backlog.
  const { workerModel, escalationCeiling, workerEffort } =
    parseWorkerTieringConfig(configContent);
  // The headless kill timeout (issue 141), from CONFIG `run_timeout`.
  const runTimeoutMinutes = parseRunTimeoutMinutes(configContent);
  // The overlap-scheduling god-file list (issue 171), from CONFIG `hot_files`.
  const hotFiles = parseHotFiles(configContent);

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
  return {
    activePrd,
    workerModel,
    escalationCeiling,
    workerEffort,
    runTimeoutMinutes,
    hotFiles,
    issues,
  };
}
