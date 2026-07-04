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
 */

/** What run targeting needs to know about the active Project. */
export interface RunTargetProject {
  /** Resolved `repos:` map — key → absolute repo path. Legacy: empty. */
  repos: Record<string, string>;
  /** The repo Runs without a `repo:` key execute in. */
  defaultRepoPath: string;
}

export type IssueRepoResolution =
  | { ok: true; repoPath: string }
  | { ok: false; unknownKey: string };

/**
 * The repo an issue's Run executes in: its declared `repo:` key looked up in
 * the project's repos map, else the project's default repo. Unknown key ⇒
 * explicit error, never a guess.
 */
export function repoForIssue(
  project: RunTargetProject,
  repoKey: string | null,
): IssueRepoResolution {
  if (repoKey === null) return { ok: true, repoPath: project.defaultRepoPath };
  const path = project.repos[repoKey];
  if (path === undefined || path.length === 0) return { ok: false, unknownKey: repoKey };
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
