/**
 * Run-narrative routing (PURE) — issue 66, ADR-0014.
 *
 * Three walkthroughs of channel-model iteration traced to one ambiguity: when
 * the user said "notify me in the chat", the chat always meant **the embedded
 * claude conversation itself** — the Dispatcher session narrating work the way
 * a terminal drain does — not the activity strip beside it. The ADR-0012
 * recalibration (a correct reaction to a proposal/approval firehose) muted run
 * *narrative* out of the conversation too; ADR-0014 restores it:
 *
 *   - **Run narrative flows into the Dispatcher session as messages, live** —
 *     each finished Run's Completion block (from its Receipt), HITL park
 *     notices, and the drain lifecycle facts worth telling (stopped, halted,
 *     adopted strays, finished-without-receipt).
 *   - **The blocking-approval list is unchanged** (ADR-0011's three items) —
 *     narrative is a message, never a gate. This module does not touch
 *     `action-authority`; it is a SEPARATE routing axis.
 *   - **The activity strip is history** — it keeps recording everything, but it
 *     is no longer the notification surface.
 *   - **The noise floor stands (ADR-0012)** — unknown/unclassifiable records,
 *     speculative signals (doc-drift, cross-Run overlap), and debounced
 *     status refreshes stay OUT of the conversation.
 *
 * This module is that decision as one exhaustive table (`narrativeChannelFor`),
 * plus the pump-key helpers that let live delivery and the on-ask digest
 * (issue 61) share one "session has seen it" set: a delivered narrative or
 * hitl-waiting message marks its Run-log record as seen by the CURRENT session
 * (`sessionSeenRecordId`), so a later digest never re-lists it — while a
 * replacement session (a brand-new claude conversation) resets the set and
 * catches up via the digest.
 *
 * PURE: no I/O, no Electron, no LLM, no timers. Unit-testable in isolation and
 * safe to share across main/renderer (and the e2e harness).
 */
import type { LifecycleEventKind } from './run-lifecycle';

/**
 * Everything the Dispatcher surfaces, classified for the ADR-0014 channel
 * model. An exhaustive union so a new surfaced thing fails to compile until it
 * is classified here — never silently defaulting to either channel.
 */
export type NarrativeEventKind =
  // --- Run narrative → the conversation (chat), live ---
  /** A finished Run's Completion block (from its Receipt, via the parsed record). */
  | 'run-completed'
  /** A HITL issue parked awaiting the human ("waiting for you", with steps). */
  | 'hitl-park'
  /**
   * A Run parked BLOCKED awaiting the human (issue 137). The drain no longer
   * halts on a declared-blocked Run, so its park is now the chat message a
   * `drain-halted` fact used to carry — never a silent skip.
   */
  | 'run-blocked-park'
  /** The user stopped the drain. */
  | 'drain-stopped'
  /** The drain halted/ended on its own (run blocked, nothing eligible, isolation failure). */
  | 'drain-halted'
  /** Stray Receipt(s) on main were adopted (issue 62) so the pipeline could proceed. */
  | 'strays-adopted'
  /** Ground truth says a Run ended but no Receipt exists (issue 57's honest gap). */
  | 'finished-without-receipt'
  // --- History strip only (the ADR-0012 noise floor stands) ---
  /** A Run's Pane spawned — routine, never a conversation message. */
  | 'run-started'
  /**
   * A blocked Run's captured block text (its full report). The chat message is
   * the `run-blocked-park` park notice (issue 137); this full block stays a
   * history line so the same Run never gets two chat messages.
   */
  | 'run-blocked-alert'
  /** A stranded isolated Run's alert (issue 22). */
  | 'run-stranded-alert'
  /** A Run stuck in a way the Dispatcher can't act on. */
  | 'needs-attention'
  /** A doc-drift finding — speculative signal, below the conversation bar. */
  | 'doc-drift'
  /** A cross-Run seam overlap — speculative signal (issue 38/47). */
  | 'cross-run-overlap'
  /** The debounced ground-truth status refresh — never streams into the chat. */
  | 'status-refresh'
  /** A Receipt/state disagreement note (ADR-0013 trust hierarchy). */
  | 'receipt-mismatch'
  /** A chat item's queued/typed/submitted observability line (issue 60). */
  | 'delivery-phase';

