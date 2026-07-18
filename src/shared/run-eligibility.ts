/**
 * Run eligibility — the pure decision for whether an issue can have a Run
 * started on it from the Map. Mirrors the afk-issue-runner's own pick logic:
 * an issue is runnable when it is `open` and every issue it `depends_on` is
 * already `done`. Anything `wip`/`done`, or with an unmet dependency, is not
 * runnable.
 *
 * This module is PURE (no I/O, no Electron): it operates on the structured
 * `BacklogIssue`s the Backlog Model already produced, so it is unit-testable in
 * isolation (see PRD "Testing Decisions").
 */
import type { BacklogIssue } from './backlog-model';

/** Index issues by id for O(1) dependency lookups. */
function byId(issues: BacklogIssue[]): Map<number, BacklogIssue> {
  const map = new Map<number, BacklogIssue>();
  for (const issue of issues) map.set(issue.id, issue);
  return map;
}

/**
 * The dependency ids of `issue` that are NOT yet `done` **and integrated**
 * (issue 147, ADR-0021): a missing dependency id counts as unmet, and so does
 * a dependency whose frontmatter reads `done` but whose `afk/` branch is still
 * finished-unmerged (`finishedUnmergedIds`, the same on-disk fact afk-scan
 * already produces for `hasInFlightRun`). Solo-chaining used to paper over this
 * by forcing such a dependency to commit straight to the integration branch;
 * now that the auto-merge lane lands branches on its own, a dependent must wait
 * for the real merge rather than starting from a main still missing its own
 * prerequisite. Empty array ⇒ every dependency is satisfied.
 */
export function unmetDependencies(
  issue: BacklogIssue,
  issues: BacklogIssue[],
  finishedUnmergedIds: readonly number[] = [],
): number[] {
  const index = byId(issues);
  const unmerged = new Set(finishedUnmergedIds);
  return issue.dependsOn.filter((depId) => {
    if (index.get(depId)?.status !== 'done') return true;
    return unmerged.has(depId);
  });
}

/**
 * True when a Run can be started on `issue`: it is `open` and all of its
 * dependencies are `done` **and integrated** (issue 147). `wip` (already
 * claimed) and `done` (finished) issues are never runnable.
 */
export function eligibleForRun(
  issue: BacklogIssue,
  issues: BacklogIssue[],
  finishedUnmergedIds: readonly number[] = [],
): boolean {
  if (issue.status !== 'open') return false;
  return unmetDependencies(issue, issues, finishedUnmergedIds).length === 0;
}

/**
 * The ids of issues that already have an isolated Run in flight or finished-but-
 * unmerged on an `afk/NN-slug` branch, as read from the on-disk worktree scan
 * (`worktree-scan`). These are the two states the main-checkout backlog can't
 * see: a Run in a worktree, and a finished Run whose `done` flip is committed on
 * its `afk/` branch while `main` still reads `open` (issues 15/16).
 *
 * Both are omitted so `run-eligibility` can gate "can this issue be Run?" on
 * on-disk truth rather than main-checkout status alone (issue 21). Fields are
 * optional so callers that don't scan (tests, uncontrolled Map) pass nothing.
 */
export interface InFlightRuns {
  worktreeRunningIds?: readonly number[];
  finishedUnmergedIds?: readonly number[];
  /**
   * Issue ids whose isolated Run has ended without merging but whose worktree +
   * `afk/` branch are still ON DISK (issue 22): `stranded` (blocked/stopped/
   * exited) or `commit-failed`. A fresh Run on these would collide with the
   * existing worktree dir / branch, so they block a new Run exactly as a live
   * one does — the user discards or resolves them first.
   */
  strandedIds?: readonly number[];
  commitFailedIds?: readonly number[];
}

/**
 * True when `issueId` already has an isolated Run whose worktree/branch is still
 * on disk — live (`worktreeRunningIds`), finished-unmerged, stranded, or
 * commit-failed. Starting a second Run on any of these would re-attach a worktree
 * to the existing branch (clobbering its work) or push commits onto a branch a
 * pending Merge is about to integrate — so this is the guard the guidance
 * banner, the Run button, and `startRun` all consult.
 */
export function hasInFlightRun(
  issueId: number,
  inFlight: InFlightRuns = {},
): boolean {
  return (
    (inFlight.worktreeRunningIds ?? []).includes(issueId) ||
    (inFlight.finishedUnmergedIds ?? []).includes(issueId) ||
    (inFlight.strandedIds ?? []).includes(issueId) ||
    (inFlight.commitFailedIds ?? []).includes(issueId)
  );
}

/**
 * True when a Run can actually be STARTED on `issue` right now: it is eligible
 * by dependencies AND has no isolated Run already in flight / finished-unmerged
 * on disk. This is the single "can I Run this?" rule the guidance banner, the
 * detail-panel Run button, and `startRun` share, so they agree by construction
 * and none of them offers (or admits) a Run on an issue whose real state lives
 * on an `afk/` branch the main checkout can't see (issue 21).
 */
export function runnableNow(
  issue: BacklogIssue,
  issues: BacklogIssue[],
  inFlight: InFlightRuns = {},
): boolean {
  return (
    eligibleForRun(issue, issues, inFlight.finishedUnmergedIds ?? []) &&
    !hasInFlightRun(issue.id, inFlight)
  );
}
