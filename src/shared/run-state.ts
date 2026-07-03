/**
 * Run status — the pure mapping from observable facts (is the PTY session still
 * alive? did the user stop it? what does the issue's status say on disk?) to
 * the Run's outcome shown on the Map.
 *
 * Mission Control learns "done vs. blocked" from the Artifacts on disk, not by
 * parsing the agent's stream (ADR-0001): a Run is FINISHED when its issue file
 * flips to `done`, and BLOCKED when the session ends while the issue is still
 * unfinished (the agent's blocked reason is what it printed live in the Pane).
 *
 * Pure (no I/O, no Electron) so it is unit-testable in isolation.
 */
import type { IssueStatus } from './backlog-model';

export type RunStatus = 'running' | 'finished' | 'blocked' | 'stopped';

export interface RunFacts {
  /** Is the underlying PTY session still alive (not exited)? */
  sessionAlive: boolean;
  /** Did the user explicitly stop this Run? */
  stoppedByUser: boolean;
  /** The issue's current status on disk, or null if not yet observed. */
  issueStatus: IssueStatus | null;
}

/**
 * Derive the Run's status. Precedence:
 *   1. Issue reached `done` on disk ⇒ finished (even if the session lingers).
 *   2. User stopped it ⇒ stopped.
 *   3. Session ended without the issue reaching done ⇒ blocked.
 *   4. Otherwise ⇒ still running.
 */
export function deriveRunStatus(facts: RunFacts): RunStatus {
  if (facts.issueStatus === 'done') return 'finished';
  if (facts.stoppedByUser) return 'stopped';
  if (!facts.sessionAlive) return 'blocked';
  return 'running';
}

/** Whether a Run is over (no longer worth polling for status changes). */
export function isTerminal(status: RunStatus): boolean {
  return status !== 'running';
}

/**
 * The issue ids whose Run is currently LIVE (`running`) — the set that drives the
 * Map row "running" indicator and the detail-panel "Run in progress" label
 * (issue 33). It MUST be status-filtered: a tracked Run that has reached a
 * terminal status (finished/stopped/blocked) but whose Pane/tile is still on
 * screen must be EXCLUDED, or its issue keeps reading as "running" /
 * "Run in progress" until the Pane is manually dismissed. Pure (takes the runs
 * plus status/issue-id resolvers) so the filtering is unit-testable without a
 * React render.
 */
export function runningIssueIds<R>(
  runs: readonly R[],
  statusOf: (run: R) => RunStatus,
  issueIdOf: (run: R) => number,
): number[] {
  return runs.filter((r) => statusOf(r) === 'running').map(issueIdOf);
}

/**
 * The two disk sources a Run's issue status could be read from, plus whether the
 * Run is isolated (working in its own worktree on an `afk/` branch).
 */
export interface IssueStatusSources {
  /** True when this Run works in a worktree on an `afk/` branch (not `main`). */
  isolated: boolean;
  /** The issue's status as seen in the main-checkout backlog, or null. */
  mainStatus: IssueStatus | null;
  /**
   * The issue's status as observed in the Run's own worktree/branch, or null.
   * Only meaningful for an isolated Run.
   */
  worktreeStatus: IssueStatus | null;
}

/**
 * Pick the authoritative issue-status source for a Run (issue 13). An isolated
 * Run flips its issue to `done` inside its worktree on the `afk/NN-slug`
 * branch, which the main-checkout backlog watcher never sees — so its status
 * must be observed from the worktree/branch. A solo Run works on `main`, so its
 * status is the main backlog's, exactly as before.
 *
 * Pure (a plain selection), so `deriveRunStatus` stays fed a single
 * `issueStatus` and the "which source?" decision is unit-testable in isolation.
 */
export function observedIssueStatus(sources: IssueStatusSources): IssueStatus | null {
  return sources.isolated ? sources.worktreeStatus : sources.mainStatus;
}

/** The facts that decide whether a Run's worktree should be auto-committed. */
export interface WorktreeCommitFacts {
  /** True when this Run works in a worktree on an `afk/` branch (not `main`). */
  isolated: boolean;
  /**
   * The issue's status as seen in the Run's OWN worktree working tree (where the
   * agent's `done` flip lands before anything is committed), or null if unknown.
   */
  worktreeStatus: IssueStatus | null;
}

/**
 * Whether Mission Control should auto-commit a Run's worktree onto its
 * `afk/NN-slug` branch (issue 15). Commit ONLY on the finished (done) transition
 * of an ISOLATED Run: the agent spawned in single-issue mode never commits, so
 * the finished worktree work (created files + the `done` flip) would otherwise
 * stay uncommitted and the `afk/` branch empty — leaving Merge nothing to
 * integrate. A solo Run (works directly on `main`) is never auto-committed, and
 * a still-`wip`/blocked/stopped isolated Run is left uncommitted (nothing to
 * merge yet). A solo Run (works directly on `main`) is not committed HERE — its
 * symmetric auto-commit onto `main` is `shouldCommitMain` (issue 25). Pure so
 * the "when to commit" decision is unit-testable; the git side effect and
 * idempotency guard live in the Git/Worktree Adapter.
 */
export function shouldCommitWorktree(facts: WorktreeCommitFacts): boolean {
  return facts.isolated && facts.worktreeStatus === 'done';
}

