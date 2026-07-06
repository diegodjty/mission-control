/**
 * Self-heal detector (PURE) — a git repo that has APPEARED under a project's
 * workspace root and is not yet registered, so Mission Control can offer to
 * register it via the Inbox (issue 95, ADR-0017).
 *
 * The unlock of repo-less projects (issue 93): planning starts with a name +
 * workspace root and zero repos, and the drain creates the codebases. When one
 * of those `git init`s lands a repo under the workspace root, MC must NOTICE —
 * never silently, never auto-registered (registration routes where future Runs
 * execute — too load-bearing to guess). This module is the noticing half: a
 * pure function over `{ workspace-root contents, the project's current repos:
 * map, the registry }` that returns the **candidate** repos — git repos present
 * under the workspace root but absent from the `repos:` map and the registry.
 *
 * Deliberately weaker than issue 62's stray-Receipt auto-adopt: a new repo is
 * new *state*, so this only proposes; the human confirms with one click (the
 * Inbox item, issue 78's model) and the registration edit happens then. A repo
 * living OUTSIDE the workspace root is legal but never a candidate — the edge
 * only ever hands us the workspace root's own top-level entries, so it can't
 * appear here (registerable through the normal add-repo path instead).
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a value,
 * never a throw. The directory listing / `.git` probe (and the registry/CONFIG
 * reads) are the adapter's job (`src/main/attention-reader.ts`).
 */
import { repoKeyFor } from './onboarding-model';
import { expandTilde, parseRegistry } from './workbench-model';

/** One top-level entry of the workspace root, plus whether it is a git repo. */
export interface WorkspaceEntry {
  /** The entry's directory name — a single path segment (no separators). */
  name: string;
  /** True when the entry directory contains a `.git` (a worktree's is a file). */
  isGit: boolean;
}

export interface SelfHealInput {
  /**
   * The project's workspace root (ADR-0017), already tilde-expanded and
   * normalized, or null — a legacy project or a pre-0017 CONFIG with no
   * `workspace_root` has nothing to watch, so nothing to detect.
   */
  workspaceRoot: string | null;
  /** The workspace root's top-level dirs and whether each holds a `.git`. */
  entries: readonly WorkspaceEntry[];
  /**
   * The project's current `repos:` map (values as written — may be `~/`-style).
   * A repo already in it is registered to THIS project and never a candidate.
   */
  repos: Record<string, string>;
  /**
   * Raw `registry.md` content (the whole workbench's), or null when none. A
   * repo already mapped to ANY project is registered and never re-surfaces.
   */
  registryContent: string | null;
  /** Edge-discovered home dir, to expand `~/` in registry/CONFIG paths. */
  homeDir: string | null;
}

/** A git repo present under the workspace root but not yet registered. */
export interface RepoCandidate {
  /** Absolute path of the candidate repo (`<workspaceRoot>/<name>`). */
  path: string;
  /** The repo's directory name — its stable discriminator across re-derives. */
  name: string;
  /** A suggested short `repos:` key (basename-derived, collision-bumped). */
  suggestedKey: string;
}

/** Drop a trailing `/` (but never the root `/` itself) and trim whitespace. */
function normalize(path: string): string {
  const trimmed = (typeof path === 'string' ? path : '').trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** True for a plain single-segment directory name (no separators, no dots). */
function isPlainName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

/**
 * Detect the git repos that have appeared under the workspace root and are not
 * yet registered — the Inbox's `new-repo-candidate` fodder. Deterministic:
 * candidates come back sorted by directory name, with suggested keys that never
 * collide with the project's existing `repos:` keys (nor each other). Never
 * throws; a null/empty workspace root, non-array entries, or junk paths all
 * degrade to no candidates.
 */
export function detectAppearedRepos(input: SelfHealInput): RepoCandidate[] {
  const workspaceRoot = normalize(input?.workspaceRoot ?? '');
  if (workspaceRoot === '') return [];

  const homeDir = typeof input?.homeDir === 'string' ? input.homeDir : null;

  // Every absolute path that is already spoken for: this project's repos map
  // (expanded) plus every registry entry's repo (any project, active or not —
  // the mapping exists even when it must not resolve yet).
  const registered = new Set<string>();
  const repos = input?.repos && typeof input.repos === 'object' ? input.repos : {};
  for (const raw of Object.values(repos)) {
    if (typeof raw === 'string' && raw.length > 0) {
      registered.add(normalize(expandTilde(raw, homeDir)));
    }
  }
  for (const entry of parseRegistry(input?.registryContent ?? null).entries) {
    registered.add(normalize(expandTilde(entry.repo, homeDir)));
  }

  // Keys already in use — a suggestion must not shadow an existing repo key.
  const usedKeys = new Set(Object.keys(repos));

  const entries = Array.isArray(input?.entries) ? input.entries : [];
  const candidates: RepoCandidate[] = [];
  for (const entry of [...entries].sort((a, b) => (a?.name ?? '').localeCompare(b?.name ?? ''))) {
    if (!entry || entry.isGit !== true || !isPlainName(entry.name)) continue;
    const path = `${workspaceRoot}/${entry.name}`;
    if (registered.has(path)) continue; // already a member repo or registered

    // A basename-derived key, bumped to dodge any key already taken (by the
    // repos map or an earlier candidate this same round).
    let key = repoKeyFor(entry.name);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}-${n}`)) n++;
      key = `${key}-${n}`;
    }
    usedKeys.add(key);

    candidates.push({ path, name: entry.name, suggestedKey: key });
  }
  return candidates;
}
