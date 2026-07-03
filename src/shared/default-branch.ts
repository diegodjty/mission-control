/**
 * Default-branch resolution (pure) — issue 27.
 *
 * The whole Merge path used to hardcode `main` as the integration branch:
 * `isMergedIntoMain` ran `git merge-base --is-ancestor afk/<slug> main`, which on
 * a `master`/`trunk` repo ERRORS (no `main` ref) and so returns false for every
 * branch — a finished branch then looks unmerged forever, the Merge button never
 * clears, and rows stay `finished (unmerged)` permanently. The fix is to detect
 * the repo's real default/current branch and thread it through.
 *
 * Detection itself is I/O (`git symbolic-ref --short HEAD`, in the adapter). This
 * module is the PURE part: turning that raw command output into a branch name,
 * with a safe fallback when git gives us nothing usable (a detached HEAD, or the
 * command failing). Pure (no git, no fs) so the fallback decision is unit-tested
 * in isolation, per the PRD's "Testing Decisions".
 */

/** The safe fallback when the repo's branch can't be read (detached HEAD, error). */
export const DEFAULT_BRANCH_FALLBACK = 'main';

/**
 * Resolve the repo's default/integration branch name from the raw output of
 * `git symbolic-ref --short HEAD` (or null when that command failed / there was
 * no output). Trims the trailing newline git prints; falls back to `main` when
 * the output is empty or unreadable, so callers always get a usable branch name
 * rather than an empty string that would silently break a `merge-base` check.
 */
export function resolveDefaultBranch(rawSymbolicRef: string | null | undefined): string {
  const trimmed = (rawSymbolicRef ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_BRANCH_FALLBACK;
}
