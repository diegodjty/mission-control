/**
 * Dispatcher channel routing + defer-while-typing gate (PURE) — issue 48, ADR-0012.
 *
 * ADR-0012 fixes the "prompt over prompt" racing by splitting what the Dispatcher
 * surfaces into TWO channels:
 *
 *   - the **chat** PTY — the one interactive `claude` session the user talks to.
 *     It carries ONLY the things that are genuinely conversational: the
 *     three-item blocking-approval prompts (merge-conflict, abort-drain,
 *     hitl-signoff) and the user's own questions + the Dispatcher's answers.
 *   - the ambient **log** — the bounded activity list beside the chat (issue 44's
 *     resolved-log area). Every ROUTINE PASSIVE fact goes here as a quiet line
 *     (committed / merged-clean / done / issue-logged, a status refresh, a
 *     doc-drift finding, a cross-Run overlap note) — NOT typed into the chat.
 *
 * Routing reuses the one tested authority line (`dispatcher-authority`): a
 * `blocking` action is a chat prompt; anything `passive`/`silent` is a log note.
 * So "which channel does this event use?" is a pure function of its action — no
 * second boundary to keep in sync.
 *
 * The second half of the ADR is the **defer-while-typing gate**: even the
 * remaining chat writes (the blocking prompts) must never interleave with the
 * user's keystrokes. The gate tracks the user's compose state from the chat
 * PTY's input stream and tells the serialized submit queue when it is safe to
 * flush — never while the user is mid-compose, only once the input line is idle.
 *
 * PURE: no I/O, no Electron, no timers, no LLM. Unit-testable in isolation and
 * safe to share across main/renderer.
 */
import { classifyAuthority, type Authority, type DispatcherAction } from './dispatcher-authority';

/** The two channels the Dispatcher surfaces through (ADR-0012). */
export type DispatcherChannel = 'chat' | 'log';

/**
 * Route an authority tier to its channel: a `blocking` action is a
 * conversational prompt that belongs in the chat PTY; a `passive`/`silent` fact
 * is an ambient note that belongs in the log. This is the whole routing rule.
 */
export function channelForAuthority(authority: Authority): DispatcherChannel {
  return authority === 'blocking' ? 'chat' : 'log';
}

/** Route a Dispatcher action to its channel, via the authority classifier. */
export function channelForAction(action: DispatcherAction): DispatcherChannel {
  return channelForAuthority(classifyAuthority(action));
}

/** True when an event with this action is typed into the chat PTY. */
export function usesChat(action: DispatcherAction): boolean {
  return channelForAction(action) === 'chat';
}

/** True when an event with this action becomes a quiet line in the ambient log. */
export function usesLog(action: DispatcherAction): boolean {
  return channelForAction(action) === 'log';
}

// --- Defer-while-typing gate --------------------------------------------------

/**
 * The user's compose state on the chat input line, folded from the PTY input
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

// --- On-demand status-injection trigger (issue 52) ----------------------------

/**
 * Decide, from one chunk of the user's chat input, whether it is a moment to
 * inject the current ground-truth status snapshot (issue 52). The trigger is the
 * user SENDING a composed message: a submit (`\r`/`\n`) that ends a line the user
 * had actually been composing (`prev.composing`). This deliberately does NOT fire
 * on:
 *   - a bare Enter on an empty prompt (nothing was composed → `prev.composing`
 *     is false), so idle Enters don't spam injections;
 *   - an ordinary keystroke mid-compose (not a submit); or
 *   - a line-clear (Ctrl-C / Ctrl-U), which abandons the line rather than sends it.
 *
 * `prev` is the compose state as it stood BEFORE this chunk is folded in (so the
 * caller must consult it before calling `reduceTyping`). Pure — no I/O, no clock.
 */
export function isStatusInjectionTrigger(prev: TypingState, data: string): boolean {
  return prev.composing && isSubmitInput(data);
}
