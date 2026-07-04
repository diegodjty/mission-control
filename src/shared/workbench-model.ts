/**
 * Workbench model (PURE) — registry, project CONFIG, `repo:` field, and the
 * resolution decision (issue 70, ADR-0015).
 *
 * The Workbench (`~/Workbench/`) is one private git repo holding every
 * project's pipeline artifacts (issues, Receipts, memory) outside the code
 * repos. This module turns its three text shapes into structure and makes the
 * discovery decision the ADR fixes:
 *
 * - `registry.md` — repo path → project entries, each `active` or `inactive`;
 * - a project `CONFIG.md` — `repos:` map (key → path) + `default_repo` in the
 *   frontmatter, plus a `## Test commands` section in the body;
 * - an issue's optional `repo:` frontmatter key (one issue targets exactly
 *   one repo; omitted = the project's default);
 * - `resolveProject` — explicit prompt paths → registry lookup by cwd →
 *   legacy in-repo `issues/` fallback → unresolved.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a value,
 * never a throw. Malformed input degrades to explicit error values (`notes`,
 * `unresolved`, `{ ok: false }`) — never a guessed path.
 *
 * **Tilde expansion is the edge's job.** Parsers return paths verbatim (a
 * registry entry may read `~/code/x`). The resolver never discovers the home
 * directory itself; it only rewrites a leading `~/` when the calling adapter
 * supplies `homeDir`. Without `homeDir`, tilde-written entries simply cannot
 * match an absolute cwd.
 */

// ---------------------------------------------------------------------------
// Shared frontmatter helpers (same tolerant shapes the backlog model and
// receipt parser accept: `---` fence, line-based `key: value` reads).
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** Split the frontmatter block from the body; null when there is no fence. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

/** Strip surrounding single/double quotes from a scalar value. */
function unquote(raw: string): string {
  return raw.replace(/^(['"])(.*)\1$/, '$2').trim();
}

/**
 * Read one top-level `key: value` line out of a raw frontmatter block. Line-
 * based on purpose: one unreadable line must not take down the readable ones.
 */
function frontmatterValue(frontmatter: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(frontmatter);
  if (!match) return null;
  const value = unquote(match[1].trim());
  return value.length > 0 ? value : null;
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
  const text = collected.join('\n').trim();
  return text.length > 0 ? text : null;
}

/** Drop a trailing `/` (but never the root `/` itself). */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Join path segments with single slashes (pure string work, no `path`). */
function join(...segments: string[]): string {
  return segments.map(trimSlash).join('/');
}

// ---------------------------------------------------------------------------
// registry.md — repo path → project entries
// ---------------------------------------------------------------------------

/** One registry mapping: a code-repo path (verbatim) → a Workbench project. */
export interface RegistryEntry {
  /** Code-repo path exactly as written (may start with `~`). */
  repo: string;
  /** Directory name under the workbench root holding the project's artifacts. */
  project: string;
  /** False for `status: inactive` — the mapping must not resolve yet. */
  active: boolean;
}

export interface RegistryParse {
  entries: RegistryEntry[];
  /** Human-readable notes about malformed items that were skipped/degraded. */
  notes: string[];
}

/**
 * Remove fenced code blocks and HTML comments so the registry's documented-by-
 * example schema (and commented-out entries) are never parsed as real entries.
 */
function stripNonEntries(content: string): string {
  return content.replace(/```[\s\S]*?(```|$)/g, '').replace(/<!--[\s\S]*?(-->|$)/g, '');
}

const ENTRY_START = /^-\s+repo\s*:\s*(.*)$/;
const ENTRY_FIELD = /^\s+(project|status)\s*:\s*(.*)$/;

/**
 * Parse `registry.md` content into repo → project entries. Only list items of
 * the form `- repo: ...` start an entry (prose bullets are ignored silently);
 * fenced code blocks and HTML comments are stripped first. A missing or
 * unrecognized `status` degrades to inactive — the conservative reading, since
 * inactive means "must not resolve" (legacy fallback applies). Never throws.
 */
export function parseRegistry(content: unknown): RegistryParse {
  if (typeof content !== 'string' || content.length === 0) {
    return { entries: [], notes: [] };
  }

  const entries: RegistryEntry[] = [];
  const notes: string[] = [];
  const lines = stripNonEntries(content).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const start = ENTRY_START.exec(lines[i]);
    if (!start) continue;

    const repo = unquote(start[1].trim());
    let project: string | null = null;
    let status: string | null = null;

    // Collect the entry's indented continuation lines.
    while (i + 1 < lines.length) {
      const field = ENTRY_FIELD.exec(lines[i + 1]);
      if (!field) break;
      i++;
      const value = unquote(field[2].trim());
      if (field[1] === 'project') project = value.length > 0 ? value : null;
      else status = value.length > 0 ? value : null;
    }

    if (repo.length === 0) {
      notes.push(`registry entry with an empty repo path skipped (project: ${project ?? '?'})`);
      continue;
    }
    if (project === null) {
      notes.push(`registry entry for ${repo} has no project — skipped`);
      continue;
    }

    let active = false;
    if (status === 'active') active = true;
    else if (status !== 'inactive') {
      notes.push(
        `registry entry for ${repo} has ${status === null ? 'no status' : `unrecognized status "${status}"`} — treated as inactive`,
      );
    }

    entries.push({ repo, project, active });
  }

  return { entries, notes };
}

// ---------------------------------------------------------------------------
// Project CONFIG.md — repos: map, default_repo, test commands
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  /** `repos:` map from the frontmatter: short key → repo path (verbatim). */
  repos: Record<string, string>;
  /** The `default_repo` key, or null when not declared. */
  defaultRepo: string | null;
  /** The `## Test commands` section body, verbatim, or null when absent. */
  testCommands: string | null;
  /** Human-readable notes about malformed items that were skipped. */
  notes: string[];
}

