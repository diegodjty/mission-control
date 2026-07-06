/**
 * Dispatcher chat submit-pump (issue 60) — the unstallable delivery queue for
 * everything typed into the Dispatcher chat PTY.
 *
 * The live failure this module exists to kill: issue 05's `needs-verification`
 * Receipt was ingested and the pure hitl-waiting derivation was unit-green, yet
 * the blocking "waiting for you" notification never reached the chat. The old
 * pump (inlined in App.tsx) lost it between enqueue and the PTY:
 *
 *   - the session id was captured in a CLOSURE, so a Dispatcher session
 *     replaced mid-pump (gate churn respawning the chat Pane) kept receiving
 *     the writes — into a dead PTY, fire-and-forget, silently;
 *   - each item was `shift()`ed BEFORE its delivery was assured, so an aborted
 *     chain lost the message outright;
 *   - the `write` + `setTimeout` step chain had NO error path — one throw left
 *     the pumping flag stuck `true`, stranding every later notification in the
 *     queue forever;
 *   - nothing ever re-kicked a non-empty queue that had stopped pumping.
 *
 * The three issue-60 rules, encoded here:
 *
 *   1. **The pump can't stay stuck.** Every scheduled continuation carries a
 *      chain token and re-checks the CURRENT session; a write failure resets
 *      the pumping state; a watchdog re-kicks a queue that is non-empty but not
 *      making progress.
 *   2. **Blocking notifications are never droppable.** The queue is owned by
 *      the caller's Project scope, not by any one PTY session: an item is
 *      PEEKED (not shifted) until its submit write lands in a still-current
 *      session, so session replacement or death requeues it for full re-typing
 *      into whatever session attaches next.
 *   3. **Delivery is observable.** Each item reports queued → typed →
 *      submitted (plus requeued / write-failed) through `onDelivery`, keyed by
 *      its event key, so a walkthrough can SEE where a notification died.
 *
 * Timers and the clock are injected (`scheduler` / `now`), so the pump is fully
 * unit-testable with manual time — no React, no Electron, no real timers.
 */
import { buildSubmitSequence, buildTypeOnlySequence } from './dispatcher-feed';

/**
 * Observable delivery phases per chat item (issue 60 rule 3). A type-only item
 * (issue 91) ends at `typed` — that IS its delivery; it never reports
 * `submitted`.
 */
export type DeliveryPhase = 'queued' | 'typed' | 'submitted' | 'requeued' | 'write-failed';

/** One chat-tier message, keyed by its event key (e.g. `hitl-waiting:<runId>`). */
export interface ChatDeliveryItem {
  /** Stable event key — used for in-queue dedupe and delivery observability. */
  key: string;
  /** The message to type (and, unless `submit: false`, submit) into the PTY. */
  text: string;
  /**
   * `false` = type only, never press Enter (issue 91): the text is a PREFIX
   * the user completes and submits themselves (the Planning view's Grill
   * button). Omitted/`true` = the normal type-then-submit delivery. The
   * defer-while-typing gate and requeue-on-session-change rules apply to both
   * kinds identically.
   */
  submit?: boolean;
}

/** Injected timer surface so tests drive time manually. */
export interface PumpScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** Real timers, for the app. */
export const defaultScheduler: PumpScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Recheck cadence while the defer-while-typing gate holds (issue 48): short
 * enough that a blocking prompt lands promptly once the line goes idle, long
 * enough not to busy-spin.
 */
export const PUMP_TYPING_RECHECK_MS = 250;

/**
 * Watchdog cadence: while the queue is non-empty, a tick this often re-kicks a
 * pump that is not running (e.g. after a write failure) and force-restarts a
 * chain that has made no progress for `PUMP_STALL_MS` (a continuation that died
 * without resetting state). The watchdog is what makes "stuck forever" —
 * the exact issue-60 failure — structurally impossible.
 */
export const PUMP_WATCHDOG_MS = 2000;

/**
 * How long a nominally-pumping chain may go without any step progress before
 * the watchdog declares it dead and restarts against the current session.
 * A healthy chain touches progress at least every `PUMP_TYPING_RECHECK_MS` /
 * step-settle (≤ 350ms), so 1500ms only trips on a genuinely dead chain.
 */
export const PUMP_STALL_MS = 1500;

/** The pump's injected effects — all I/O and time behind this seam. */
export interface DispatcherPumpEffects {
  /** Write bytes to a PTY session. May throw; the pump recovers (rule 1). */
  write(sessionId: string, data: string): void;
  /** The defer-while-typing gate (issue 48): may a programmatic write flush now? */
  canFlush(now: number): boolean;
  /** Clock; defaults to Date.now. */
  now?(): number;
  /** Delivery observability hook (rule 3); phases land in the ambient log. */
  onDelivery?(key: string, phase: DeliveryPhase, detail?: string): void;
  /** Timer surface; defaults to real setTimeout/clearTimeout. */
  scheduler?: PumpScheduler;
}

