/**
 * Dispatcher status model (PURE) — issue 43.
 *
 * The bug this module fixes: the Dispatcher used to infer "what's done / what's
 * left" ONLY from the Completion blocks it was fed (plus the seed backlog
 * snapshot taken when the drain started). A block that was missed, misparsed, or
 * dropped (an `unknown` outcome was silently skipped) drifted its picture away
 * from reality — observed on issue 35's walkthrough as the Dispatcher reporting
 * 03/04 "still to run" when they were already `done`. And for cap≥2 the same
 * drift arrives by another route: a finished isolated Run's `done` flip lives on
 * its `afk/NN-slug` branch, invisible to anything reading `main` or the blocks.
 *
 * The fix (ADR-0001's "learn state from the Artifacts on disk, not the stream"):
 * the Dispatcher's AUTHORITATIVE model of which issues are open / wip / done /
 * finished-unmerged is RECONCILED from the same live sources of truth the Map
 * uses — the backlog (`backlog-model`), the on-disk `afk/` scan
 * (`worktree-scan`, incl. its `finished-unmerged` classification), and the
 * durable Run log — and re-grounded as those change. Completion blocks stay the
 * source of the QUALITATIVE synthesis (what changed, why blocked, doc-drift);
 * they are no longer the source of STATUS.
 *
 * Two things this guarantees that the block stream could not:
 *   - the done-set always matches the backlog/afk-scan, never the (lossy) blocks;
 *   - an `unknown`-outcome capture is CONVEYED as a "needs a look" item (carrying
 *     its `detail`, issue 42) instead of silently dropped — nothing a Run emitted
 *     is lost, even when it never parsed to a clean completion.
 *
 * PURE: no I/O, no Electron, no LLM. Unit-testable in isolation and safe to
 * share across main/renderer. The renderer (App.tsx) recomputes it from live
 * state and feeds `renderStatusModel` into the Dispatcher session as it changes.
 */
import type { Backlog } from './backlog-model';
import type { WorktreeRunState } from './worktree-scan';
import type { RunLogRecord } from './ipc-contract';

/**
 * The grounded status of one issue. A superset of the backlog's `IssueStatus`
 * with `finished-unmerged` — the state that exists ONLY on disk in an `afk/`
 * branch (committed `done`, not yet merged into `main`), which the main-checkout
 * backlog can never show.
 */
export type GroundedStatus = 'open' | 'wip' | 'done' | 'finished-unmerged';

/** One issue's reconciled ground-truth status. */
export interface IssueGroundStatus {
  issueId: number;
  slug: string | null;
  title: string | null;
  status: GroundedStatus;
}

/**
 * A capture the Dispatcher must be told about but that could NOT be classified
 * (outcome `unknown`) — surfaced with its `detail` so nothing a Run emitted is
 * lost, and explicitly NOT counted as done.
 */
export interface NeedsLookItem {
  /** The Run (session) id the capture came from. */
  runId: string;
  issueId: number | null;
  slug: string | null;
  title: string | null;
  /** The captured report body (issue 42), or null. */
  detail: string | null;
}

/**
 * The reconciled status model handed to the Dispatcher: the per-issue grounded
 * status (ascending by id), the id buckets for convenience, and the unknown
 * captures conveyed as "needs a look".
 */
export interface DispatcherStatusModel {
  issues: IssueGroundStatus[];
  doneIds: number[];
  finishedUnmergedIds: number[];
  wipIds: number[];
  openIds: number[];
  needsLook: NeedsLookItem[];
}

/** The live sources of truth reconciled into the status model. */
export interface StatusModelInput {
  /** The active Project's backlog (main-checkout truth). Null before it loads. */
  backlog: Backlog | null;
  /** The on-disk `afk/` scan's per-issue states (issue 16), incl. finished-unmerged. */
  worktreeStates: readonly WorktreeRunState[];
  /** The durable Run log (newest first), read for its unknown captures only. */
  runLog: readonly RunLogRecord[];
}

/** Max characters of a `detail` body kept on a needs-look item, to stay bounded. */
const DETAIL_CHARS = 200;

