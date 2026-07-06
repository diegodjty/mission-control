/**
 * Onboarding model (PURE) — the Launcher's New project flow (issue 82,
 * ADR-0016; repo-less projects, issue 93 / ADR-0017), on top of the ADR-0015
 * workbench shapes.
 *
 * Given a project name, a **workspace root** (where the code lives / will
 * live; default `~/Developer/<name>`), and ZERO or more code-repo drafts (each
 * a short key + path; the first is the default repo), plus the current
 * workbench facts the edge gathered (registry content, existing project dirs,
 * which paths exist / are git repos, whether the workspace root is non-empty),
 * `planOnboarding` either:
 *
 *  - **refuses**, naming EVERY problem at once — unusable/colliding project
 *    name, a repo path already registered to another project (says which),
 *    duplicate keys/paths, an unparsable key; or
 *  - **plans**: the workbench directory name, the resolved workspace root, the
 *    full `CONFIG.md` content (frontmatter `workspace_root` + `repos:` map +
 *    `default_repo`), and the `registry.md` append block (one `status: active`
 *    entry per repo path) — all of which round-trip through `workbench-model`'s
 *    own parsers, because those are what every later session reads.
 *
 * **Zero repos is valid** (ADR-0017): a repo-less project starts with just a
 * name + workspace root, so planning can begin before any code exists; the
 * drain creates the codebases. Non-git / not-yet-existing repo paths, and an
 * existing non-empty workspace root, WARN but never refuse. Warnings ride both
 * outcomes.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a
 * value, never a throw. The directory creation, file writes, registry append,
 * and workbench commit live in `src/main/onboarding.ts`.
 */
import { expandTilde, parseRegistry } from './workbench-model';