/** Where a surfaced thing lands: a live conversation message, or history only. */
export type NarrativeChannel = 'chat' | 'history';

/**
 * The full ADR-0014 line as an exhaustive table — every surfaced kind mapped to
 * its channel. A `Record` (not a `Set` + default) so a newly-added kind fails
 * to compile until it is classified.
 */
const NARRATIVE_CHANNEL: Record<NarrativeEventKind, NarrativeChannel> = {
  // Run narrative — messages in the Dispatcher conversation, live.
  'run-completed': 'chat',
  'hitl-park': 'chat',
  'run-blocked-park': 'chat',
  'drain-stopped': 'chat',
  'drain-halted': 'chat',
  'strays-adopted': 'chat',
  'finished-without-receipt': 'chat',
  // History strip only.
  'run-started': 'history',
  'run-blocked-alert': 'history',
  'run-stranded-alert': 'history',
  'needs-attention': 'history',
  'doc-drift': 'history',
  'cross-run-overlap': 'history',
  'status-refresh': 'history',
  'receipt-mismatch': 'history',
  'delivery-phase': 'history',
};

/** Route one surfaced kind to its ADR-0014 channel. This is the whole rule. */
export function narrativeChannelFor(kind: NarrativeEventKind): NarrativeChannel {
  return NARRATIVE_CHANNEL[kind];
}

/**
 * Map a lifecycle event (issue 37's vocabulary) onto the narrative table, so
 * the caller routes a reaction through ONE tested boundary — no ad-hoc channel
 * choice per call site. Total over the kind union (a `switch` with no default),
 * so a new lifecycle kind forces a routing decision here.
 */
export function narrativeKindForLifecycle(kind: LifecycleEventKind): NarrativeEventKind {
  switch (kind) {
    case 'started':
      return 'run-started';
    case 'finished':
      return 'run-completed';
    case 'blocked':
      // Issue 137: a declared-blocked Run parks awaiting the human and the drain
      // continues past it, so its park is a Run-narrative CHAT message now — the
      // `drain-halted` fact that used to carry it no longer fires for a block.
      return 'run-blocked-park';
    case 'stranded':
      return 'run-stranded-alert';
    case 'needs-attention':
      return 'needs-attention';
    case 'hitl-waiting':
      return 'hitl-park';
    case 'finished-without-receipt':
      return 'finished-without-receipt';
  }
}

// --- Session-seen keys ---------------------------------------------------------
//
// Issue 61's on-ask digest and issue 66's live feed must share ONE "this
// session has seen it" set, or a digest ask after live delivery repeats the
// Runs the session just narrated. The join point is the pump's delivery key:
// a completion-block message is enqueued under `narrative:<recordId>` and a
// park notice under `hitl-waiting:<recordId>`, so when the pump reports the
// submit landed (always in the CURRENT session — issue 60's guarantee), the
// caller can mark exactly that record as seen. Every other delivery key
// (status snapshots, blocking gates, drain facts) names no Run-log record and
// parses to null.

/** Prefix for a finished Run's Completion-block message in the pump queue. */
export const NARRATIVE_KEY_PREFIX = 'narrative:';

/** Prefix the lifecycle path already uses for a park notice (`<kind>:<runId>`). */
const HITL_KEY_PREFIX = 'hitl-waiting:';

/** The pump delivery key for a Run's Completion-block narrative message. */
export function narrativeKeyFor(recordId: string): string {
  return `${NARRATIVE_KEY_PREFIX}${recordId}`;
}

/**
 * The Run-log record id a delivered chat item accounts for, or null when the
 * key names no record (a status snapshot, a blocking gate, a drain fact).
 * Record ids contain colons (`receipt:<slug>:<finished>`), so this strips a
 * known prefix — it never splits on `:`.
 */
export function sessionSeenRecordId(deliveryKey: string): string | null {
  for (const prefix of [NARRATIVE_KEY_PREFIX, HITL_KEY_PREFIX]) {
    if (deliveryKey.startsWith(prefix) && deliveryKey.length > prefix.length) {
      return deliveryKey.slice(prefix.length);
    }
  }
  return null;
}
