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
