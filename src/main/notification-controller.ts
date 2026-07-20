/**
 * Notification controller — issue 138.
 *
 * The stateful glue between the pure decision module
 * (`shared/attention-notifications`) and the thin adapter
 * (`main/notification-adapter`). It holds the already-notified key set across
 * the three event sources the main process observes and decides, per source,
 * what to hand the adapter to show:
 *
 *   - `attentionChanged` — the app-level attention watch's aggregated snapshot,
 *     the SINGLE source of HITL/blocked parks (so N open Windows never ping N
 *     times). The FIRST snapshot only SEEDS the seen set: a park already on disk
 *     when this session started is not a fresh event, so the launch never dumps
 *     a burst of pings for pre-existing parks ("never otherwise", ADR-0016).
 *     Every later snapshot fires only genuinely-new parks, deduped for the
 *     session — a re-scan of unchanged state re-pings nothing.
 *   - `mergeConflicted` — a Merge hit a conflict; deduped on the conflicting set
 *     so a merge-as-you-go retry of the same set does not re-ping.
 *   - `drainEnded` — a terminal drain moment. A drain ends exactly once per drain
 *     at its source, so this always pings and is deliberately NOT remembered in
 *     the long-lived seen set: that is how "per drain" is honored for the
 *     terminal moment while parks/merges stay deduped across the session.
 *   - `scheduledDrainSkipped` — a scheduled drain (issue 190, ADR-0024) fired
 *     but an interactive gate would have prompted with nobody there to answer
 *     (issue 191); it skipped instead of starting. Same one-shot-per-fire
 *     discipline as `drainEnded` — never remembered in the seen set, since a
 *     later fire of the SAME schedule never happens (one-shot by
 *     construction) and a fresh schedule's skip is always a new event.
 *
 * Electron-free on purpose (the Electron `Notification` lives behind the injected
 * `show`), so the seed/dedupe behavior is unit-testable with a plain spy — like
 * the watchers it sits beside.
 */
import {
  decideNotifications,
  type NotificationEvent,
  type NotificationIntent,
} from '../shared/attention-notifications';
import type { AttentionItem } from '../shared/attention-hub-model';

export interface NotificationControllerOptions {
  /** Show the decided intents (the electron adapter's `show`, injected). */
  show: (intents: NotificationIntent[]) => void;
}

export class NotificationController {
  private seen = new Set<string>();
  private seeded = false;
  private readonly show: (intents: NotificationIntent[]) => void;

  constructor(opts: NotificationControllerOptions) {
    this.show = opts.show;
  }

  /** A new aggregated attention snapshot arrived — fire new parks (seed first). */
  attentionChanged(items: readonly AttentionItem[]): void {
    const event: NotificationEvent = { type: 'attention', items: items ?? [] };
    if (!this.seeded) {
      this.seen = decideNotifications(event, this.seen).seen;
      this.seeded = true;
      return;
    }
    this.fire(event);
  }

  /** A Merge hit a conflict a human must resolve. */
  mergeConflicted(
    project: string,
    slugs: readonly string[] = [],
    conflictingFiles: readonly string[] = [],
  ): void {
    this.fire({ type: 'merge-conflict', project, slugs, conflictingFiles });
  }

  /** A drain reached a terminal moment (halted early, or the backlog drained). */
  drainEnded(project: string, outcome: 'stopped' | 'finished', reason?: string | null): void {
    // Not threaded through the persistent seen set — each drain's end is its own
    // one-shot moment (see the class comment).
    const { intents } = decideNotifications(
      { type: 'drain-ended', project, outcome, reason },
      new Set(),
    );
    if (intents.length > 0) this.show(intents);
  }

  /** A scheduled drain fired but skipped instead of starting (issue 191). */
  scheduledDrainSkipped(project: string, reason: string): void {
    // Not threaded through the persistent seen set, same as `drainEnded` —
    // each fire's skip is its own one-shot moment.
    const { intents } = decideNotifications(
      { type: 'scheduled-drain-skipped', project, reason },
      new Set(),
    );
    if (intents.length > 0) this.show(intents);
  }

  private fire(event: NotificationEvent): void {
    const { intents, seen } = decideNotifications(event, this.seen);
    this.seen = seen;
    if (intents.length > 0) this.show(intents);
  }
}
