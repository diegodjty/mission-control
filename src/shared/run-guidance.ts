/**
 * Run guidance — the pure "what can I Run right now" summary for the current
 * backlog. This exists so the app's own verification affordances (Map guidance
 * banner, empty-state, "try it" help) point at the LIVE eligible set instead of
 * issue numbers captured at some earlier moment (issue 11). A status change
 * elsewhere in the batch can never leave the user chasing a stale number,
 * because this is recomputed from the current `BacklogIssue[]` every render.
 *
 * It reuses the SAME eligibility source of truth the Map already uses:
 * `eligibleForRun` (run-eligibility) and `deriveIssueState` (issue-graph). One
 * rule, not two.
 *
 * PURE: no I/O, no Electron. Unit-tested in isolation (see PRD "Testing
 * Decisions"); the Map just renders what these functions return.
 */
import type { BacklogIssue } from './backlog-model';
import { runnableNow, type InFlightRuns } from './run-eligibility';
import { deriveIssueState, type UnmetDependency } from './issue-graph';

/** One issue a Run can be started on right now (open, all dependencies done). */
export interface RunnableIssue {
  id: number;
  title: string;
  fileName: string;
}

/** One open-but-blocked issue, with the unmet dependencies holding it back. */
export interface BlockedIssue {
  id: number;
  title: string;
  unmet: UnmetDependency[];
}

/**
 * Live guidance for "what can I Run right now". Exactly one kind:
 *  - `eligible` — one or more issues can be Run now (listed, ascending id).
 *  - `blocked`  — no eligible issues, but open issues remain; each is named with
 *                 the unmet dependencies keeping it from running, so the user
 *                 learns *why* nothing is runnable rather than seeing a dead
 *                 Run affordance.
 *  - `settled`  — no open issues at all: everything is `done` and/or `wip`.
 *  - `empty`    — the backlog has no issues.
 */
export type RunGuidance =
  | { kind: 'eligible'; runnable: RunnableIssue[] }
  | { kind: 'blocked'; blocked: BlockedIssue[] }
  | { kind: 'settled'; doneCount: number; wipCount: number }
  | { kind: 'empty' };

/** Ascending-by-id compare, for stable output. */
function byIdAsc(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

/**
 * Summarize the current backlog into live Run guidance. Derives runnability from
 * `runnableNow` and blocked reasons from `deriveIssueState`, so this agrees with
 * the Map's per-row badges by construction.
 *
 * `inFlight` carries the on-disk worktree scan (issue 16): an issue with a live
 * or finished-unmerged isolated Run on its `afk/` branch is NOT listed as
 * runnable even though the main checkout still reads it `open` — so the banner
 * and the per-row Run buttons never disagree (issue 21). Optional so callers
 * without a scan (tests, uncontrolled Map) get the plain dependency-only view.
 */
export function summarizeRunGuidance(
  issues: BacklogIssue[],
  inFlight: InFlightRuns = {},
): RunGuidance {
  if (issues.length === 0) return { kind: 'empty' };

  const runnable = issues
    .filter((issue) => runnableNow(issue, issues, inFlight))
    .sort(byIdAsc)
    .map((issue) => ({ id: issue.id, title: issue.title, fileName: issue.fileName }));
  if (runnable.length > 0) return { kind: 'eligible', runnable };

  // Nothing eligible. Any open issues left are — by the eligibility rule —
  // blocked on unmet dependencies; name them so the user knows what to unblock.
  // An open issue that's actually in flight / finished-unmerged in a worktree is
  // neither runnable nor blocked (its real progress lives on its `afk/` branch),
  // so it's omitted here too — the Map row already shows it running/finished
  // (issue 21).
  const inFlightIds = new Set<number>([
    ...(inFlight.worktreeRunningIds ?? []),
    ...(inFlight.finishedUnmergedIds ?? []),
  ]);
  const blocked = issues
    .filter((issue) => issue.status === 'open' && !inFlightIds.has(issue.id))
    .sort(byIdAsc)
    .map((issue) => {
      const state = deriveIssueState(issue, issues);
      return {
        id: issue.id,
        title: issue.title,
        unmet: state.kind === 'blocked' ? state.unmet : [],
      };
    });
  if (blocked.length > 0) return { kind: 'blocked', blocked };

  // No open issues at all — everything is done and/or wip.
  const doneCount = issues.filter((issue) => issue.status === 'done').length;
  const wipCount = issues.filter((issue) => issue.status === 'wip').length;
  return { kind: 'settled', doneCount, wipCount };
}

/** "03" from an id, zero-padded to two digits to match the Map's row labels. */
function idLabel(id: number): string {
  return String(id).padStart(2, '0');
}

/** "03 (wip)" / "07 (missing)" — names a blocker and its current status. */
function depLabel(dep: UnmetDependency): string {
  return `${idLabel(dep.id)} (${dep.status})`;
}

/**
 * A one-line human sentence for the guidance, so every consumer (banner,
 * empty-state, help text) phrases it identically. Pure and unit-tested — this
 * is where "names what's blocking" is proven.
 *
 * Blocked issues are grouped by the exact set of blockers they share, so the
 * message reads "06, 09 waiting on 03 (wip)" rather than repeating "03 (wip)"
 * per issue.
 */
export function describeRunGuidance(guidance: RunGuidance): string {
  switch (guidance.kind) {
    case 'eligible': {
      const ids = guidance.runnable.map((r) => idLabel(r.id)).join(', ');
      const noun = guidance.runnable.length === 1 ? 'issue' : 'issues';
      return `You can Run ${guidance.runnable.length} ${noun} right now: ${ids}.`;
    }
    case 'blocked': {
      // Group blocked issues by their shared blocker signature.
      const groups = new Map<string, { ids: number[]; unmet: UnmetDependency[] }>();
      for (const issue of guidance.blocked) {
        const key = issue.unmet.map((d) => d.id).join(',');
        const existing = groups.get(key);
        if (existing) existing.ids.push(issue.id);
        else groups.set(key, { ids: [issue.id], unmet: issue.unmet });
      }
      const parts = [...groups.values()].map((group) => {
        const ids = group.ids.map(idLabel).join(', ');
        if (group.unmet.length === 0) return `${ids} blocked`;
        const blockers = group.unmet.map(depLabel).join(', ');
        return `${ids} waiting on ${blockers}`;
      });
      return `No eligible issues to Run — ${parts.join('; ')}.`;
    }
    case 'settled': {
      const bits: string[] = [];
      if (guidance.doneCount > 0) bits.push(`${guidance.doneCount} done`);
      if (guidance.wipCount > 0) bits.push(`${guidance.wipCount} wip`);
      const detail = bits.length > 0 ? ` (${bits.join(', ')})` : '';
      return `No eligible issues to Run — every issue is done or wip${detail}.`;
    }
    case 'empty':
      return 'No issues in this backlog.';
  }
}