/** Lowercased, non-alphanumerics collapsed to `-`; '' when nothing usable. */
function slug(text: string): string {
  return (typeof text === 'string' ? text : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The workbench directory name for a project display name. Empty when the
 * name has nothing usable — the caller refuses, never invents.
 */
export function projectDirName(name: string): string {
  return slug(name);
}

/**
 * A default short repo key from a path's basename (`~/Developer/billing-api`
 * → `billing-api`). Degrades to `repo`, never '' — this is a suggestion the
 * user can edit, not a validation.
 */
export function repoKeyFor(path: string): string {
  const parts = (typeof path === 'string' ? path : '').split('/').filter((p) => p.length > 0);
  const base = slug(parts[parts.length - 1] ?? '');
  return base.length > 0 ? base : 'repo';
}

/**
 * The default workspace root for a project name: `~/Developer/<dirName>` in the
 * registry's `~/` house style (ADR-0017 — the common case, so the user doesn't
 * have to think about where code lives). Empty when the name has nothing usable
 * (the caller already refuses on the name; this just has nothing to build from).
 */
export function defaultWorkspaceRoot(name: string): string {
  const dir = projectDirName(name);
  return dir.length > 0 ? `~/Developer/${dir}` : '';
}

/**
 * The effective workspace root to WRITE into CONFIG: the entered value
 * (normalized + written `~/`-style) when the user gave one, else the default
 * `~/Developer/<dirName>`. Pure and shared so the edge (which must stat the
 * path for the non-empty warning) and the plan resolve the SAME root.
 */
export function workspaceRootFor(
  name: string,
  entered: string | null | undefined,
  homeDir: string | null,
): string {
  const raw = typeof entered === 'string' ? entered.trim() : '';
  if (raw.length > 0) return contractTilde(trimSlash(expandTilde(raw, homeDir)), homeDir);
  return defaultWorkspaceRoot(name);
}

/**
 * The inverse of `expandTilde`, for WRITING workbench artifacts: a path under
 * the home directory is written `~/...` — the registry's house style — so
 * entries stay readable and machine-portable. Foreign paths pass through.
 */
export function contractTilde(path: string, homeDir: string | null): string {
  if (homeDir === null || homeDir.length === 0) return path;
  if (path === homeDir) return '~';
  if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`;
  return path;
}

/** Drop trailing slashes (but never the root `/` itself). */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** One repo row as the edge hands it in: the draft plus filesystem facts. */
export interface RepoFact {
  /** The short key the CONFIG `repos:` map will use (user-editable). */
  key: string;
  /** The path as entered (may be `~/`-prefixed). */
  path: string;
  /** Edge fact: the path exists on disk. */
  exists: boolean;
  /** Edge fact: the path contains a `.git` (worktree files count). */
  isGit: boolean;
}

export interface OnboardingInput {
  /** The project display name; slugged into the workbench directory name. */
  name: string;
  /**
   * Zero or more repo drafts; the FIRST is the project's default repo. Empty is
   * valid — a repo-less project (ADR-0017): name + workspace root, no repos, so
   * planning can start before any code exists.
   */
  repos: readonly RepoFact[];
  /**
   * The workspace root the user entered, or empty/absent for the default
   * `~/Developer/<name>` (ADR-0017). Where the project's code lives / will live.
   */
  workspaceRoot?: string;
  /** Edge fact: the resolved workspace root exists on disk and is non-empty. */
  workspaceRootNonEmpty?: boolean;
  /** Current `registry.md` content, or null when none exists yet. */
  registryContent: string | null;
  /** Directory names already present under the workbench root. */
  existingProjectDirs: readonly string[];
  /** Edge-discovered home dir, for tilde matching/writing. */
  homeDir: string | null;
}

export type OnboardingPlan =
  | {
      ok: true;
      /** The workbench directory name (`~/Workbench/<dirName>`). */
      dirName: string;
      /** The resolved workspace root written into CONFIG (`~/`-style). */
      workspaceRoot: string;
      /** Full `CONFIG.md` content for the new project. */
      configContent: string;
      /**
       * The block to append to `registry.md` (ends with a newline) — one entry
       * per repo actually given. EMPTY for a repo-less project: no repos, no
       * registry lines (registration is deferred to when a repo appears).
       */
      registryAppend: string;
      warnings: string[];
    }
  | { ok: false; errors: string[]; warnings: string[] };

/** A key must survive as one frontmatter map line: `  <key>: <path>`. */
function usableKey(key: string): boolean {
  return key.length > 0 && !/[\s:]/.test(key);
}

/**
 * Validate a New-project request against the current workbench and, when it
 * holds, produce the exact artifacts to write. Never throws; refusals carry
 * every problem found, not just the first.
 */
export function planOnboarding(input: OnboardingInput): OnboardingPlan {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = typeof input?.name === 'string' ? input.name : '';
  const repos = Array.isArray(input?.repos) ? input.repos : [];
  const homeDir =
    typeof input?.homeDir === 'string' && input.homeDir.length > 0
      ? trimSlash(input.homeDir)
      : null;
  const existingDirs = Array.isArray(input?.existingProjectDirs) ? input.existingProjectDirs : [];

  // --- Project name → directory name, collision-checked ---------------------
  const dirName = projectDirName(name);
  if (dirName.length === 0) {
    errors.push('The project name needs at least one letter or digit.');
  } else {
    if (existingDirs.some((d) => d.toLowerCase() === dirName)) {
      errors.push(`A workbench project directory "${dirName}" already exists — pick another name.`);
    }
    // The registry may name a project whose directory does not exist yet;
    // creating that dir would silently adopt its entries. Same refusal.
    const { entries } = parseRegistry(input?.registryContent ?? null);
    if (
      !existingDirs.some((d) => d.toLowerCase() === dirName) &&
      entries.some((e) => e.project === dirName)
    ) {
      errors.push(
        `The registry already maps entries to a project "${dirName}" — pick another name.`,
      );
    }
  }

  // --- Workspace root --------------------------------------------------------
  // Zero repos is valid (repo-less project, ADR-0017): the workspace root is
  // what makes planning-before-code possible. An existing non-empty root warns
  // but is allowed — don't silently plan on top of unrelated files.
  const workspaceRoot = workspaceRootFor(name, input?.workspaceRoot, homeDir);
  if (input?.workspaceRootNonEmpty === true && workspaceRoot.length > 0) {
    warnings.push(
      `The workspace root ${workspaceRoot} already exists and is not empty — allowed, but planning will sit alongside whatever is already there.`,
    );
  }

  // --- Repo drafts (optional — a repo-less project gives none) ---------------
  const { entries } = parseRegistry(input?.registryContent ?? null);
  const seenKeys = new Set<string>();
  const seenPaths = new Set<string>();
  const cleaned: { key: string; writePath: string }[] = [];

  repos.forEach((repo, index) => {
    const label = `repo ${index + 1}`;
    const rawPath = typeof repo?.path === 'string' ? repo.path.trim() : '';
    const key = typeof repo?.key === 'string' ? repo.key.trim() : '';

    if (rawPath.length === 0) {
      errors.push(`${label} has no path.`);
      return;
    }
    if (!usableKey(key)) {
      errors.push(
        `${label} ("${rawPath}") needs a short key with no spaces or colons` +
          (key.length > 0 ? ` — "${key}" won't parse.` : '.'),
      );
    }

    // Normalize for comparison: expand `~`, drop trailing slashes.
    const normalized = trimSlash(expandTilde(rawPath, homeDir));
    const writePath = contractTilde(normalized, homeDir);

    if (usableKey(key)) {
      if (seenKeys.has(key)) errors.push(`The key "${key}" is used by more than one repo row.`);
      seenKeys.add(key);
    }
    if (seenPaths.has(normalized)) {
      errors.push(`The path ${writePath} appears more than once.`);
    }
    seenPaths.add(normalized);

    // Already registered to ANOTHER project? Refuse and say which. Inactive
    // entries count: the mapping exists even when it must not resolve yet.
    const taken = entries.find(
      (e) => trimSlash(expandTilde(e.repo, homeDir)) === normalized && e.project !== dirName,
    );
    if (taken !== undefined) {
      errors.push(
        `${writePath} is already registered to project "${taken.project}"` +
          `${taken.active ? '' : ' (inactive entry)'} — one repo belongs to one project.`,
      );
    }

    // Non-git / missing paths: warn, allow (docs-first projects — ADR-0016).
    if (repo?.exists !== true) {
      warnings.push(`${writePath} does not exist yet — allowed (some projects start docs-first).`);
    } else if (repo?.isGit !== true) {
      warnings.push(`${writePath} is not a git repository — allowed (docs-first is fine).`);
    }

    cleaned.push({ key, writePath });
  });

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    dirName,
    workspaceRoot,
    configContent: buildProjectConfig(dirName, workspaceRoot, cleaned),
    registryAppend: buildRegistryAppend(dirName, cleaned),
    warnings,
  };
}

