/**
 * Dispatcher rolling-synthesis state (PURE) — issue 39, ADR-0009.
 *
 * The Dispatcher applies the user's `/clear`-per-issue insight to ITSELF so a
 * long drain (50–100 issues) doesn't degrade its judgment. This module is the
 * pure fold behind that: `(situationSummary, event) → boundedNextState`. It
 * keeps the Dispatcher's ACTIVE context bounded by folding finished/merged
 * issues into a compact running "situation summary" and dropping their verbatim
 * Completion blocks, while keeping full verbatim detail only for the threads
 * that still need it — **open or flagged** (e.g. doc-drift) ones.
 *
 * Active context (what the Dispatcher reasons over) is therefore a bounded
 * sliding window:
 *
 *   seed  +  rolling synthesis  +  recent-N blocks  +  open/flagged threads
 *
 * The Run log on disk (issue 34's `RunLogStore`) remains the COMPLETE, durable
 * history: a block dropped from active context here is never lost — the
 * Dispatcher can re-read it on demand (`recallBlock`) when a later issue makes
 * an early one relevant. That is the whole point of dropping it from active
 * context: bounded working memory, full recall on disk.
 *
 * The retention rule, encoded here (ADR-0009):
 *   - a **finished-and-merged** issue (`outcome: 'completed'` with no doc-drift)
 *     folds into the running summary and DROPS from verbatim;
 *   - an **open or flagged** thread (blocked / needs-verification / unparsed, OR
 *     a completed block that reports doc-drift) STAYS verbatim;
 *   - a superseding event for an issue (a blocked Run that later completes)
 *     replaces its earlier entry, so a resolved thread folds and stops being
 *     kept verbatim.
 *
 * Boundedness: `recentBlocks` is capped at `recentWindow`; the summary's
 * `highlights` tail is capped at `maxHighlights` (older highlights drop — still
 * on disk); `folded` is a count. So the state's size is O(1) in the number of
 * finished issues. The only thing that legitimately grows is the set of
 * genuinely-unresolved open/flagged threads — detail you cannot bound away
 * without losing the very context the Dispatcher needs.
 *
 * This REUSES the existing structured event (`CompletionBlockEvent`, the
 * whitelisted no-raw-Pane-scroll shape from the input contract), the doc-drift
 * predicate (`reportsDocDrift` from dispatcher-synthesis), and the verbatim
 * renderer (`renderCompletionEvent`) rather than re-deriving any of them.
 *
 * PURE: no I/O, no Electron, no LLM, no timers. Unit-testable in isolation and
 * safe to share across main/renderer.
 */
import {
  renderCompletionEvent,
  type CompletionBlockEvent,
} from './dispatcher-input-contract';
import { reportsDocDrift } from './dispatcher-synthesis';
import type { RunLogRecord } from './ipc-contract';

/** Default size of the verbatim recent-N window kept in active context. */
export const DEFAULT_RECENT_WINDOW = 5;
/** Default cap on the running summary's tail of one-line highlights. */
export const DEFAULT_MAX_HIGHLIGHTS = 5;
/** Max characters of a folded block's "what changed" kept as a one-line highlight. */
const HIGHLIGHT_CHARS = 120;

/** Tunable retention bounds. Defaults keep active context comfortably small. */
export interface RetentionOptions {
  /** How many most-recent blocks to keep verbatim (default 5). */
  recentWindow?: number;
  /** How many folded one-line highlights to keep in the summary tail (default 5). */
  maxHighlights?: number;
}

/**
 * The compact running summary of everything folded away. Bounded by design:
 * `folded` is a count and `highlights` is a capped tail — the full detail of
 * every folded issue lives in the Run log, re-readable on demand.
 */
export interface RollingSummary {
  /** Total finished/merged issues folded into the summary so far. */
  folded: number;
  /** One-line highlights of the most-recently folded issues (≤ maxHighlights). */
  highlights: string[];
}

/**
 * The Dispatcher's bounded active context (minus the fixed seed, which the
 * renderer prepends). `recentBlocks` and `openThreads` are disjoint: an issue's
 * event lives in exactly one of them (a superseding event moves it), never both.
 */
export interface SituationState {
  /** The compact digest of folded (finished) issues. */
  rollingSummary: RollingSummary;
  /** The most-recent blocks, verbatim, oldest→newest, capped at `recentWindow`. */
  recentBlocks: CompletionBlockEvent[];
  /**
   * Open/flagged blocks (blocked / needs-verification / unparsed / doc-drift)
   * that have aged out of the recent window but must stay verbatim, keyed unique
   * per thread. Kept because their full detail is still live context.
   */
  openThreads: CompletionBlockEvent[];
}

/** The empty starting state, before any Run has finished. */
export function emptyState(): SituationState {
  return { rollingSummary: { folded: 0, highlights: [] }, recentBlocks: [], openThreads: [] };
}

/**
 * A stable per-thread key: an issue's lifecycle keys on its issue id (so a
 * blocked Run that later completes supersedes its own earlier block), falling
 * back to the Run id when no issue id was parsed.
 */
function threadKey(event: CompletionBlockEvent): string {
  return event.issueId !== null ? `issue:${event.issueId}` : `run:${event.id}`;
}

/**
 * Whether a block is FINISHED-AND-MERGED and therefore foldable: a clean
 * completion with no doc-drift flag. Everything else is open or flagged.
 */
export function isFoldable(event: CompletionBlockEvent): boolean {
  return event.outcome === 'completed' && !reportsDocDrift(event);
}

