/**
 * Headless Feed model (issue 139, ADR-0001 amendment) — the PURE core of a
 * headless drain Run's watch surface.
 *
 * A drain Run executes `claude -p --output-format stream-json --verbose` as a
 * plain child process (no pty). Its stdout is newline-delimited JSON — one event
 * object per line, each carrying a `session_id` (the first line is the
 * `system`/`init` event). This module turns that raw byte stream into:
 *   - the claude **session id**, captured for resume/take-over and persisted on
 *     the Run (issue 139 AC3), and
 *   - the minimal **Feed** state the Run slot renders — status + elapsed (AC2).
 *
 * It is NEVER a capture input (ADR-0013: Receipts remain the sole capture; this
 * stream is peek/debug, plus the session id and liveness, only — the raw tail is
 * buffered by the adapter but never parsed into a Completion record).
 *
 * Pure and deterministic (no I/O, no timers, no Electron): the child-process
 * adapter feeds it bytes and supplies the clock, so the parse and the state
 * derivation are unit-testable in isolation. It tolerates partial lines split
 * across chunks, `\r\n` endings, and malformed / non-JSON lines (a boot banner,
 * a blank line) without throwing.
 */

/** The stream-json event `type`s we care about; anything else collapses to `other`. */
export type HeadlessEventType = 'system' | 'assistant' | 'user' | 'result' | 'other';

const KNOWN_TYPES: ReadonlySet<string> = new Set(['system', 'assistant', 'user', 'result']);

export interface HeadlessEvent {
  /** The event's `type`, normalized; unknown/absent types collapse to `other`. */
  type: HeadlessEventType;
  /** The `session_id` this event declared, or null when it carried none. */
  sessionId: string | null;
  /** The parsed object for downstream consumers (telemetry lands here later). */
  data: Record<string, unknown>;
}

/**
 * Parse ONE line of stream-json into a typed event. Returns null for a blank
 * line, non-JSON text (a boot banner), or a JSON value that is not an object —
 * none of those are stream events. Never throws.
 */
export function parseHeadlessLine(line: string): HeadlessEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawType = typeof obj.type === 'string' ? obj.type : '';
  const type: HeadlessEventType = KNOWN_TYPES.has(rawType)
    ? (rawType as HeadlessEventType)
    : 'other';
  const sessionId = typeof obj.session_id === 'string' && obj.session_id !== '' ? obj.session_id : null;
  return { type, sessionId, data: obj };
}

/**
 * A stateful line-buffering parser: push raw stdout chunks, get back the events
 * completed by each chunk. It line-buffers across chunk boundaries (a JSON
 * object may be split mid-line) and captures the first `session_id` it sees —
 * the claude session id the Run is identified by for resume/take-over.
 */
export interface HeadlessStreamParser {
  /** Feed a raw stdout chunk; returns the whole-line events it completed. */
  push(chunk: string): HeadlessEvent[];
  /** Emit any trailing partial line at end-of-stream (usually none). */
  flush(): HeadlessEvent[];
  /** The claude session id captured so far (the FIRST one seen), or null. */
  sessionId(): string | null;
}

export function createHeadlessStreamParser(): HeadlessStreamParser {
  let buffer = '';
  let captured: string | null = null;

  const drain = (line: string, out: HeadlessEvent[]): void => {
    const ev = parseHeadlessLine(line);
    if (ev === null) return;
    if (captured === null && ev.sessionId !== null) captured = ev.sessionId;
    out.push(ev);
  };

  return {
    push(chunk: string): HeadlessEvent[] {
      buffer += chunk;
      const out: HeadlessEvent[] = [];
      let nl: number;
      // Split on \n; strip a trailing \r so \r\n endings parse cleanly.
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        drain(raw.endsWith('\r') ? raw.slice(0, -1) : raw, out);
      }
      return out;
    },
    flush(): HeadlessEvent[] {
      const out: HeadlessEvent[] = [];
      if (buffer !== '') {
        const raw = buffer;
        buffer = '';
        drain(raw.endsWith('\r') ? raw.slice(0, -1) : raw, out);
      }
      return out;
    },
    sessionId(): string | null {
      return captured;
    },
  };
}

/** The first declared session id among the given events, or null if none. */
export function sessionIdFrom(events: readonly HeadlessEvent[]): string | null {
  for (const ev of events) {
    if (ev.sessionId !== null) return ev.sessionId;
  }
  return null;
}

// --- Feed content: activity, last message, terminal result (issue 140) -------
// The minimal Feed (issue 139) tracked liveness only. Issue 140 folds the event
// stream into human-readable CONTENT — a derived activity line, the last
// assistant message, and the terminal result (its usage payload kept intact for
// issue 143) — so the renderer consumes Feed state ALONE and never parses an
// event itself. The fold is pure and TOTAL: a malformed, partial, or unexpected
// event leaves the running content unchanged (a stale activity line, never a
// crash — the issue's degrade-gracefully requirement).

