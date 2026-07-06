/**
 * Repo registration (PURE) — add ONE appeared repo to an existing project
 * (issue 95, ADR-0017), the confirm half of self-heal.
 *
 * The self-heal detector surfaces a `new-repo-candidate` in the Inbox; when the
 * human clicks confirm, this planner produces the exact artifacts to write: the
 * project's `CONFIG.md` with the repo added to its `repos:` map (and, for a
 * repo-less project, promoted to `default_repo` so Runs target it), and the
 * `registry.md` append block — one `status: active` entry, the same shape
 * `onboarding-model` emits for a new project. The edge (`main/register-repo.ts`)
 * writes them in ONE boring workbench commit, reusing the ADR-0015 path.
 *
 * Deliberately additive: only the new repo's lines change. The insert round-
 * trips through `workbench-model`'s own `parseProjectConfig` / `parseRegistry`,
 * because those are what every later session reads.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a value,
 * never a throw. Collisions (a taken key, a path already a member or already
 * registered to any project) refuse with every problem named — never a guess.
 */
import { contractTilde } from './onboarding-model';
import { expandTilde, parseProjectConfig, parseRegistry } from './workbench-model';

export interface RegisterRepoInput {
  /** The workbench project directory name the repo joins. */
  project: string;
  /** The chosen short `repos:` key (no spaces/colons). */
  key: string;
  /** The appeared repo's path (absolute, as the detector reported it). */
  repoPath: string;
  /** The project's current `CONFIG.md` content, or null when unreadable. */
  configContent: string | null;
  /** The whole workbench's current `registry.md`, or null when none exists. */
  registryContent: string | null;
  /** Edge-discovered home dir, for `~/` expansion/contraction. */
  homeDir: string | null;
}

export type RegisterRepoPlan =
  | {
      ok: true;
      /** The key actually written (the validated input key). */
      key: string;
      /** The repo path written, in the registry's `~/` house style. */
      writePath: string;
      /** The rewritten `CONFIG.md` (repos map + maybe default_repo). */
      configContent: string;
      /** The `registry.md` append block (one active entry, ends with a newline). */
      registryAppend: string;
    }
  | { ok: false; errors: string[] };

/** Drop trailing slashes (but never the root `/` itself) and trim. */
function normalize(path: string): string {
  const trimmed = (typeof path === 'string' ? path : '').trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** A key must survive as one frontmatter map line: `  <key>: <path>`. */
function usableKey(key: string): boolean {
  return key.length > 0 && !/[\s:]/.test(key);
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** An indented `key: value` map line (parseProjectConfig's repos-entry shape). */
const MAP_ENTRY = /^\s+[^\s:][^:]*\s*:\s*.*$/;

/**
 * Rewrite `CONFIG.md` to add `<key>: <writePath>` to the `repos:` map, and —
 * only when the project had NO repos and NO default before — promote it to
 * `default_repo` so a Run targets it. Additive: existing lines are preserved;
 * the body is untouched. The CONFIG must have a frontmatter fence (a repo-less
 * project's does — onboarding writes `workspace_root:` + `repos:`); callers
 * guard the null/fence-less case as an error before here.
 */
function addRepoToConfig(
  configContent: string,
  key: string,
  writePath: string,
  wasRepoLess: boolean,
  hadDefault: boolean,
): string | null {
  const match = FRONTMATTER.exec(configContent);
  if (!match) return null;
  const body = configContent.slice(match[0].length);
  const lines = match[1].split('\n');

  const reposIdx = lines.findIndex((l) => /^repos\s*:\s*$/.test(l));
  const entryLine = `  ${key}: ${writePath}`;

  if (reposIdx === -1) {
    // No `repos:` key at all (a hand-written / pre-0017 CONFIG): add the block
    // after `workspace_root:` when present, else at the top of the frontmatter.
    const wsIdx = lines.findIndex((l) => /^workspace_root\s*:/.test(l));
    const at = wsIdx === -1 ? 0 : wsIdx + 1;
    lines.splice(at, 0, 'repos:', entryLine);
  } else {
    // Append after the map's existing indented entries.
    let end = reposIdx + 1;
    while (end < lines.length && MAP_ENTRY.test(lines[end])) end++;
    lines.splice(end, 0, entryLine);
  }

  // Repo-less → the new repo is the default (there was nothing to default to).
  if (wasRepoLess && !hadDefault) {
    const reposAt = lines.findIndex((l) => /^repos\s*:\s*$/.test(l));
    let end = reposAt + 1;
    while (end < lines.length && MAP_ENTRY.test(lines[end])) end++;
    lines.splice(end, 0, `default_repo: ${key}`);
  }

  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/**
 * Plan the registration of one appeared repo into an existing project. Never
 * throws; refuses (with every problem named) on a bad key, a missing/fence-less
 * CONFIG, a duplicate key, or a path already a member or already registered to
 * any project. On success, returns the rewritten CONFIG and the registry append.
 */
export function planRepoRegistration(input: RegisterRepoInput): RegisterRepoPlan {
  const errors: string[] = [];
  const project = typeof input?.project === 'string' ? input.project.trim() : '';
  const key = typeof input?.key === 'string' ? input.key.trim() : '';
  const rawPath = typeof input?.repoPath === 'string' ? input.repoPath.trim() : '';
  const homeDir =
    typeof input?.homeDir === 'string' && input.homeDir.length > 0 ? normalize(input.homeDir) : null;

  if (project.length === 0 || project.includes('/') || project === '.' || project === '..') {
    errors.push(`Not a workbench project name: "${project}".`);
  }
  if (!usableKey(key)) {
    errors.push(
      `The repo key needs no spaces or colons` + (key.length > 0 ? ` — "${key}" won't parse.` : '.'),
    );
  }
  if (rawPath.length === 0) errors.push('No repo path to register.');

  const config = parseProjectConfig(input?.configContent ?? null);
  if (typeof input?.configContent !== 'string' || !FRONTMATTER.test(input.configContent)) {
    errors.push(`Project "${project}" has no CONFIG.md frontmatter to add a repo to.`);
  }

  const normalized = normalize(expandTilde(rawPath, homeDir));
  const writePath = contractTilde(normalized, homeDir);

  // Key already used by another repo in this project's map.
  if (usableKey(key) && config.repos[key] !== undefined) {
    errors.push(`The key "${key}" is already used by another repo in ${project}.`);
  }
  // Path already a member of THIS project.
  if (
    rawPath.length > 0 &&
    Object.values(config.repos).some((p) => normalize(expandTilde(p, homeDir)) === normalized)
  ) {
    errors.push(`${writePath} is already registered to ${project}.`);
  }
  // Path already registered to ANY project (inactive counts — mapping exists).
  const taken = parseRegistry(input?.registryContent ?? null).entries.find(
    (e) => normalize(expandTilde(e.repo, homeDir)) === normalized,
  );
  if (taken !== undefined) {
    errors.push(
      `${writePath} is already registered to project "${taken.project}"` +
        `${taken.active ? '' : ' (inactive entry)'} — one repo belongs to one project.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const wasRepoLess = Object.keys(config.repos).length === 0;
  const newConfig = addRepoToConfig(
    input.configContent as string,
    key,
    writePath,
    wasRepoLess,
    config.defaultRepo !== null,
  );
  if (newConfig === null) {
    return { ok: false, errors: [`Could not rewrite ${project}'s CONFIG.md frontmatter.`] };
  }

  const registryAppend = [
    `- repo: ${writePath}`,
    `  project: ${project}`,
    '  status: active',
    '',
  ].join('\n');

  return { ok: true, key, writePath, configContent: newConfig, registryAppend };
}