/**
 * Parse a project `CONFIG.md`: the frontmatter's `repos:` map (a `repos:`
 * line followed by more-indented `key: path` lines) and `default_repo`
 * scalar, plus the body's `## Test commands` section verbatim. Never throws.
 */
export function parseProjectConfig(content: unknown): ProjectConfig {
  const empty: ProjectConfig = { repos: {}, defaultRepo: null, testCommands: null, notes: [] };
  if (typeof content !== 'string' || content.length === 0) return empty;

  const split = splitFrontmatter(content);
  if (split === null) {
    return { ...empty, testCommands: sectionBody(content, 'Test commands') };
  }

  const repos: Record<string, string> = {};
  const notes: string[] = [];
  const lines = split.frontmatter.split('\n');
  const reposLine = lines.findIndex((l) => /^repos\s*:\s*$/.test(l));

  if (reposLine !== -1) {
    for (let i = reposLine + 1; i < lines.length; i++) {
      const field = /^\s+([^\s:][^:]*)\s*:\s*(.*)$/.exec(lines[i]);
      if (!field) break; // first de-indented (or non-field) line ends the map
      const key = field[1].trim();
      const path = unquote(field[2].trim());
      if (path.length === 0) {
        notes.push(`repos entry "${key}" has an empty path — skipped`);
        continue;
      }
      repos[key] = path;
    }
  }

  return {
    repos,
    defaultRepo: frontmatterValue(split.frontmatter, 'default_repo'),
    testCommands: sectionBody(split.body, 'Test commands'),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Issue frontmatter — the optional `repo:` key
// ---------------------------------------------------------------------------

/**
 * The issue's declared `repo:` key (a key into its project CONFIG's `repos:`
 * map), or null when omitted (= the project's default repo). Only reads the
 * frontmatter — a `repo:` line in the body is prose, not a declaration.
 */
export function parseIssueRepo(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const split = splitFrontmatter(content);
  if (split === null) return null;
  return frontmatterValue(split.frontmatter, 'repo');
}

// ---------------------------------------------------------------------------
// Target repo for an issue — one issue targets exactly one repo
// ---------------------------------------------------------------------------

export type RepoResolution =
  | { ok: true; key: string; path: string }
  | {
      ok: false;
      error: 'unknown-repo-key' | 'unknown-default-repo' | 'ambiguous-repo' | 'no-repos';
      key: string | null;
    };

/**
 * The code repo an issue targets: its declared `repo:` key when present, else
 * the project's `default_repo`, else the only repo of a single-repo project.
 * An unknown key resolves to an explicit error value — never a guessed path.
 */
export function repoPathForIssue(config: ProjectConfig, issueRepoKey: string | null): RepoResolution {
  const keys = Object.keys(config.repos);
  if (keys.length === 0) return { ok: false, error: 'no-repos', key: issueRepoKey };

  if (issueRepoKey !== null) {
    const path = config.repos[issueRepoKey];
    if (path === undefined) return { ok: false, error: 'unknown-repo-key', key: issueRepoKey };
    return { ok: true, key: issueRepoKey, path };
  }

  if (config.defaultRepo !== null) {
    const path = config.repos[config.defaultRepo];
    if (path === undefined) return { ok: false, error: 'unknown-default-repo', key: config.defaultRepo };
    return { ok: true, key: config.defaultRepo, path };
  }

  if (keys.length === 1) return { ok: true, key: keys[0], path: config.repos[keys[0]] };
  return { ok: false, error: 'ambiguous-repo', key: null };
}

// ---------------------------------------------------------------------------
// The resolution decision — explicit paths → registry → legacy → unresolved
// ---------------------------------------------------------------------------

/** Paths named explicitly in the spawning prompt, when any were. */
export interface ExplicitPaths {
  issuesRoot?: string | null;
  completionsRoot?: string | null;
  memoryRoot?: string | null;
}

export interface ResolutionInput {
  /** Explicit prompt paths; used only when `issuesRoot` is present. */
  explicit?: ExplicitPaths | null;
  /** Raw `registry.md` content, or null/absent when there is no workbench. */
  registryContent?: string | null;
  /** The workbench root path; defaults to `<homeDir>/Workbench` when absent. */
  workbenchRoot?: string | null;
  /**
   * The edge-discovered home directory, used only to rewrite a leading `~/`
   * in registry paths for matching. The pure layer never discovers it.
   */
  homeDir?: string | null;
  /** The session's cwd (inside some code repo). */
  cwd: string;
  /** Whether an in-repo `issues/` exists at the cwd (legacy layout). */
  legacyIssuesPresent: boolean;
}

export type ProjectResolution =
  | {
      kind: 'workbench';
      source: 'explicit' | 'registry';
      /** The workbench project directory name, when known. */
      project: string | null;
      projectRoot: string;
      issuesRoot: string;
      completionsRoot: string;
      memoryRoot: string;
    }
  | { kind: 'legacy'; issuesRoot: string; completionsRoot: string }
  | { kind: 'unresolved'; reason: string };

/** Rewrite a leading `~/` (or bare `~`) using the edge-supplied home dir. */
function withHome(path: string, homeDir: string | null): string {
  if (homeDir === null || !path.startsWith('~')) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path; // `~user/...` shapes are not ours to guess at
}

/** True when `cwd` is the repo path itself or a subdirectory of it. */
function within(cwd: string, repo: string): boolean {
  return cwd === repo || cwd.startsWith(`${repo}/`);
}

/**
 * Decide where a session's pipeline artifacts live. Resolution order per
 * ADR-0015: explicit paths in the spawning prompt → `registry.md` lookup by
 * cwd (inactive entries behave as unregistered) → legacy fallback to an
 * in-repo `issues/` → unresolved, with the reason spelled out. Never throws;
 * never invents a path it was not given the parts of.
 */
export function resolveProject(input: ResolutionInput): ProjectResolution {
  const cwd = trimSlash(typeof input.cwd === 'string' ? input.cwd : '');
  const homeDir = typeof input.homeDir === 'string' ? trimSlash(input.homeDir) : null;

  // 1. Explicit prompt paths win outright.
  const explicitIssues = input.explicit?.issuesRoot;
  if (typeof explicitIssues === 'string' && explicitIssues.length > 0) {
    const issuesRoot = trimSlash(explicitIssues);
    const projectRoot = issuesRoot.includes('/')
      ? issuesRoot.slice(0, issuesRoot.lastIndexOf('/'))
      : issuesRoot;
    const projectName = projectRoot.includes('/')
      ? projectRoot.slice(projectRoot.lastIndexOf('/') + 1)
      : projectRoot;
    return {
      kind: 'workbench',
      source: 'explicit',
      project: projectName.length > 0 ? projectName : null,
      projectRoot,
      issuesRoot,
      completionsRoot: input.explicit?.completionsRoot
        ? trimSlash(input.explicit.completionsRoot)
        : join(projectRoot, 'completions'),
      memoryRoot: input.explicit?.memoryRoot
        ? trimSlash(input.explicit.memoryRoot)
        : join(projectRoot, 'memory'),
    };
  }

  // 2. Registry lookup by cwd. Longest matching repo path wins; inactive
  // entries are skipped — the repo behaves as unregistered.
  const { entries } = parseRegistry(input.registryContent ?? null);
  let match: { entry: RegistryEntry; repoPath: string } | null = null;
  for (const entry of entries) {
    if (!entry.active) continue;
    const repoPath = trimSlash(withHome(entry.repo, homeDir));
    if (!within(cwd, repoPath)) continue;
    if (match === null || repoPath.length > match.repoPath.length) {
      match = { entry, repoPath };
    }
  }

  if (match !== null) {
    const workbenchRoot =
      typeof input.workbenchRoot === 'string' && input.workbenchRoot.length > 0
        ? trimSlash(input.workbenchRoot)
        : homeDir !== null
          ? join(homeDir, 'Workbench')
          : null;
    if (workbenchRoot === null) {
      return {
        kind: 'unresolved',
        reason: `registry maps ${cwd} to project "${match.entry.project}" but no workbench root was provided (and no homeDir to derive one)`,
      };
    }
    const projectRoot = join(workbenchRoot, match.entry.project);
    return {
      kind: 'workbench',
      source: 'registry',
      project: match.entry.project,
      projectRoot,
      issuesRoot: join(projectRoot, 'issues'),
      completionsRoot: join(projectRoot, 'completions'),
      memoryRoot: join(projectRoot, 'memory'),
    };
  }

  // 3. Legacy fallback: an in-repo `issues/` keeps today's behavior.
  if (input.legacyIssuesPresent) {
    return {
      kind: 'legacy',
      issuesRoot: join(cwd, 'issues'),
      completionsRoot: join(cwd, 'issues', 'completions'),
    };
  }

  // 4. Nothing applies — say so; never guess.
  return {
    kind: 'unresolved',
    reason: `no explicit paths, no active registry entry matches ${cwd || '(empty cwd)'}, and no in-repo issues/ exists`,
  };
}