/**
 * The terminal `result` event, normalized. `usage` is passed through VERBATIM
 * (issue 143 — telemetry — consumes it), and `raw` keeps the whole event object
 * so a downstream read (num_turns, total_cost_usd) needs no second parse.
 */
export interface TerminalResult {
  /** The result `subtype` (e.g. `success`, `error_max_turns`), or null. */
  subtype: string | null;
  /** The `is_error` flag (false unless the event set it true). */
  isError: boolean;
  /** The final result text claude emitted, or null. */
  text: string | null;
  /** The `usage` payload, VERBATIM — issue 143 consumes it. Null when absent. */
  usage: Record<string, unknown> | null;
  /** The whole result event object, for any downstream field (issue 143). */
  raw: Record<string, unknown>;
}

/** An activity line derived from a tool event, plus the tool behind it. */
export interface FeedActivity {
  /** Human-readable line, e.g. `running npm test`, `editing App.tsx`. */
  text: string;
  /** The tool name that produced it (for iconography). */
  tool: string;
}

/**
 * The human-readable content the Feed shows, folded from the event stream. Each
 * field is null until an event supplies it and then survives (stays "stale")
 * until a later event replaces it — a tool-only assistant turn never blanks the
 * last prose message, and a quiet stretch never blanks the activity line.
 */
export interface FeedContent {
  /** The most recent activity line from a tool event, or null. */
  activity: string | null;
  /** The tool behind `activity` (for iconography), or null. */
  activityTool: string | null;
  /** The last assistant prose message, or null. */
  lastMessage: string | null;
  /** The terminal result once the `result` event arrived, else null. */
  result: TerminalResult | null;
}

/** The zero value — the content before any event has been folded in. */
export const EMPTY_FEED_CONTENT: FeedContent = {
  activity: null,
  activityTool: null,
  lastMessage: null,
  result: null,
};

/** A non-empty trimmed string, or null (tolerates any non-string input). */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Last path segment, without importing node `path` (this module is shared). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Clip a line to `max` chars with an ellipsis, so an activity line stays short. */
function clip(text: string, max = 48): string {
  const oneLine = text.split('\n')[0];
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** The host of a URL, or the whole string when it doesn't look like one. */
function hostOf(url: string): string {
  const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return match ? match[1] : url;
}

/**
 * The `message.content` blocks of an event, as an array. A string `content`
 * (an older/simple shape) is lifted to a single text block; a missing or
 * non-array/non-string content yields `[]`. Never throws.
 */
function contentBlocks(event: HeadlessEvent): Record<string, unknown>[] {
  const message = event.data.message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => b !== null && typeof b === 'object' && !Array.isArray(b),
  );
}

/**
 * The concatenated `text` blocks of an assistant message, trimmed — the prose
 * the human reads as "the last assistant message". Null when the turn carried
 * no text (e.g. a tool-only turn), so it never blanks the previous message.
 */
export function assistantText(event: HeadlessEvent): string | null {
  const parts: string[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return nonEmptyString(parts.join(''));
}

/** Map one tool call (name + input) to a short human-readable activity line. */
function activityPhrase(tool: string, input: Record<string, unknown>): string {
  const file =
    nonEmptyString(input.file_path) ??
    nonEmptyString(input.notebook_path) ??
    nonEmptyString(input.path);
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file ? `editing ${basename(file)}` : 'editing a file';
    case 'Read':
      return file ? `reading ${basename(file)}` : 'reading a file';
    case 'Bash': {
      const command = nonEmptyString(input.command);
      if (command) return `running ${clip(command)}`;
      const description = nonEmptyString(input.description);
      return description ? `running ${clip(description)}` : 'running a command';
    }
    case 'Grep': {
      const pattern = nonEmptyString(input.pattern);
      return pattern ? `searching for ${clip(pattern, 32)}` : 'searching the code';
    }
    case 'Glob':
      return 'finding files';
    case 'Task':
    case 'Agent': {
      const description = nonEmptyString(input.description);
      return description ? `delegating: ${clip(description)}` : 'delegating to a subagent';
    }
    case 'WebFetch': {
      const url = nonEmptyString(input.url);
      return url ? `fetching ${clip(hostOf(url), 40)}` : 'fetching a page';
    }
    case 'WebSearch':
      return 'searching the web';
    case 'TodoWrite':
      return 'updating the plan';
    default:
      return `using ${tool}`;
  }
}

/**
 * Derive the activity line from an assistant event's tool calls: the LAST
 * `tool_use` block wins (the most recent action). Null when the event carried
 * no tool call, so a plain chat turn leaves the activity line stale rather than
 * clearing it. Never throws on a malformed block or input.
 */
