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
 * The dependency ids of `issue` that are NOT yet `done` (a missing dependency
 * id counts as unmet — you can't be unblocked by an issue that isn't there).
 * Empty array ⇒ every dependency is satisfied.
 */
export function unmetDependencies(
  issue: BacklogIssue,
  issues: BacklogIssue[],
): number[] {
  const index = byId(issues);
  return issue.dependsOn.filter((depId) => index.get(depId)?.status !== 'done');
}

/**
 * True when a Run can be started on `issue`: it is `open` and all of its
 * dependencies are `done`. `wip` (already claimed) and `done` (finished) issues
 * are never runnable.
 */
export function eligibleForRun(
  issue: BacklogIssue,
  issues: BacklogIssue[],
): boolean {
  if (issue.status !== 'open') return false;
  return unmetDependencies(issue, issues).length === 0;
}
