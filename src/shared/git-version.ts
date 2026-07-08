/**
 * Git version parsing (pure) — issue 104, ADR-0018.
 *
 * Merge previews are simulated with `git merge-tree --write-tree`, which needs
 * git ≥ 2.38. The probe itself is I/O (running `git --version`, in the preview
 * adapter); THIS module is the PURE part — turning that raw string into a
 * comparable version and deciding whether it clears the floor — so the parser is
 * unit-testable against the strings real gits print, including Apple's
 * `git version 2.39.5 (Apple Git-154)`, without spawning a process (see the PRD
 * "Testing Decisions"). Below the floor the feature degrades to no badges plus
 * one passive note; there is no fallback merge machinery (ADR-0018).
 */

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

/** The floor `git merge-tree --write-tree` requires (ADR-0018). */
export const MERGE_TREE_MIN: GitVersion = { major: 2, minor: 38, patch: 0 };

/**
 * The single passive note shown when merge previews are unavailable because git
 * is below the floor (ADR-0018 degradation: no badges, exactly one note).
 */
export const GIT_FLOOR_NOTE =
  'Merge previews need git 2.38 or newer (git merge-tree --write-tree) — badges are off until git is upgraded.';

/**
 * Parse the raw output of `git --version` into a comparable version, or null
 * when no `MAJOR.MINOR[.PATCH]` can be found. Tolerates the shapes git prints:
 * plain `git version 2.42.0`, Apple's `git version 2.39.5 (Apple Git-154)`,
 * Windows' `git version 2.41.0.windows.1`, and a bare `2.38`. Takes the FIRST
 * dotted number so a trailing build tag (`Apple Git-154`) is never mistaken for
 * the version.
 */
export function parseGitVersion(raw: string | null | undefined): GitVersion | null {
  if (!raw) return null;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : 0,
  };
}

/** Whether `version` is ≥ `min`, compared major, then minor, then patch. */
export function atLeast(version: GitVersion, min: GitVersion): boolean {
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

/**
 * Whether this git supports the merge-preview simulation (`git merge-tree
 * --write-tree`, git ≥ 2.38). A null/unparseable version reads as UNSUPPORTED —
 * degrade to no badges rather than erroring on every scan tick.
 */
export function supportsMergeTree(version: GitVersion | null): boolean {
  return version !== null && atLeast(version, MERGE_TREE_MIN);
}
