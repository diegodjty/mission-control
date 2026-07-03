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

// --- Debounce backward status moves (issue 49, ADR-0012) --------------------
//
// A reconcile is a single snapshot of the live sources; mid-reconcile it can
// briefly show a finished issue as `open` (its `done` flip not yet re-read, a
// branch mid-merge). Surfacing that snapshot straight away produced the
// dogfood's false "05/06/07 regressed to open — the merge is failing" alarm.
// The fix: a BACKWARD status move (a regression — a drop to a lower point in the
// open → wip → finished-unmerged → done/merged pipeline) is HELD until it has
// persisted across ≥1 further reconcile checkpoint; only then is it surfaced.
// FORWARD moves surface immediately, exactly as before. This is a pure fold over
// the reconciled model plus the carried debounce state — no I/O, unit-testable.

/**
 * Progress rank of a grounded status: higher = further along the pipeline
 * (open → wip → finished-unmerged → done/merged). A move to a LOWER rank is a
 * BACKWARD transition (a regression, debounced); a move to a higher rank is
 * FORWARD (surfaced immediately).
 */
const STATUS_RANK: Record<GroundedStatus, number> = {
  open: 0,
  wip: 1,
  'finished-unmerged': 2,
  done: 3,
};

/**
 * Reconcile checkpoints a backward move must be OBSERVED on before it is
 * surfaced — the checkpoint it first appears PLUS at least one more. `2` means a
 * single transient mid-reconcile snapshot is suppressed, and a regression that
 * survives to the next checkpoint passes through. (ADR-0012.)
 */
export const REGRESSION_CHECKPOINTS = 2;

/** A backward move seen but not yet surfaced, awaiting confirmation. */
export interface PendingRegression {
  /** The lower (regressed) status most recently observed while held back. */
  readonly observed: GroundedStatus;
  /** Consecutive reconcile checkpoints the regression has been observed (≥1). */
  readonly checkpoints: number;
}

/**
 * The state carried between reconcile checkpoints so the debounce can tell a
 * one-snapshot blip from a persistent regression. Thread the returned `state`
 * from one `debounceStatusModel` call into the next.
 */
export interface StatusDebounceState {
  /** Last SURFACED status per issue id — what the Dispatcher has actually been told. */
  readonly effective: ReadonlyMap<number, GroundedStatus>;
  /** Backward moves seen but not yet surfaced, per issue id. */
  readonly pending: ReadonlyMap<number, PendingRegression>;
}

/** A fresh debounce state — nothing surfaced yet, nothing pending. */
export function initialStatusDebounceState(): StatusDebounceState {
  return { effective: new Map(), pending: new Map() };
}

/** Result of one debounce checkpoint: the model to surface + the state to carry. */
export interface DebouncedStatusModel {
  /** The model to surface — regressions held at their prior status until confirmed. */
  model: DispatcherStatusModel;
  /** The debounce state to feed into the next checkpoint. */
  state: StatusDebounceState;
}

/** Recompute the id buckets from a (possibly held-back) set of surfaced statuses. */
function rebuildBuckets(
  reconciled: DispatcherStatusModel,
  issues: IssueGroundStatus[],
): DispatcherStatusModel {
  const idsWhere = (status: GroundedStatus): number[] =>
    issues.filter((i) => i.status === status).map((i) => i.issueId);
  return {
    issues,
    doneIds: idsWhere('done'),
    finishedUnmergedIds: idsWhere('finished-unmerged'),
    wipIds: idsWhere('wip'),
    openIds: idsWhere('open'),
    // Needs-look is orthogonal to status transitions — passed through untouched.
    needsLook: reconciled.needsLook,
  };
}

/**
 * Debounce backward status moves in a freshly-reconciled model against what was
 * last surfaced. One call = one reconcile checkpoint.
 *
 * Per issue, comparing the reconciled status to the last surfaced status:
 *   - FORWARD / unchanged / a brand-new issue → surface immediately, clear any
 *     pending regression for it.
 *   - BACKWARD → hold at the prior (higher) status and increment its pending
 *     checkpoint count; once that count reaches `REGRESSION_CHECKPOINTS` the
 *     regression has persisted long enough and is surfaced. A recovery to the
 *     prior status (or forward) before then clears the pending — the blip is
 *     never surfaced.
 *
 * Pure: depends only on its two arguments and returns the next state; it never
 * mutates the inputs.
 */
export function debounceStatusModel(
  reconciled: DispatcherStatusModel,
  prior: StatusDebounceState,
): DebouncedStatusModel {
  const effective = new Map<number, GroundedStatus>();
  const pending = new Map<number, PendingRegression>();

  const surfaced: IssueGroundStatus[] = reconciled.issues.map((issue) => {
    const raw = issue.status;
    const prev = prior.effective.get(issue.issueId);

    // First sighting, forward, or unchanged: surface as-is (a new issue is not a
    // regression — there is no prior status to fall back to).
    if (prev === undefined || STATUS_RANK[raw] >= STATUS_RANK[prev]) {
      effective.set(issue.issueId, raw);
      return issue;
    }

    // Backward relative to what we last surfaced — this is a regression.
    const checkpoints = (prior.pending.get(issue.issueId)?.checkpoints ?? 0) + 1;
    if (checkpoints >= REGRESSION_CHECKPOINTS) {
      // Persisted across the debounce window → let it through.
      effective.set(issue.issueId, raw);
      return issue;
    }

    // Hold: keep surfacing the higher prior status, remember the pending move.
    effective.set(issue.issueId, prev);
    pending.set(issue.issueId, { observed: raw, checkpoints });
    return { ...issue, status: prev };
  });

  return { model: rebuildBuckets(reconciled, surfaced), state: { effective, pending } };
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
