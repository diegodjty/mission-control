import { describe, it, expect } from 'vitest';
import {
  parseHeadlessLine,
  createHeadlessStreamParser,
  sessionIdFrom,
  deriveFeedState,
  formatElapsed,
  assistantText,
  deriveActivity,
  extractResult,
  reduceFeedContent,
  reduceFeedContentAll,
  EMPTY_FEED_CONTENT,
} from './headless-feed';
import type { HeadlessEvent } from './headless-feed';

/** Build a HeadlessEvent the way the parser would, for the content tests. */
function ev(obj: Record<string, unknown>): HeadlessEvent {
  return parseHeadlessLine(JSON.stringify(obj))!;
}
/** An assistant event with the given content blocks. */
function assistant(content: unknown): HeadlessEvent {
  return ev({ type: 'assistant', session_id: 's', message: { role: 'assistant', content } });
}
/** A tool_use content block. */
function toolUse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool_use', id: 't1', name, input };
}

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

describe('deriveFeedState (liveness — status + elapsed)', () => {
  it('reads "starting" before the process has a start time', () => {
    const s = deriveFeedState({ startedAt: null, now: 1000, exited: false, sessionId: null });
    expect(s.status).toBe('starting');
    expect(s.elapsedMs).toBe(0);
    expect(s.sessionId).toBeNull();
    // Content fields default to null when no content is supplied (issue 140).
    expect(s.activity).toBeNull();
    expect(s.lastMessage).toBeNull();
    expect(s.result).toBeNull();
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

// --- Feed content: activity, last message, terminal result (issue 140) -------

describe('assistantText', () => {
  it('joins the text blocks of an assistant message, trimmed', () => {
    expect(assistantText(assistant([{ type: 'text', text: '  Hello ' }]))).toBe('Hello');
    expect(
      assistantText(assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])),
    ).toBe('ab');
  });

  it('accepts a plain-string content (the simple shape)', () => {
    expect(assistantText(assistant('just a string'))).toBe('just a string');
  });

  it('returns null for a tool-only turn (no text to show)', () => {
    expect(assistantText(assistant([toolUse('Bash', { command: 'ls' })]))).toBeNull();
  });

  it('tolerates a malformed message/content without throwing', () => {
    expect(assistantText(ev({ type: 'assistant' }))).toBeNull();
    expect(assistantText(assistant(42))).toBeNull();
    expect(assistantText(assistant([null, 7, { type: 'text' }]))).toBeNull();
  });
});

describe('deriveActivity', () => {
  it('maps common tools to a short human-readable line', () => {
    expect(deriveActivity(assistant([toolUse('Bash', { command: 'npm test' })]))).toEqual({
      text: 'running npm test',
      tool: 'Bash',
    });
    expect(
      deriveActivity(assistant([toolUse('Edit', { file_path: '/repo/src/App.tsx' })])),
    ).toEqual({ text: 'editing App.tsx', tool: 'Edit' });
    expect(
      deriveActivity(assistant([toolUse('Read', { file_path: '/repo/README.md' })])),
    ).toEqual({ text: 'reading README.md', tool: 'Read' });
    expect(deriveActivity(assistant([toolUse('Grep', { pattern: 'TODO' })]))).toEqual({
      text: 'searching for TODO',
      tool: 'Grep',
    });
    expect(deriveActivity(assistant([toolUse('WebSearch', {})]))).toEqual({
      text: 'searching the web',
      tool: 'WebSearch',
    });
  });

  it('falls back to "using <Tool>" for an unknown tool', () => {
    expect(deriveActivity(assistant([toolUse('SomeMcpTool', {})]))).toEqual({
      text: 'using SomeMcpTool',
      tool: 'SomeMcpTool',
    });
  });

  it('takes the LAST tool_use when a turn has several', () => {
    const event = assistant([
      { type: 'text', text: 'first' },
      toolUse('Read', { file_path: '/a.ts' }),
      toolUse('Bash', { command: 'npm run type-check' }),
    ]);
    expect(deriveActivity(event)?.text).toBe('running npm run type-check');
  });

  it('clips a long command to one short line', () => {
    const long = 'echo ' + 'x'.repeat(200);
    const line = deriveActivity(assistant([toolUse('Bash', { command: long })]))!.text;
    expect(line.startsWith('running ')).toBe(true);
    expect(line.length).toBeLessThan(60);
    expect(line.endsWith('…')).toBe(true);
  });

  it('returns null when there is no tool call (a plain chat turn)', () => {
    expect(deriveActivity(assistant([{ type: 'text', text: 'thinking' }]))).toBeNull();
  });

  it('tolerates a tool_use with a missing/odd input', () => {
    expect(deriveActivity(assistant([{ type: 'tool_use', name: 'Bash' }]))).toEqual({
      text: 'running a command',
      tool: 'Bash',
    });
    expect(deriveActivity(assistant([{ type: 'tool_use', name: 'Edit', input: 5 }]))).toEqual({
      text: 'editing a file',
      tool: 'Edit',
    });
  });
});

describe('extractResult', () => {
  it('extracts the terminal result with its usage payload intact (issue 143)', () => {
    const event = ev({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      result: 'all done',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      total_cost_usd: 0.02,
    });
    const r = extractResult(event)!;
    expect(r.subtype).toBe('success');
    expect(r.isError).toBe(false);
    expect(r.text).toBe('all done');
    // Usage is passed through VERBATIM — nothing dropped, nothing renamed.
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 });
    // The whole event is retained so a downstream read needs no second parse.
    expect(r.raw.num_turns).toBe(3);
    expect(r.raw.total_cost_usd).toBe(0.02);
  });

  it('marks an error result and tolerates a missing usage', () => {
    const r = extractResult(ev({ type: 'result', subtype: 'error_max_turns', is_error: true }))!;
    expect(r.isError).toBe(true);
    expect(r.usage).toBeNull();
    expect(r.text).toBeNull();
  });

  it('returns null for a non-result event', () => {
    expect(extractResult(assistant([{ type: 'text', text: 'hi' }]))).toBeNull();
  });
});

