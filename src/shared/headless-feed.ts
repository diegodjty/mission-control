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

// --- Minimal Feed state (issue 139 AC2 — status + elapsed only) --------------

/** The Feed's coarse liveness. Richer activity/last-message state is a later issue. */
export type FeedStatus = 'starting' | 'running' | 'exited';

export interface FeedState {
  status: FeedStatus;
  /** Milliseconds since the child process started (0 before it has). */
  elapsedMs: number;
  /** The captured claude session id, or null before the init event arrived. */
  sessionId: string | null;
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
}

/**
 * Derive the minimal Feed state from observable facts. `starting` before the
 * process has a start time, `running` while it is alive, `exited` once closed.
 * Elapsed is clamped at 0 so a backward clock skew never shows negative time.
 */
export function deriveFeedState(facts: FeedFacts): FeedState {
  const elapsedMs =
    facts.startedAt === null ? 0 : Math.max(0, facts.now - facts.startedAt);
  const status: FeedStatus = facts.exited
    ? 'exited'
    : facts.startedAt === null
      ? 'starting'
      : 'running';
  return { status, elapsedMs, sessionId: facts.sessionId };
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
