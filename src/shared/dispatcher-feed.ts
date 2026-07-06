/**
 * Dispatcher feed submit-sequence builder (PURE).
 *
 * A Completion block fed to the Dispatcher must be **submitted**, not merely
 * typed. The bug this module fixes (issue 41): the feed used to send the block
 * text and its trailing `\r` in ONE PTY write (`` `${text}\r` ``). Under the
 * claude TUI's bracketed-paste input handling, a chunk that arrives all at once
 * is treated as pasted text, so the trailing `\r` lands in the input box as a
 * literal newline rather than an Enter keypress — the block sits there unsent
 * and the Dispatcher never narrates.
 *
 * The fix is a two-step sequence per message: TYPE the (flattened) text, let the
 * input settle, then SUBMIT with a SEPARATE `\r` write. Because the submit is a
 * distinct write arriving after the paste has settled, the TUI sees it as a real
 * Enter and submits. When several blocks arrive close together (a parallel
 * drain), the batch builder keeps each message's text and its own submit as
 * DISTINCT writes in order, so two blocks are never concatenated into one input.
 *
 * PURE: no I/O, no Electron, no timers. The caller (App.tsx) walks the returned
 * steps, issuing one `writePty` per step and honouring each step's `settleMs`
 * between writes. Unit-testable in isolation.
 */

/** The byte that submits the claude TUI input line (Enter / carriage return). */
export const SUBMIT_KEY = '\r';

/** Wait after TYPING a block before pressing Enter, so the paste settles (ms). */
export const TYPE_SETTLE_MS = 150;

/**
 * Wait after SUBMITTING before the next block's text is typed (ms). Keeps two
 * blocks arriving close together from merging: the input line must clear and the
 * TUI accept the message before the next one starts typing.
 */
export const SUBMIT_SETTLE_MS = 350;

/** One PTY write plus how long to wait after it before the next step. */
export interface PtyWriteStep {
  /** Bytes to write to the PTY session. */
  data: string;
  /** Milliseconds to wait AFTER this write before issuing the next step. */
  settleMs: number;
}

/**
 * Flatten a (possibly multi-line) message to a single line, so its body carries
 * no `\r`/`\n` that the TUI could interpret as a premature submit. Newlines
 * become ` · ` separators; the result is trimmed. This is the ONLY text
 * transform — content is otherwise untouched.
 */
export function flattenMessage(message: string): string {
  return message.trim().replace(/\s*[\r\n]+\s*/g, ' · ');
}

/**
 * Build the ordered PTY writes that TYPE one message and then SUBMIT it as a
 * SEPARATE write. Always exactly two steps: the flattened text (which never
 * contains a bare `\r`), then the submit key on its own. The submit is a
 * distinct step precisely so it is not absorbed into the pasted text.
 */
export function buildSubmitSequence(message: string): PtyWriteStep[] {
  return [
    { data: flattenMessage(message), settleMs: TYPE_SETTLE_MS },
    { data: SUBMIT_KEY, settleMs: SUBMIT_SETTLE_MS },
  ];
}

/**
 * Build one flat step list for several messages fed back-to-back (parallel
 * drain). Each message keeps its own type-then-submit pair, in order, so the
 * messages stay DISTINCT — a block is never concatenated onto another's input
 * line, and each gets its own Enter.
 */
export function buildSubmitBatch(messages: string[]): PtyWriteStep[] {
  return messages.flatMap(buildSubmitSequence);
}

/**
 * Build the single PTY write that TYPES a prefix WITHOUT submitting it (issue
 * 91): the user finishes the line and presses Enter themselves — e.g. the
 * Planning view's Grill button typing `/grill-with-docs ` so the user can add
 * the topic. Unlike `flattenMessage` this does NOT trim (the trailing space is
 * part of the prefix contract), but any CR/LF is stripped so a prefix can
 * never self-submit.
 */
export function buildTypeOnlySequence(prefix: string): PtyWriteStep[] {
  return [{ data: prefix.replace(/[\r\n]+/g, ''), settleMs: TYPE_SETTLE_MS }];
}