/** The facts that decide whether a SOLO Run's work on `main` should be committed. */
export interface MainCommitFacts {
  /** True when this Run works in a worktree on an `afk/` branch (not `main`). */
  isolated: boolean;
  /**
   * The issue's status as seen in the MAIN-checkout backlog (where a solo Run's
   * agent flips it to `done` and leaves the change uncommitted), or null.
   */
  mainStatus: IssueStatus | null;
}

/**
 * Whether Mission Control should auto-commit a SOLO Run's work on `main` (issue
 * 25) — the symmetric counterpart of `shouldCommitWorktree` for isolated Runs.
 * The afk-issue-runner solo contract has the spawned agent flip its issue to
 * `done` and leave the created files + the flip UNCOMMITTED on `main`; nothing
 * else commits them, so `main` stays dirty and the next parallel Merge fails its
 * clean-tree preflight ("commit or stash them first"). So MC commits — but ONLY
 * on the finished (done) transition of a SOLO Run: an isolated Run commits on
 * its own `afk/` branch (never here), and a still-`wip`/blocked/stopped solo Run
 * is left for the user. Pure so the "when to commit" decision is unit-testable;
 * the git side effect and idempotency guard live in the Git/Worktree Adapter.
 */
export function shouldCommitMain(facts: MainCommitFacts): boolean {
  return !facts.isolated && facts.mainStatus === 'done';
}

/**
 * Where a solo Run's auto-commit stands in its Receipt-aware lifecycle (issue
 * 59, ADR-0013). The skill's Receipt discipline is *write it last*: the Worker
 * flips the issue `done`, emits its block, and only then writes
 * `issues/completions/NN-slug.md`. Committing on the `done`-flip observation
 * alone (the old issue-25 behavior) therefore races the Receipt: the commit
 * lands without it, the Receipt stays untracked on `main`, and every later
 * parallel Merge fails its clean-tree preflight.
 *
 *   - `unstarted`              — nothing decided for this Run yet.
 *   - `waiting`                — the `done` flip was seen but no Receipt; the
 *                                grace window is running.
 *   - `committed-sans-receipt` — the grace window elapsed with no Receipt, so
 *                                the work was committed without it (no stall —
 *                                the finished-without-receipt note is the
 *                                signal). A LATE Receipt still gets committed
 *                                by a follow-up observation.
 *   - `committed`              — the Run's work (and its Receipt, when one
 *                                arrived) is committed; terminal.
 */
export type SoloCommitPhase =
  | 'unstarted'
  | 'waiting'
  | 'committed-sans-receipt'
  | 'committed';

/** The facts one observation of a solo Run feeds the commit decision. */
export interface SoloCommitFacts {
  /** The Run's derived status (`deriveRunStatus`) at this observation. */
  runStatus: RunStatus;
  /** True when this Run works in a worktree on an `afk/` branch (not `main`). */
  isolated: boolean;
  /** Where this Run's auto-commit lifecycle currently stands. */
  phase: SoloCommitPhase;
  /** A Receipt for this Run's issue exists (ingested from `issues/completions/`). */
  receiptPresent: boolean;
  /** The Receipt grace window has elapsed since the finish was first observed. */
  graceElapsed: boolean;
}

/**
 * What one observation of a solo Run should do next:
 *   - `commit`         — call the adapter's `commitFinishedMain` now; move to
 *                        `nextPhase` (`committed`, or `committed-sans-receipt`
 *                        when committing at grace expiry without a Receipt).
 *   - `schedule-grace` — start the grace-window timer and move to `waiting`.
 *   - `none`           — nothing to do at this observation.
 */
export type SoloCommitStep =
  | { act: 'commit'; nextPhase: 'committed' | 'committed-sans-receipt' }
  | { act: 'schedule-grace' }
  | { act: 'none' };

/**
 * Decide a solo Run's next auto-commit step (issue 59). "Finished" for the solo
 * commit means *done flip AND Receipt present* — so the ONE commit captures the
 * deliverable, the issue flip, and the Receipt, and `main` ends clean. The
 * grace window keeps that honest rather than eternal: if the Receipt never
 * arrives, the work commits anyway once the window elapses (the
 * finished-without-receipt audit's note remains the only signal), and a late
 * Receipt is picked up by a follow-up `commit` on the next observation — which
 * is safe because the adapter commit is idempotent on a clean tree.
 * PURE — the timer, the Receipt lookup, and the git side effect live with the
 * caller.
 */
export function decideSoloCommitStep(facts: SoloCommitFacts): SoloCommitStep {
  if (facts.isolated || facts.runStatus !== 'finished') return { act: 'none' };
  switch (facts.phase) {
    case 'committed':
      return { act: 'none' };
    case 'committed-sans-receipt':
      // The work is committed; only a late Receipt still needs a follow-up
      // commit (the straggler that would otherwise leave `main` dirty).
      return facts.receiptPresent
        ? { act: 'commit', nextPhase: 'committed' }
        : { act: 'none' };
    case 'unstarted':
    case 'waiting':
      if (facts.receiptPresent) return { act: 'commit', nextPhase: 'committed' };
      if (facts.graceElapsed) {
        return { act: 'commit', nextPhase: 'committed-sans-receipt' };
      }
      return facts.phase === 'unstarted' ? { act: 'schedule-grace' } : { act: 'none' };
  }
}