export interface DispatcherPump {
  /**
   * Queue one chat message. Returns false (and does nothing) when an item with
   * the same key is already pending — an in-queue dedupe so gate churn can't
   * multiply one notification. Kicks the pump if a session is attached; without
   * one the item simply waits (rule 2 — never dropped).
   */
  enqueue(item: ChatDeliveryItem): boolean;
  /**
   * Point the pump at the current Dispatcher session (or null when the chat
   * PTY died with no replacement yet). A change mid-pump aborts the in-flight
   * chain — the head item stays queued and is fully re-typed into the new
   * session — and a new session immediately drains whatever is waiting.
   */
  attachSession(sessionId: string | null): void;
  /** Start pumping if idle, a session is attached, and the queue is non-empty. */
  kick(): void;
  /** Drop everything (project switch / dispatcher dismissal). */
  reset(): void;
  /** How many items are still awaiting delivery. */
  pending(): number;
}

export function createDispatcherPump(effects: DispatcherPumpEffects): DispatcherPump {
  const scheduler = effects.scheduler ?? defaultScheduler;
  const now = effects.now ?? ((): number => Date.now());
  const onDelivery = effects.onDelivery ?? ((): void => undefined);

  const queue: ChatDeliveryItem[] = [];
  let session: string | null = null;
  let pumping = false;
  /**
   * Chain token: every scheduled continuation captures the token current when
   * it was scheduled and no-ops if it has moved on — so an aborted/superseded
   * chain can never act on the queue or write to a stale session.
   */
  let chainToken = 0;
  let lastProgressAt = 0;
  let watchdogHandle: unknown = null;

  /** Abort any in-flight chain; the head item (if mid-delivery) stays queued. */
  function abortChain(reason: 'requeued'): void {
    const midItem = pumping && queue.length > 0;
    chainToken++;
    pumping = false;
    if (midItem) onDelivery(queue[0].key, reason);
  }

  function ensureWatchdog(): void {
    if (watchdogHandle !== null) return;
    watchdogHandle = scheduler.schedule(watchdogTick, PUMP_WATCHDOG_MS);
  }

  function watchdogTick(): void {
    watchdogHandle = null;
    if (queue.length === 0) return; // nothing to guard; stop ticking
    if (session !== null) {
      const stalledChain = pumping && now() - lastProgressAt > PUMP_STALL_MS;
      if (stalledChain) {
        // A chain that claims to be pumping but has made no progress is dead
        // (its continuation was lost). Restart against the current session.
        chainToken++;
        pumping = false;
      }
      kick();
    }
    ensureWatchdog(); // keep ticking while items wait
  }

  function kick(): void {
    if (pumping || session === null || queue.length === 0) return;
    pumping = true;
    lastProgressAt = now();
    nextItem(chainToken, session);
  }

  /**
   * Deliver the head item, then recurse. `token`/`sess` pin this chain to the
   * session it started against: any step that finds them stale simply stops —
   * the abort/attach path has already handled requeueing and restarting.
   */
  function nextItem(token: number, sess: string): void {
    if (token !== chainToken || sess !== session) return; // superseded
    if (queue.length === 0) {
      pumping = false;
      return;
    }
    if (!effects.canFlush(now())) {
      // Defer-while-typing hold (issue 48): re-check shortly; the item is NOT
      // consumed while held. Progress is touched so the watchdog knows this is
      // a legitimate hold, not a dead chain.
      lastProgressAt = now();
      scheduler.schedule(() => nextItem(token, sess), PUMP_TYPING_RECHECK_MS);
      return;
    }
    const item = queue[0]; // PEEK — removed only after its final write lands
    const steps =
      item.submit === false ? buildTypeOnlySequence(item.text) : buildSubmitSequence(item.text);
    let i = 0;
    const runStep = (): void => {
      if (token !== chainToken || sess !== session) return; // superseded mid-item
      if (i >= steps.length) {
        nextItem(token, sess);
        return;
      }
      const step = steps[i];
      try {
        effects.write(sess, step.data);
      } catch (err) {
        // Rule 1: a write failure must not strand the queue. Reset the pump
        // state (the item stays at the head) and let the watchdog retry
        // against whatever session is current by then.
        pumping = false;
        chainToken++;
        onDelivery(item.key, 'write-failed', err instanceof Error ? err.message : String(err));
        ensureWatchdog();
        return;
      }
      i++;
      lastProgressAt = now();
      if (i === 1) onDelivery(item.key, 'typed');
      if (i === steps.length) {
        // The final write landed in a still-current session: the item is
        // delivered. Consume it NOW — before the settle wait — so a session
        // change during the settle can't requeue (and double-deliver) it.
        // A type-only item's delivery IS its `typed` phase (already reported);
        // only a really-submitted item reports `submitted`.
        queue.shift();
        if (item.submit !== false) onDelivery(item.key, 'submitted');
      }
      scheduler.schedule(runStep, step.settleMs);
    };
    runStep();
  }

  return {
    enqueue(item: ChatDeliveryItem): boolean {
      if (queue.some((q) => q.key === item.key)) return false;
      queue.push(item);
      onDelivery(item.key, 'queued');
      ensureWatchdog();
      kick();
      return true;
    },

    attachSession(sessionId: string | null): void {
      if (sessionId === session) return;
      abortChain('requeued');
      session = sessionId;
      if (queue.length > 0) ensureWatchdog();
      kick();
    },

    kick,

    reset(): void {
      queue.length = 0;
      chainToken++;
      pumping = false;
      session = null;
      if (watchdogHandle !== null) {
        scheduler.cancel(watchdogHandle);
        watchdogHandle = null;
      }
    },

    pending(): number {
      return queue.length;
    },
  };
}
