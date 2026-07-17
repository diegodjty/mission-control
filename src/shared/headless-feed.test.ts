import { describe, it, expect } from 'vitest';
import {
  parseHeadlessLine,
  createHeadlessStreamParser,
  sessionIdFrom,
  deriveFeedState,
  formatElapsed,
} from './headless-feed';

// A representative `claude -p --output-format stream-json` init event: one JSON
// object per line, the session id declared on the leading system/init event.
const INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"sess-abc123","cwd":"/repos/app","tools":[]}';
const ASSISTANT_LINE =
  '{"type":"assistant","session_id":"sess-abc123","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}';
const RESULT_LINE =
  '{"type":"result","subtype":"success","session_id":"sess-abc123","is_error":false,"num_turns":3,"usage":{"input_tokens":10,"output_tokens":5}}';

describe('parseHeadlessLine', () => {
  it('parses a system/init line into a typed event carrying the session id', () => {
    const ev = parseHeadlessLine(INIT_LINE);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('system');
    expect(ev!.sessionId).toBe('sess-abc123');
  });

  it('normalizes known types and collapses unknown ones to "other"', () => {
    expect(parseHeadlessLine(ASSISTANT_LINE)!.type).toBe('assistant');
    expect(parseHeadlessLine(RESULT_LINE)!.type).toBe('result');
    expect(parseHeadlessLine('{"type":"tool_use","session_id":"x"}')!.type).toBe('other');
  });

  it('returns null for a blank line or non-JSON banner text (never throws)', () => {
    expect(parseHeadlessLine('')).toBeNull();
    expect(parseHeadlessLine('   ')).toBeNull();
    expect(parseHeadlessLine('Welcome to Claude Code!')).toBeNull();
    expect(parseHeadlessLine('{ not json')).toBeNull();
    // A JSON value that isn't an object is not an event.
    expect(parseHeadlessLine('42')).toBeNull();
    expect(parseHeadlessLine('null')).toBeNull();
  });

  it('carries a null session id when the event declares none', () => {
    const ev = parseHeadlessLine('{"type":"assistant","message":{}}');
    expect(ev).not.toBeNull();
    expect(ev!.sessionId).toBeNull();
  });
});

describe('createHeadlessStreamParser', () => {
  it('emits one event per newline-delimited line as chunks arrive', () => {
    const p = createHeadlessStreamParser();
    const events = p.push(`${INIT_LINE}\n${ASSISTANT_LINE}\n`);
    expect(events.map((e) => e.type)).toEqual(['system', 'assistant']);
  });

  it('buffers a partial line split across chunks and completes it on the newline', () => {
    const p = createHeadlessStreamParser();
    const head = INIT_LINE.slice(0, 20);
    const tail = INIT_LINE.slice(20);
    expect(p.push(head)).toEqual([]); // no newline yet → nothing complete
    const events = p.push(`${tail}\n`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect(events[0].sessionId).toBe('sess-abc123');
  });

  it('captures the session id once and exposes it via sessionId()', () => {
    const p = createHeadlessStreamParser();
    expect(p.sessionId()).toBeNull();
    p.push(`${INIT_LINE}\n`);
    expect(p.sessionId()).toBe('sess-abc123');
    // A later event with a different id does not overwrite the first capture.
    p.push('{"type":"assistant","session_id":"sess-OTHER"}\n');
    expect(p.sessionId()).toBe('sess-abc123');
  });

  it('skips blank and malformed lines without throwing, still capturing the id', () => {
    const p = createHeadlessStreamParser();
    const events = p.push(`\nboot banner\n${INIT_LINE}\n{ broken\n`);
    // Only the well-formed init line is a real event.
    expect(events.map((e) => e.type)).toEqual(['system']);
    expect(p.sessionId()).toBe('sess-abc123');
  });

  it('flush() completes a trailing line that had no terminating newline', () => {
    const p = createHeadlessStreamParser();
    expect(p.push(INIT_LINE)).toEqual([]); // no trailing newline
    const flushed = p.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].sessionId).toBe('sess-abc123');
    expect(p.sessionId()).toBe('sess-abc123');
  });

  it('handles \\r\\n line endings', () => {
    const p = createHeadlessStreamParser();
    const events = p.push(`${INIT_LINE}\r\n${RESULT_LINE}\r\n`);
    expect(events.map((e) => e.type)).toEqual(['system', 'result']);
    expect(events[0].sessionId).toBe('sess-abc123');
  });
});

describe('sessionIdFrom', () => {
  it('returns the first declared session id among events, else null', () => {
    const p = createHeadlessStreamParser();
    const events = p.push(`${ASSISTANT_LINE}\n${INIT_LINE}\n`);
    expect(sessionIdFrom(events)).toBe('sess-abc123');
    expect(sessionIdFrom([])).toBeNull();
    expect(sessionIdFrom(p.push('{"type":"assistant","message":{}}\n'))).toBeNull();
  });
});

describe('deriveFeedState (minimal Feed — status + elapsed, AC2)', () => {
  it('reads "starting" before the process has a start time', () => {
    const s = deriveFeedState({ startedAt: null, now: 1000, exited: false, sessionId: null });
    expect(s.status).toBe('starting');
    expect(s.elapsedMs).toBe(0);
    expect(s.sessionId).toBeNull();
  });

  it('reads "running" with a live elapsed once started', () => {
    const s = deriveFeedState({ startedAt: 1000, now: 6000, exited: false, sessionId: 'sess-x' });
    expect(s.status).toBe('running');
    expect(s.elapsedMs).toBe(5000);
    expect(s.sessionId).toBe('sess-x');
  });

  it('reads "exited" once the process has closed', () => {
    const s = deriveFeedState({ startedAt: 1000, now: 9000, exited: true, sessionId: 'sess-x' });
    expect(s.status).toBe('exited');
    expect(s.elapsedMs).toBe(8000);
  });

  it('never reports a negative elapsed if the clock skews backwards', () => {
    const s = deriveFeedState({ startedAt: 5000, now: 1000, exited: false, sessionId: null });
    expect(s.elapsedMs).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('formats sub-hour durations as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5000)).toBe('0:05');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(11 * 60_000 + 3000)).toBe('11:03');
  });

  it('formats hour-plus durations as h:mm:ss', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1:00:00');
    expect(formatElapsed(60 * 60_000 + 5 * 60_000 + 9000)).toBe('1:05:09');
  });

  it('clamps a negative input to 0:00', () => {
    expect(formatElapsed(-5000)).toBe('0:00');
  });
});
