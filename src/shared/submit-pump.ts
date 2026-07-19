/**
 * Submit-pump (issue 60) — the unstallable delivery queue for everything typed
 * into a chat-tier PTY (Planning, Just-talk, and historically the Dispatcher).
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
import { buildSubmitSequence, buildTypeOnlySequence } from './submit-sequence';

// --- Defer-while-typing gate (ADR-0012) --------------------------------------
// Shared by every chat-tier PTY this pump feeds (Planning, Just-talk, and
// historically the Dispatcher): the user's compose state on a chat input line,
// folded from that PTY's input stream, and the gate that tells this pump when
// it may flush a programmatic write without interleaving with the user's own
// keystrokes ("prompt over prompt").

/**
 * The user's compose state on a chat input line, folded from the PTY input
 * stream. `composing` is true while the user has un-submitted characters on the
 * line; `lastInputAt` is the timestamp (ms) of their last keystroke, used to
 * require a short idle window even after a submit so a programmatic write never
 * lands on the heels of the user's own message.
 */
export interface TypingState {
  composing: boolean;
  lastInputAt: number;
}

/**
 * The starting state: nothing on the line, and a `lastInputAt` far enough in the
 * past that the queue may flush immediately (no artificial hold before the user
 * has typed anything).
 */
export const INITIAL_TYPING_STATE: TypingState = { composing: false, lastInputAt: 0 };

/**
 * How long the input line must be idle (no keystroke) before a programmatic
 * write may flush, once the line is not mid-compose. Keeps an injection from
 * landing immediately after the user's Enter, while staying short enough that a
 * blocking prompt isn't delayed noticeably.
 */
export const CHAT_IDLE_MS = 800;

/**
 * How long a compose state may sit idle (no further compose-relevant input)
 * before it is considered ABANDONED and stops blocking the flush (issue 68).
 * Without decay, one un-submitted keystroke dams every queued chat message
 * until the user's next Enter releases them all in a burst. By this much idle
 * the user has walked away from the line — and the claude TUI queues typed-
 * ahead text safely anyway, so the interleave risk the gate protects against
 * is gone. A submit or line-clear still releases immediately.
 */
export const COMPOSE_DECAY_MS = 15_000;

/**
 * Terminal input chunks that are NOT the user typing (issue 68): focus in/out
 * reports (`CSI I` / `CSI O` — emitted when the user merely clicks into or out
 * of the pane), mouse reports (SGR `CSI < … M/m` and legacy `CSI M` + 3 bytes —
 * emitted by clicks and scroll wheels), bracketed-paste guard markers
 * (`CSI 200~` / `CSI 201~`), and bare terminal replies (cursor-position report
 * `CSI … R`, device-attributes reply `CSI ? … c`). Deliberately NOT matched:
 * arrow keys / Home / End (`CSI A`–`D`, `H`, `F`) and editing keys like Delete
 * (`CSI 3~`) — those manipulate the input line, so they still count as typing.
 */
const NON_COMPOSE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[(?:I|O|<[0-9;]*[Mm]|M[\s\S]{3}|20[01]~|[0-9;]*R|\?[0-9;]*c)/g;

/**
 * Is this chunk made up ENTIRELY of non-compose terminal sequences (focus /
 * mouse / paste-guard / reply escapes)? Such a chunk carries no typing at all —
 * the user clicked or scrolled, or the terminal answered a query — so it must
 * never arm the defer-while-typing gate. A chunk with any other content (a
 * printable character, an editing key, a paste's actual text) is compose input
 * and takes the normal `reduceTyping` path.
 */
export function isNonComposeInput(data: string): boolean {
  return data.length > 0 && data.replace(NON_COMPOSE_SEQUENCE, '') === '';
}

/** Does this input chunk SUBMIT the current line (Enter / carriage return)? */
export function isSubmitInput(data: string): boolean {
  return data.endsWith('\r') || data.endsWith('\n');
}

/**
 * Does this input chunk CLEAR the compose line without submitting it — Ctrl-C
 * (`\x03`, interrupt) or Ctrl-U (`\x15`, kill-line)? Either empties the input,
 * so the user is no longer mid-compose.
 */
export function isLineClearInput(data: string): boolean {
  return data.includes('\x03') || data.includes('\x15');
}

/**
 * Fold one chunk of user input into the compose state. A submit or a line-clear
 * ends the compose (the line no longer holds pending characters); any other
 * keystroke means the user is actively composing. Empty input is a no-op.
 * `now` is the caller's clock (ms) — the function stays pure.
 *
 * Non-compose chunks (issue 68) — focus reports, mouse reports, paste guards,
 * bare terminal replies — are a no-op too: they neither set `composing` (a
 * click is not typing) nor bump `lastInputAt` (`lastInputAt` exists to keep a
 * programmatic write off the heels of a real keystroke; a scroll puts nothing
 * on the line, and counting it would let continuous scrolling postpone flushes
 * — and the compose decay — indefinitely).
 */
export function reduceTyping(state: TypingState, data: string, now: number): TypingState {
  if (data.length === 0) return state;
  if (isNonComposeInput(data)) return state;
  if (isSubmitInput(data) || isLineClearInput(data)) {
    return { composing: false, lastInputAt: now };
  }
  return { composing: true, lastInputAt: now };
}

/**
 * May the serialized submit queue flush a programmatic chat write right now?
 * Only when the user is NOT mid-compose AND the input line has been idle for at
 * least `idleMs`. While the user is typing (or just submitted), this returns
 * false and the queue holds — so the app never interleaves with the user's line
 * ("prompt over prompt" gone).
 *
 * A compose state DECAYS (issue 68): once the line has sat idle past `decayMs`
 * the user has abandoned it, and the hold lifts — otherwise one un-submitted
 * keystroke would dam the queue forever. Fresh typing re-arms the hold; a
 * submit or line-clear still releases immediately (via `reduceTyping`).
 */
export function canFlushChat(
  state: TypingState,
  now: number,
  idleMs: number = CHAT_IDLE_MS,
  decayMs: number = COMPOSE_DECAY_MS,
): boolean {
  const composeHolds = state.composing && now - state.lastInputAt < decayMs;
  if (composeHolds) return false;
  return now - state.lastInputAt >= idleMs;
}

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
export interface SubmitPumpEffects {
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

export interface SubmitPump {
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

export function createSubmitPump(effects: SubmitPumpEffects): SubmitPump {
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
