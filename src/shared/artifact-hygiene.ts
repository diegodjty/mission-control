/**
 * Install-artifact hygiene (pure) — issue 98.
 *
 * An afk worktree symlinks its `node_modules` at the main repo's real install so
 * it need not reinstall per worktree. Sensible on its own — but when that symlink
 * is COMMITTED on an `afk/NN-slug` branch (git object mode `120000`, target the
 * main repo's absolute `node_modules` path) and the branch is later merged back
 * into the main repo, the symlink comes to point at its OWN location: an infinite
 * `too many levels of symbolic links` loop that clobbers the real install and
 * kills every `tsc`/`vitest`/build invocation. Observed for real during the
 * 94/95/96 drain merge; it would corrupt EVERY afk-branch merge, not just that one.
 *
 * This module is the single source of truth for "which paths are local install
 * artifacts that must never enter tracked scope". It is consumed by two guards:
 *   - the worktree commit path (`commitFinishedWorktree`) strips any such path
 *     from the index before committing, so a worktree can never INTRODUCE one; and
 *   - the merge preflight (`mergeRuns`) refuses any branch that would add one to
 *     the default branch, naming the real cause — mirroring the issue-23/59
 *     dirty-tree / stray-Receipt preflights.
 *
 * PURE (no git, no fs) so the "is this an artifact path?" rule and the user-facing
 * refusal message are unit-tested in isolation.
 */

/**
 * Path segments that name a local install artifact — content that is produced by
 * an install/build step and must never be tracked. `node_modules` is the one that
 * corrupted `main` (issue 98); the others are the sibling build outputs the repo
 * already git-ignores, guarded here too so the rule and `.gitignore` agree.
 */
const ARTIFACT_SEGMENTS = ['node_modules', 'dist', 'out'];

/**
 * Is `path` inside (or exactly) a local install artifact? Matched by PATH SEGMENT
 * so `node_modules`, `node_modules/x`, and `packages/a/node_modules/x` all count,
 * while an innocent lookalike like `my_node_modules` or `distribution/x` does not.
 * Backslashes are normalised so a Windows-style path is handled the same way.
 */
export function isIgnoredArtifactPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  return segments.some((segment) => ARTIFACT_SEGMENTS.includes(segment));
}

/** The subset of `paths` that are local install artifacts, order-preserving & deduped. */
export function ignoredArtifactPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (isIgnoredArtifactPath(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

/** A branch that would introduce ignored-artifact paths, for the refusal message. */
export interface ArtifactOffender {
  /** The `NN-slug` stem, matching the `afk/NN-slug` branch. */
  slug: string;
  /** The ignored-artifact paths this branch would add to the default branch. */
  paths: string[];
}

/** How many offending paths the message names per branch before summarising. */
const ARTIFACT_PATHS_SHOWN = 4;

function summarisePaths(paths: string[]): string {
  const shown = paths.slice(0, ARTIFACT_PATHS_SHOWN).join(', ');
  const rest = paths.length - ARTIFACT_PATHS_SHOWN;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * The truthful merge-preflight refusal message (issue 98), mirroring the issue-59
 * dirty-tree phrasing: a preflight failure names WHAT went wrong and WHY, so the
 * user (or a tool) can act on it. Names each offending branch and the artifact
 * path(s) it would add, then the real cause — a committed `node_modules` is a
 * self-referential symlink that corrupts the install on merge. PURE.
 */
export function artifactMergeRefusalMessage(
  defaultBranch: string,
  offenders: ArtifactOffender[],
): string {
  const branchList = offenders
    .map((o) => `afk/${o.slug} (${summarisePaths(o.paths)})`)
    .join('; ');
  const noun = offenders.length === 1 ? 'branch' : 'branches';
  return (
    `Merge preflight failed: ${noun} ${branchList} would add ignored install ` +
    `artifact(s) to ${defaultBranch}. A committed node_modules is a self-referential ` +
    `symlink that corrupts the install on merge (issue 98) — remove the artifact ` +
    `path(s) from the branch, then Merge again.`
  );
}