export function deriveActivity(event: HeadlessEvent): FeedActivity | null {
  let last: Record<string, unknown> | null = null;
  for (const block of contentBlocks(event)) {
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== '') {
      last = block;
    }
  }
  if (last === null) return null;
  const tool = last.name as string;
  const input =
    last.input !== null && typeof last.input === 'object' && !Array.isArray(last.input)
      ? (last.input as Record<string, unknown>)
      : {};
  return { text: activityPhrase(tool, input), tool };
}

/**
 * Extract the terminal result from a `result` event, `usage` intact. Null for
 * any non-result event. Never throws — absent/odd fields degrade to null/false.
 */
export function extractResult(event: HeadlessEvent): TerminalResult | null {
  if (event.type !== 'result') return null;
  const data = event.data;
  const usage =
    data.usage !== null && typeof data.usage === 'object' && !Array.isArray(data.usage)
      ? (data.usage as Record<string, unknown>)
      : null;
  return {
    subtype: typeof data.subtype === 'string' ? data.subtype : null,
    isError: data.is_error === true,
    text: typeof data.result === 'string' ? data.result : null,
    usage,
    raw: data,
  };
}

/**
 * Fold ONE event into the running Feed content. Pure and total: an assistant
 * event updates the last message and/or the activity line; a result event sets
 * the terminal result; every other (or malformed) event returns `prev`
 * UNCHANGED — same reference, so a caller can cheaply detect "no change".
 */
export function reduceFeedContent(prev: FeedContent, event: HeadlessEvent): FeedContent {
  switch (event.type) {
    case 'assistant': {
      const text = assistantText(event);
      const activity = deriveActivity(event);
      if (text === null && activity === null) return prev;
      return {
        activity: activity ? activity.text : prev.activity,
        activityTool: activity ? activity.tool : prev.activityTool,
        lastMessage: text ?? prev.lastMessage,
        result: prev.result,
      };
    }
    case 'result': {
      const result = extractResult(event);
      return result === null ? prev : { ...prev, result };
    }
    default:
      return prev;
  }
}

/** Fold a whole sequence of events into content (starting from `prev`). */
export function reduceFeedContentAll(
  events: readonly HeadlessEvent[],
  prev: FeedContent = EMPTY_FEED_CONTENT,
): FeedContent {
  let acc = prev;
  for (const event of events) acc = reduceFeedContent(acc, event);
  return acc;
}

// --- Feed state: liveness (issue 139) + content (issue 140) ------------------

/** The Feed's coarse liveness. */
export type FeedStatus = 'starting' | 'running' | 'exited';

export interface FeedState {
  status: FeedStatus;
  /** Milliseconds since the child process started (0 before it has). */
  elapsedMs: number;
  /** The captured claude session id, or null before the init event arrived. */
  sessionId: string | null;
  /** The current activity line (issue 140), or null before any tool event. */
  activity: string | null;
  /** The tool behind the activity line (issue 140), or null. */
  activityTool: string | null;
  /** The last assistant prose message (issue 140), or null. */
  lastMessage: string | null;
  /** The terminal result once seen (issue 140; usage for issue 143), else null. */
  result: TerminalResult | null;
}

export interface FeedFacts {
  /** Epoch ms the child process started, or null before it has spawned. */
  startedAt: number | null;
  /** The current clock (epoch ms) — supplied by the caller, never read here. */
  now: number;
  /** True once the child process has closed. */
  exited: boolean;
  /** The captured claude session id, or null. */
  sessionId: string | null;
  /**
   * The folded event content (issue 140). Omitted ⇒ empty content — the Feed
   * shows liveness only, exactly as the issue-139 minimal strip did.
   */
  content?: FeedContent;
}

/**
 * Derive the full Feed state from observable facts: liveness (`starting` before
 * a start time, `running` while alive, `exited` once closed; elapsed clamped at
 * 0 so a backward clock skew never shows negative time) plus the folded content
 * (activity line, last message, terminal result) the renderer displays.
 */
export function deriveFeedState(facts: FeedFacts): FeedState {
  const elapsedMs =
    facts.startedAt === null ? 0 : Math.max(0, facts.now - facts.startedAt);
  const status: FeedStatus = facts.exited
    ? 'exited'
    : facts.startedAt === null
      ? 'starting'
      : 'running';
  const content = facts.content ?? EMPTY_FEED_CONTENT;
  return {
    status,
    elapsedMs,
    sessionId: facts.sessionId,
    activity: content.activity,
    activityTool: content.activityTool,
    lastMessage: content.lastMessage,
    result: content.result,
  };
}

/**
 * Format an elapsed duration for the Feed strip: `m:ss` under an hour,
 * `h:mm:ss` at or above one. Negative input clamps to `0:00`.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}
