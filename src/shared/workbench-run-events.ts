/**
 * Workbench run events (PURE) — which Run event just happened, and what the
 * Workbench auto-commit for it says (issue 72, ADR-0015).
 *
 * For a workbench Project, the pipeline artifacts (issue files, Receipts) live
 * in `~/Workbench/<project>/` — a git repo of its own. Workers flip claims and
 * write Receipts directly there (the shared claim surface), and Mission
 * Control auto-commits the Workbench after each Run event — claim observed,
 * park, done + Receipt — with boring `<project>: issue NN <event>` messages.
 * Never a push; code repos never receive these workflow commits.
 *
 * This module holds the decisions:
 *   - `claimEventsBetween` — which claims a backlog change just revealed
 *     (diff-based, so a re-observation of the same statuses yields nothing —
 *     the idempotence the acceptance criteria name);
 *   - `receiptRunEvent`    — which Run event an ingested Receipt DECLARES
 *     (done / park / blocked), from its declared outcome only (ADR-0013);
 *   - `workbenchCommitMessage` — the exact commit message for an event.
 *
 * House PURE contract: no I/O, never throws. The git side effect lives in
 * `src/main/workbench-git.ts`; the observation points (backlog watcher pushes,
 * Receipt ingests) are wired in the main process.
 */
import type { Backlog, IssueStatus } from './backlog-model';
import type { RunOutcome } from './completion-parser';

/** The Run events the Workbench auto-commit fires on. */
export type WorkbenchRunEventKind = 'claim' | 'done' | 'park' | 'blocked';

export interface WorkbenchRunEvent {
  issueId: number;
  event: WorkbenchRunEventKind;
}

/** A backlog's per-issue statuses, keyed by issue id — the diffable snapshot. */
export function statusSnapshot(backlog: Backlog | null): Map<number, IssueStatus> {
  const snapshot = new Map<number, IssueStatus>();
  for (const issue of backlog?.issues ?? []) snapshot.set(issue.id, issue.status);
  return snapshot;
}

/**
 * The CLAIM events between two backlog observations: every issue that is `wip`
 * now and wasn't before (open → wip, or a fresh `wip` issue appearing). A null
 * `prev` is the seed observation — nothing is an event yet, so an MC (re)start
 * over an already-claimed backlog commits nothing. Diff-based on purpose:
 * re-observing unchanged statuses yields [], which is what makes the
 * auto-commit fire once per event and stay quiet on re-observation.
 *
 * Done flips are deliberately NOT status events: "done + Receipt" is ONE Run
 * event, driven by the Receipt ingest (`receiptRunEvent`) so the commit
 * captures the flip and the Receipt together. Ascending by issue id.
 */
export function claimEventsBetween(
  prev: ReadonlyMap<number, IssueStatus> | null,
  next: ReadonlyMap<number, IssueStatus>,
): WorkbenchRunEvent[] {
  if (prev === null) return [];
  const events: WorkbenchRunEvent[] = [];
  for (const [issueId, status] of next) {
    if (status === 'wip' && prev.get(issueId) !== 'wip') {
      events.push({ issueId, event: 'claim' });
    }
  }
  return events.sort((a, b) => a.issueId - b.issueId);
}

/**
 * The Run event an ingested Receipt DECLARES (ADR-0013: declared state only,
 * never prose heuristics): `completed` ⇒ done (the flip + Receipt commit as
 * one event), `needs-verification` ⇒ park, `blocked` ⇒ blocked. An `unknown`
 * outcome, or a Receipt whose issue id could not be read, is no event — the
 * next event's sweep commits whatever it left on disk.
 */
export function receiptRunEvent(
  issueId: number | null,
  outcome: RunOutcome | null,
): WorkbenchRunEvent | null {
  if (issueId === null || !Number.isFinite(issueId)) return null;
  if (outcome === 'completed') return { issueId, event: 'done' };
  if (outcome === 'needs-verification') return { issueId, event: 'park' };
  if (outcome === 'blocked') return { issueId, event: 'blocked' };
  return null;
}

/**
 * The Workbench auto-commit message for one Run event, exactly as ADR-0015
 * fixes it: `<project>: issue NN <event>` — boring on purpose.
 */
export function workbenchCommitMessage(
  project: string,
  event: WorkbenchRunEvent,
): string {
  const num = String(event.issueId).padStart(2, '0');
  return `${project}: issue ${num} ${event.event}`;
}