describe('reduceFeedContent', () => {
  it('starts empty and folds an assistant text turn into the last message', () => {
    const next = reduceFeedContent(EMPTY_FEED_CONTENT, assistant([{ type: 'text', text: 'hi' }]));
    expect(next.lastMessage).toBe('hi');
    expect(next.activity).toBeNull();
  });

  it('folds a tool turn into the activity line without blanking the last message', () => {
    let c = reduceFeedContent(EMPTY_FEED_CONTENT, assistant([{ type: 'text', text: 'planning' }]));
    c = reduceFeedContent(c, assistant([toolUse('Bash', { command: 'npm test' })]));
    expect(c.activity).toBe('running npm test');
    expect(c.activityTool).toBe('Bash');
    // A tool-only turn leaves the previous prose message standing (stale, not gone).
    expect(c.lastMessage).toBe('planning');
  });

  it('sets the terminal result on a result event', () => {
    const c = reduceFeedContent(
      EMPTY_FEED_CONTENT,
      ev({ type: 'result', subtype: 'success', usage: { output_tokens: 9 } }),
    );
    expect(c.result?.subtype).toBe('success');
    expect(c.result?.usage).toEqual({ output_tokens: 9 });
  });

  it('returns the SAME reference when an event changes nothing (cheap change-detection)', () => {
    const base = reduceFeedContent(EMPTY_FEED_CONTENT, assistant([{ type: 'text', text: 'x' }]));
    // A system/user/other event, and a text-less tool-less assistant turn, are no-ops.
    expect(reduceFeedContent(base, ev({ type: 'system', session_id: 's' }))).toBe(base);
    expect(reduceFeedContent(base, ev({ type: 'user', message: {} }))).toBe(base);
    expect(reduceFeedContent(base, assistant([]))).toBe(base);
  });

  it('never throws on a malformed or truncated event (degrades gracefully)', () => {
    let c = EMPTY_FEED_CONTENT;
    for (const bad of [
      ev({ type: 'assistant' }),
      ev({ type: 'assistant', message: 'nope' }),
      ev({ type: 'result' }),
      ev({ type: 'other', anything: [1, 2] }),
    ]) {
      expect(() => (c = reduceFeedContent(c, bad))).not.toThrow();
    }
    // The one meaningful event still lands after the noise.
    c = reduceFeedContent(c, assistant([{ type: 'text', text: 'survived' }]));
    expect(c.lastMessage).toBe('survived');
  });
});

describe('reduceFeedContentAll — a representative Worker stream → expected content', () => {
  it('folds a whole session (init → chatter → tools → result) into the final Feed content', () => {
    const p = createHeadlessStreamParser();
    const events = p.push(
      [
        '{"type":"system","subtype":"init","session_id":"sess-1","tools":[]}',
        '{"type":"assistant","session_id":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"Reading the issue…"}]}}',
        '{"type":"assistant","session_id":"sess-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/repo/issues/03.md"}}]}}',
        '{"type":"assistant","session_id":"sess-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"npm test"}}]}}',
        '{"type":"user","session_id":"sess-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}',
        '{"type":"assistant","session_id":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"All tests pass. Done."}]}}',
        '{"type":"result","subtype":"success","session_id":"sess-1","is_error":false,"num_turns":4,"usage":{"input_tokens":100,"output_tokens":40}}',
        '',
      ].join('\n'),
    );
    const content = reduceFeedContentAll(events);
    expect(content.activity).toBe('running npm test'); // last tool action, not cleared by the tool_result
    expect(content.activityTool).toBe('Bash');
    expect(content.lastMessage).toBe('All tests pass. Done.'); // last prose, not the tool turns
    expect(content.result?.subtype).toBe('success');
    expect(content.result?.usage).toEqual({ input_tokens: 100, output_tokens: 40 });
  });
});

describe('deriveFeedState with folded content (issue 140)', () => {
  it('surfaces the content fields alongside liveness', () => {
    const content = reduceFeedContentAll([
      assistant([{ type: 'text', text: 'working' }]),
      assistant([toolUse('Edit', { file_path: '/repo/App.tsx' })]),
    ]);
    const s = deriveFeedState({
      startedAt: 1000,
      now: 4000,
      exited: false,
      sessionId: 'sess-1',
      content,
    });
    expect(s.status).toBe('running');
    expect(s.elapsedMs).toBe(3000);
    expect(s.activity).toBe('editing App.tsx');
    expect(s.lastMessage).toBe('working');
  });
});
