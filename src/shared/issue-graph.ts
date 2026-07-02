/**
 * Issue graph — the pure derivation of the dependency relationships between
 * issues and of *why* a blocked issue is blocked. This is what turns the flat
 * backlog list (issue 02) into the bird's-eye dependency view on the Map
 * (issue 04).
 *
 * It builds on the Backlog Model's structured issues and reuses the run
 * eligibility rule (`unmetDependencies`) so the Map's "eligible vs. blocked"
 * story is exactly the afk-issue-runner's own pick logic — one source of truth,
 * not two.
 *
 * PURE: no I/O, no Electron. Unit-tested in isolation (see PRD "Testing
 * Decisions"); the Map just renders what these functions return.
 */
import type { BacklogIssue, IssueStatus } from './backlog-model';
import { unmetDependencies } from './run-eligibility';

/** Index issues by id for O(1) lookups. */
function byId(issues: BacklogIssue[]): Map<number, BacklogIssue> {
  const map = new Map<number, BacklogIssue>();
  for (const issue of issues) map.set(issue.id, issue);
  return map;
}

/**
 * A directed dependency edge: `from` (the blocker) must be `done` before `to`
 * (the dependent) can run. `unmet` is true while `from` is not yet `done`, so
 * the Map can draw still-holding edges differently from satisfied ones.
 */
export interface DependencyEdge {
  from: number;
  to: number;
  unmet: boolean;
}

/**
 * One unmet dependency of an issue, with enough context for the Map to name it
 * ("waiting on 03 — Run one issue …, still wip") rather than just say
 * "blocked".
 */
export interface UnmetDependency {
  id: number;
  /** The dependency's title, or null when no issue with that id exists. */
  title: string | null;
  /** Its status, or 'missing' when the id isn't present in the backlog. */
  status: IssueStatus | 'missing';
}

/**
 * The Map-facing state of an issue:
 *  - `done` / `wip` — already finished / already claimed.
 *  - `eligible` — open and every dependency is `done` (a Run can start).
 *  - `blocked` — open but at least one dependency is unmet; `unmet` names them.
 */
export type IssueMapState =
  | { kind: 'done' }
  | { kind: 'wip' }
  | { kind: 'eligible' }
  | { kind: 'blocked'; unmet: UnmetDependency[] };

/**
 * All dependency edges in the backlog. Edges to a dependency id that isn't in
 * the backlog are omitted (there's no node to draw them to — a missing
 * dependency still surfaces as a blocked reason via {@link unmetDetails}).
 * Edges are sorted by (to, from) for a stable render order.
 */
export function dependencyEdges(issues: BacklogIssue[]): DependencyEdge[] {
  const index = byId(issues);
  const edges: DependencyEdge[] = [];
  for (const issue of issues) {
    for (const depId of issue.dependsOn) {
      const dep = index.get(depId);
      if (!dep) continue;
      edges.push({ from: depId, to: issue.id, unmet: dep.status !== 'done' });
    }
  }
  edges.sort((a, b) => a.to - b.to || a.from - b.from);
  return edges;
}

/**
 * The issues that depend on `issue` (the ones it is currently blocking), sorted
 * ascending by id. Lets the Map show a dependency's downstream ("blocks 04,
 * 05") as well as its upstream.
 */
export function dependents(issue: BacklogIssue, issues: BacklogIssue[]): number[] {
  return issues
    .filter((other) => other.dependsOn.includes(issue.id))
    .map((other) => other.id)
    .sort((a, b) => a - b);
}

/**
 * Detailed unmet dependencies of `issue`: the same ids {@link unmetDependencies}
 * returns, each enriched with the dependency's title and status (or `missing`).
 * Empty when every dependency is satisfied.
 */
export function unmetDetails(
  issue: BacklogIssue,
  issues: BacklogIssue[],
): UnmetDependency[] {
  const index = byId(issues);
  return unmetDependencies(issue, issues).map((id) => {
    const dep = index.get(id);
    return {
      id,
      title: dep?.title ?? null,
      status: dep ? dep.status : 'missing',
    };
  });
}

/**
 * Derive the Map-facing state of `issue`. Mirrors the eligibility rule: a `done`
 * or `wip` issue reports that status directly; an `open` issue is `eligible`
 * when it has no unmet dependencies and `blocked` (with the offending
 * dependencies named) otherwise.
 */
export function deriveIssueState(
  issue: BacklogIssue,
  issues: BacklogIssue[],
): IssueMapState {
  if (issue.status === 'done') return { kind: 'done' };
  if (issue.status === 'wip') return { kind: 'wip' };
  const unmet = unmetDetails(issue, issues);
  return unmet.length === 0 ? { kind: 'eligible' } : { kind: 'blocked', unmet };
}