/** The complement: open (blocked/needs-verification/unparsed) or flagged (doc-drift). */
export function isOpenOrFlagged(event: CompletionBlockEvent): boolean {
  return !isFoldable(event);
}

/** Collapse whitespace and truncate to a single bounded line. */
function truncate(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A short label for a block: `issue NN`, else its descriptor, else its Run id. */
function labelOf(event: CompletionBlockEvent): string {
  if (event.issueId !== null) return `issue ${String(event.issueId).padStart(2, '0')}`;
  if (event.issue) return event.issue;
  return `run ${event.id}`;
}

/** Build the one-line highlight a folded block contributes to the summary. */
function highlightOf(event: CompletionBlockEvent): string {
  const gist = event.whatChanged ?? event.issue ?? '';
  return gist ? `${labelOf(event)}: ${truncate(gist, HIGHLIGHT_CHARS)}` : labelOf(event);
}

/** Fold one finished block into the summary, keeping only the capped highlight tail. */
function foldInto(
  summary: RollingSummary,
  event: CompletionBlockEvent,
  maxHighlights: number,
): RollingSummary {
  const highlights = [...summary.highlights, highlightOf(event)];
  return {
    folded: summary.folded + 1,
    // Keep the most-recent highlights; older ones drop off the front (their full
    // detail is still on disk in the Run log).
    highlights: maxHighlights > 0 ? highlights.slice(-maxHighlights) : [],
  };
}

/**
 * The core fold: `(situationSummary, event) → boundedNextState`. Pure — returns
 * a new state, never mutates the input.
 *
 * On each event:
 *   1. Supersede — drop any prior entry for the same thread from both the recent
 *      window and the open/flagged set (a later event for an issue replaces it).
 *   2. Push the event onto the recent window (newest).
 *   3. Evict the overflow (oldest beyond `recentWindow`): fold the finished ones
 *      into the summary + drop them verbatim; move open/flagged ones into
 *      `openThreads` so their full detail is retained.
 */
export function foldEvent(
  state: SituationState,
  event: CompletionBlockEvent,
  options: RetentionOptions = {},
): SituationState {
  const recentWindow = Math.max(0, options.recentWindow ?? DEFAULT_RECENT_WINDOW);
  const maxHighlights = options.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS;
  const key = threadKey(event);

  // 1. Supersede any earlier entry for this same thread.
  const openThreads = state.openThreads.filter((e) => threadKey(e) !== key);
  const recentKept = state.recentBlocks.filter((e) => threadKey(e) !== key);

  // 2. Newest block goes on the end of the recent window.
  const withNew = [...recentKept, event];

  // 3. Evict everything past the window from the FRONT (the oldest).
  const overflow = Math.max(0, withNew.length - recentWindow);
  const evicted = withNew.slice(0, overflow);
  const recentBlocks = withNew.slice(overflow);

  let rollingSummary = state.rollingSummary;
  let nextOpen = openThreads;
  for (const e of evicted) {
    if (isFoldable(e)) {
      rollingSummary = foldInto(rollingSummary, e, maxHighlights);
    } else {
      nextOpen = [...nextOpen, e];
    }
  }

  return { rollingSummary, recentBlocks, openThreads: nextOpen };
}

/** Convenience reducer: fold a whole stream of events from a starting state. */
export function foldEvents(
  state: SituationState,
  events: readonly CompletionBlockEvent[],
  options: RetentionOptions = {},
): SituationState {
  return events.reduce((acc, event) => foldEvent(acc, event, options), state);
}

/** Render the compact running summary as plain text. */
function renderRollingSummary(summary: RollingSummary): string {
  if (summary.folded === 0) return 'Situation summary: no finished issues folded yet.';
  const lines = [
    `Situation summary: ${summary.folded} finished issue(s) folded away ` +
      `(full detail in the Run log, re-readable on demand).`,
  ];
  if (summary.highlights.length > 0) {
    lines.push('Most recent folded:');
    for (const h of summary.highlights) lines.push(`- ${h}`);
  }
  return lines.join('\n');
}

/**
 * Render the Dispatcher's bounded ACTIVE context as one plain-text block:
 * seed (optional) + rolling summary + open/flagged threads (verbatim) + the
 * recent-N blocks (verbatim). This is what stays small across a long drain.
 * Verbatim blocks reuse `renderCompletionEvent`, so they read identically to how
 * they were fed in.
 */
export function renderActiveContext(state: SituationState, seed?: string | null): string {
  const parts: string[] = [];
  if (seed && seed.trim()) parts.push(seed.trim());
  parts.push(renderRollingSummary(state.rollingSummary));

  if (state.openThreads.length > 0) {
    parts.push('Open / flagged threads (full detail retained):');
    for (const e of state.openThreads) parts.push(renderCompletionEvent(e));
  }

  if (state.recentBlocks.length > 0) {
    parts.push(`Recent ${state.recentBlocks.length} block(s):`);
    for (const e of state.recentBlocks) parts.push(renderCompletionEvent(e));
  }

  return parts.join('\n\n');
}

/**
 * On-demand recall from the durable Run log (ADR-0009): return the latest
 * persisted record for an issue id, or null when none exists. `records` are the
 * `RunLogStore.read` output (newest-first), so the first match is the freshest.
 * This is how the Dispatcher re-reads a block it folded out of active context
 * when a later issue references an early one.
 */
export function recallBlock(
  records: readonly RunLogRecord[],
  issueId: number,
): RunLogRecord | null {
  for (const record of records) {
    if (record.issueId === issueId) return record;
  }
  return null;
}