/** Collapse whitespace and truncate to a single bounded line. */
function truncate(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Reconcile the Dispatcher's authoritative status model from the live backlog,
 * the on-disk `afk/` scan, and the Run log.
 *
 * Rules:
 *   1. Each issue's base status is the backlog's (open/wip/done) — the
 *      main-checkout truth, which is where a solo Run's `done` flip lands.
 *   2. A `finished-unmerged` `afk/` branch OVERLAYS that base: its committed
 *      `done` is real work not yet on `main`, so the issue is `finished-unmerged`
 *      unless the backlog already reads `done` (already merged → keep `done`).
 *      A finished-unmerged issue the backlog doesn't list at all is added.
 *   3. `unknown`-outcome Run-log captures are conveyed as `needsLook` (with their
 *      `detail`), never folded into any status bucket — they are NOT done.
 *
 * Note the Run log is deliberately NOT consulted for done-ness: a Run's block
 * saying "completed" is the very signal that drifted (missed/misparsed). Status
 * comes from the backlog + scan; the blocks remain for qualitative synthesis.
 */
export function reconcileStatusModel(input: StatusModelInput): DispatcherStatusModel {
  const byId = new Map<number, IssueGroundStatus>();

  // 1. Base every issue on the backlog's status.
  for (const issue of input.backlog?.issues ?? []) {
    byId.set(issue.id, {
      issueId: issue.id,
      slug: issue.slug,
      title: issue.title,
      status: issue.status as GroundedStatus,
    });
  }

  // 2. Overlay finished-unmerged from the on-disk `afk/` scan.
  for (const state of input.worktreeStates) {
    if (state.kind !== 'finished-unmerged') continue;
    const existing = byId.get(state.issueId);
    if (existing) {
      // Already `done` in the backlog means it is merged onto `main` — keep it.
      if (existing.status !== 'done') existing.status = 'finished-unmerged';
    } else {
      byId.set(state.issueId, {
        issueId: state.issueId,
        slug: state.slug,
        title: null,
        status: 'finished-unmerged',
      });
    }
  }

  const issues = [...byId.values()].sort((a, b) => a.issueId - b.issueId);

  const idsWhere = (status: GroundedStatus): number[] =>
    issues.filter((i) => i.status === status).map((i) => i.issueId);

  // 3. Convey the unknown captures — never drop them.
  const needsLook: NeedsLookItem[] = [];
  for (const rec of input.runLog) {
    if (rec.outcome !== 'unknown') continue;
    needsLook.push({
      runId: rec.id,
      issueId: rec.issueId,
      slug: rec.slug,
      title: rec.title,
      detail: rec.detail,
    });
  }

  return {
    issues,
    doneIds: idsWhere('done'),
    finishedUnmergedIds: idsWhere('finished-unmerged'),
    wipIds: idsWhere('wip'),
    openIds: idsWhere('open'),
    needsLook,
  };
}

/** `NN`, zero-padded to two digits to match the rest of the Dispatcher's output. */
function idLabel(id: number): string {
  return String(id).padStart(2, '0');
}

/** Comma list of ids, ascending as the model already sorts them. */
function idList(ids: readonly number[]): string {
  return ids.map(idLabel).join(', ');
}

/** A short label for a needs-look item: `issue NN — slug`, else the Run id. */
function needsLookLabel(item: NeedsLookItem): string {
  if (item.issueId !== null) {
    return `issue ${idLabel(item.issueId)}${item.slug ? ` — ${item.slug}` : ''}`;
  }
  return `run ${item.runId}`;
}

/**
 * Render the status model as ONE plain-text message to feed the Dispatcher — the
 * re-grounding it should trust for "what's done / left" over anything it inferred
 * from the block stream. Only non-empty sections are listed. Used both as the fed
 * message and as the change signature (the renderer re-feeds only when it
 * changes), so a steady state produces no repeat.
 */
export function renderStatusModel(model: DispatcherStatusModel): string {
  const lines: string[] = [
    'Ground-truth status (reconciled from the live backlog, the afk-scan, and the Run log — ' +
      'this is authoritative for what is done/left; use the completion blocks only for ' +
      'qualitative detail, not for status):',
  ];

  if (model.issues.length === 0 && model.needsLook.length === 0) {
    return 'Ground-truth status: the backlog has not loaded yet — nothing to report.';
  }

  if (model.doneIds.length > 0) lines.push(`- Done (merged): ${idList(model.doneIds)}`);
  if (model.finishedUnmergedIds.length > 0) {
    lines.push(`- Finished, not yet merged: ${idList(model.finishedUnmergedIds)}`);
  }
  if (model.wipIds.length > 0) lines.push(`- In progress (wip): ${idList(model.wipIds)}`);
  if (model.openIds.length > 0) lines.push(`- Open: ${idList(model.openIds)}`);

  if (model.needsLook.length > 0) {
    lines.push(
      `- Needs a look — ${model.needsLook.length} Run(s) emitted output that could not be ` +
        'classified; do NOT treat these as done:',
    );
    for (const item of model.needsLook) {
      const detail = item.detail ? `: ${truncate(item.detail, DETAIL_CHARS)}` : '';
      lines.push(`  - ${needsLookLabel(item)}${detail}`);
    }
  }

  return lines.join('\n');
}
