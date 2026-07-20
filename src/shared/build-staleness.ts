/**
 * Build staleness (issue 173) — the pure decision behind the self-hosting
 * hazard banner: MC's own running build is a commit baked in at launch
 * (`ownBuildCommit`, read once from its own repo's HEAD at startup — see
 * `main/build-version.ts`), so it can silently drift behind the repo it is
 * draining. The 2026-07-19 incident: a `mc-driver` build 9+ commits behind
 * main used a stale `run_timeout` and an old (non-working) auto-merge lane,
 * producing stranded Runs with no signal the running app didn't match the
 * code it was draining.
 *
 * This module only turns (running commit, target tip, commits-behind-count)
 * into a stale/ok decision and the banner text — the git reads themselves are
 * I/O, done by the main-process adapter. v1 scope: detect + warn, never block
 * (per the issue) — there is no "return not-stale to unblock" escape hatch to
 * unit-test here because staleness never gates anything.
 */

/** The exact command the banner tells the human to run (SESSION-HANDOFF.md). */
export const REBUILD_COMMAND = 'nvm use 22 && npm run build';

export interface BuildStalenessInput {
  /** MC's own running build's commit, captured once at app startup. */
  runningCommit: string;
  /** The drained repo's current tip commit (its default branch). */
  targetTipCommit: string;
  /** `git rev-list --count runningCommit..targetTipCommit`. */
  commitsBehind: number;
}

export interface BuildStalenessDecision {
  stale: boolean;
  /** 0 when not stale. */
  commitsBehind: number;
  /** The persistent banner text, or null when the build is current. */
  message: string | null;
}

/**
 * Decide whether the running build is stale relative to the drained repo's
 * tip. Identical commits (or a non-positive count) always read as current —
 * `commitsBehind` is trusted only when the shas actually differ, so a
 * mismatched/zeroed count from a caller bug can't fabricate a stale banner
 * for a build that is, in fact, the tip.
 */
export function evaluateBuildStaleness(input: BuildStalenessInput): BuildStalenessDecision {
  const { runningCommit, targetTipCommit, commitsBehind } = input;
  if (runningCommit === targetTipCommit || commitsBehind <= 0) {
    return { stale: false, commitsBehind: 0, message: null };
  }
  return {
    stale: true,
    commitsBehind,
    message:
      `Mission Control is running an old build (${commitsBehind} ` +
      `commit${commitsBehind === 1 ? '' : 's'} behind) — rebuild the driver to get current ` +
      `drain/merge/timeout behavior: ${REBUILD_COMMAND}`,
  };
}
