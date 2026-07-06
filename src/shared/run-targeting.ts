/**
 * Run targeting (PURE) — which code repo a Run executes in (issue 72,
 * ADR-0015).
 *
 * A workbench Project references one or more repos (`repos:` map in its
 * CONFIG, resolved and tilde-expanded into the ProjectView by the identity
 * layer); each issue may declare a `repo:` key naming one of them, else it
 * targets the project's default repo. One issue targets exactly ONE repo.
 *
 * An issue naming an UNKNOWN key resolves to an explicit error value — never
 * a guessed path (the ADR's rule): the caller blocks that Run (a section-6
 * blocker for the Worker; a skipped, surfaced issue for a drain) without
 * stalling its siblings. A legacy Project has one repo and no keys, so every
 * issue resolves to it unchanged.
 *
 * A repo may also be **declared before it exists** (planned-first, ADR-0017):
 * a `repo:` key present in the map whose directory is not yet on disk resolves
 * to a distinct `planned` outcome — not a path (nothing to run in yet) and not
 * `unknownKey` (it's a plan, not a typo). The Map grays a planned repo and its
 * issues; a drain HOLDS a planned-targeted issue rather than erroring it. Which
 * declared keys are still planned is a filesystem fact the adapter supplies via
 * `plannedRepoKeys`; the pure layer never touches disk. When the directory
 * appears (and is registered — issue 95), the key drops out of that list and
 * resolves exactly like any real repo, no code change needed.
 */

/** What run targeting needs to know about the active Project. */
export interface RunTargetProject {
  /** Resolved `repos:` map — key → absolute repo path. Legacy: empty. */
  repos: Record<string, string>;
  /** The repo Runs without a `repo:` key execute in. */
  defaultRepoPath: string;
  /**
   * Declared `repos:` keys whose directory does NOT yet exist on disk (ADR-0017
   * planned repos) — supplied by the adapter's fs check. A `repo:` naming one
   * resolves to `planned`. Absent/empty ⇒ every declared repo exists (today's
   * behavior, byte-identical).
   */
  plannedRepoKeys?: string[];
}

export type IssueRepoResolution =
  | { ok: true; repoPath: string }
  | { ok: false; reason: 'unknownKey'; unknownKey: string }
  | { ok: false; reason: 'planned'; repoKey: string; repoPath: string };

/**
 * The repo an issue's Run executes in: its declared `repo:` key looked up in
 * the project's repos map, else the project's default repo. Unknown key ⇒
 * explicit error; a declared-but-absent key ⇒ `planned` (held, not errored);
 * never a guessed path.
 */
export function repoForIssue(
  project: RunTargetProject,
  repoKey: string | null,
): IssueRepoResolution {
  if (repoKey === null) return { ok: true, repoPath: project.defaultRepoPath };
  const path = project.repos[repoKey];
  if (path === undefined || path.length === 0)
    return { ok: false, reason: 'unknownKey', unknownKey: repoKey };
  if (project.plannedRepoKeys?.includes(repoKey))
    return { ok: false, reason: 'planned', repoKey, repoPath: path };
  return { ok: true, repoPath: path };
}

/**
 * The one-line note surfaced (once) when an issue's declared `repo:` key is
 * unknown — the drain skips the issue (its dependents stay blocked naturally)
 * and everything else keeps scheduling.
 */
export function unknownRepoKeyNote(
  issueId: number,
  unknownKey: string,
  knownKeys: string[],
): string {
  const known =
    knownKeys.length > 0 ? `known keys: ${knownKeys.join(', ')}` : 'no repos declared';
  return (
    `Issue ${String(issueId).padStart(2, '0')} names unknown repo key "${unknownKey}" ` +
    `(${known}) — its Run is blocked until the issue or the project CONFIG is fixed; ` +
    `other issues continue.`
  );
}

/**
 * The one-line note surfaced (once) when an issue's `repo:` key names a
 * declared-but-absent repo (ADR-0017 planned-first): the drain HOLDS the issue
 * — it is not started and not errored — until the repo is created (typically by
 * the issue it `depends_on`), at which point it resolves and runs. Distinct in
 * wording from `unknownRepoKeyNote` so a plan never reads as a typo.
 */
export function plannedRepoHoldNote(issueId: number, repoKey: string): string {
  return (
    `Issue ${String(issueId).padStart(2, '0')} targets planned repo "${repoKey}" ` +
    `(declared, not yet created) — held until that repo exists; other issues continue.`
  );
}