/**
 * The new project's `CONFIG.md`: the frontmatter `workspace_root` (ADR-0017),
 * the `repos:` map (first key = `default_repo`), plus the two stable body
 * sections the afk-issue-runner skill reads — parsed back by
 * `parseProjectConfig`, so the shape is exactly the one issues 70/0017 fixed.
 *
 * A **repo-less** project (no repos) emits an empty `repos:` and NO
 * `default_repo`: there is no repo to default to, and a no-repo issue Runs at
 * the workspace root instead. Existing single/multi-repo projects are
 * unchanged (`default_repo` still names the first key).
 */
function buildProjectConfig(
  dirName: string,
  workspaceRoot: string,
  repos: readonly { key: string; writePath: string }[],
): string {
  return [
    '---',
    `workspace_root: ${workspaceRoot}`,
    'repos:',
    ...repos.map((r) => `  ${r.key}: ${r.writePath}`),
    // No default_repo for a repo-less project — there is nothing to default to.
    ...(repos.length > 0 ? [`default_repo: ${repos[0].key}`] : []),
    '---',
    '',
    `# ${dirName} — project CONFIG`,
    '',
    'Workbench project config per ADR-0015/0017. `workspace_root` is where the code lives',
    '(a no-repo issue Runs there); `repos:` maps a short key → code-repo path, and may be',
    "empty for a repo-less project the drain will scaffold. An issue's optional `repo:`",
    'frontmatter names one of these keys (omitted = `default_repo`, or the workspace root',
    'when there are no repos). One issue targets exactly one repo.',
    '',
    '## Test commands',
    '',
    'Not established yet — set the test/type-check commands here once the project has',
    'a test setup (the afk-issue-runner runs this section after every change).',
    '',
  ].join('\n');
}

/**
 * The `registry.md` append block: one `status: active` entry per repo path,
 * paths written in the registry's `~/` house style. Ends with a newline; the
 * edge joins it onto the existing content (or a fresh header).
 */
function buildRegistryAppend(
  dirName: string,
  repos: readonly { key: string; writePath: string }[],
): string {
  return repos
    .map((r) => [`- repo: ${r.writePath}`, `  project: ${dirName}`, '  status: active', ''].join('\n'))
    .join('');
}
