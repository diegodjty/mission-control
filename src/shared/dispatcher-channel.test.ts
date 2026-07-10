import { describe, expect, it } from 'vitest';
import {
  CHAT_IDLE_MS,
  COMPOSE_DECAY_MS,
  INITIAL_TYPING_STATE,
  canFlushChat,
  channelForAction,
  channelForAuthority,
  isLineClearInput,
  isNonComposeInput,
  isStatusInjectionTrigger,
  isSubmitInput,
  reduceTyping,
  usesChat,
  usesLog,
  type TypingState,
} from './dispatcher-channel';
import type { Authority, DispatcherAction } from './dispatcher-authority';

// ADR-0011's blocking list (four items as of issue 113) — the ONLY things routed
// to the chat PTY.
const BLOCKING_ACTIONS: DispatcherAction[] = [
  'merge-conflict',
  'abort-drain',
  'hitl-signoff',
  'protected-branch-land',
];
// Everything else is a routine passive/silent fact routed to the ambient log.
const NON_BLOCKING_ACTIONS: DispatcherAction[] = [
  'commit-checkpoint',
  'start-next',
  'synthesize',
  'relay',
  'log-issue',
  'merge',
  'discard-and-continue',
  'amend-plan',
  'course-change',
  'merge-preflight',
  'receipt-adopt',
];

describe('channelForAuthority', () => {
  it('routes a blocking action to the chat PTY', () => {
    expect(channelForAuthority('blocking' as Authority)).toBe('chat');
  });

  it('routes passive and silent facts to the ambient log', () => {
    expect(channelForAuthority('passive' as Authority)).toBe('log');
    expect(channelForAuthority('silent' as Authority)).toBe('log');
  });
});

describe('channelForAction (the routing decision)', () => {
  it('sends ONLY the blocking-approval prompts to the chat (four as of issue 113)', () => {
    for (const action of BLOCKING_ACTIONS) {
      expect(channelForAction(action)).toBe('chat');
      expect(usesChat(action)).toBe(true);
      expect(usesLog(action)).toBe(false);
    }
  });

  it('sends every routine passive/silent fact to the ambient log, not the chat', () => {
    for (const action of NON_BLOCKING_ACTIONS) {
      expect(channelForAction(action)).toBe('log');
      expect(usesLog(action)).toBe(true);
      expect(usesChat(action)).toBe(false);
    }
  });

  it('routes the specific ADR-0012 routine facts to the log (committed/merged-clean/done/issue-logged)', () => {
    // committed checkpoint, a clean merge, a finished-Run synthesis, a logged issue.
    expect(channelForAction('commit-checkpoint')).toBe('log');
    expect(channelForAction('merge')).toBe('log');
    expect(channelForAction('synthesize')).toBe('log');
    expect(channelForAction('log-issue')).toBe('log');
    // A conflicting merge still blocks → chat.
    expect(channelForAction('merge-conflict')).toBe('chat');
  });
});

describe('isSubmitInput / isLineClearInput', () => {
  it('treats a trailing Enter / carriage return / newline as a submit', () => {
    expect(isSubmitInput('\r')).toBe(true);
    expect(isSubmitInput('\n')).toBe(true);
    expect(isSubmitInput('hello\r')).toBe(true);
    expect(isSubmitInput('hello')).toBe(false);
    expect(isSubmitInput('')).toBe(false);
  });

  it('treats Ctrl-C and Ctrl-U as a line clear', () => {
    expect(isLineClearInput('\x03')).toBe(true);
    expect(isLineClearInput('\x15')).toBe(true);
    expect(isLineClearInput('a')).toBe(false);
  });
});

describe('reduceTyping (compose-state fold over the PTY input stream)', () => {
  it('a printable keystroke marks the user mid-compose', () => {
    const s = reduceTyping(INITIAL_TYPING_STATE, 'h', 1000);
    expect(s.composing).toBe(true);
    expect(s.lastInputAt).toBe(1000);
  });

  it('a submit ends the compose but stamps the input time', () => {
    const typing = reduceTyping(INITIAL_TYPING_STATE, 'hi', 1000);
    const submitted = reduceTyping(typing, '\r', 1200);
    expect(submitted.composing).toBe(false);
    expect(submitted.lastInputAt).toBe(1200);
  });

  it('Ctrl-C clears the compose line', () => {
    const typing = reduceTyping(INITIAL_TYPING_STATE, 'oops', 1000);
    const cleared = reduceTyping(typing, '\x03', 1100);
    expect(cleared.composing).toBe(false);
  });

  it('empty input is a no-op (keeps the prior state)', () => {
    const typing = reduceTyping(INITIAL_TYPING_STATE, 'x', 1000);
    expect(reduceTyping(typing, '', 5000)).toBe(typing);
  });
});

describe('canFlushChat (defer-while-typing gate)', () => {
  it('may flush from the initial state (nothing typed yet)', () => {
    expect(canFlushChat(INITIAL_TYPING_STATE, 10_000)).toBe(true);
  });

  it('holds while the user is mid-compose, well past the idle window (until the compose decays)', () => {
    const composing: TypingState = { composing: true, lastInputAt: 1000 };
    // Far past the idle window — but inside the decay window — an un-submitted
    // line still holds the queue.
    expect(canFlushChat(composing, 1000 + CHAT_IDLE_MS * 10)).toBe(false);
  });

  it('holds for the idle window right after a submit, then flushes', () => {
    const justSubmitted: TypingState = { composing: false, lastInputAt: 2000 };
    // Immediately after Enter: still held.
    expect(canFlushChat(justSubmitted, 2000)).toBe(false);
    expect(canFlushChat(justSubmitted, 2000 + CHAT_IDLE_MS - 1)).toBe(false);
    // Once the line has been idle for the window: safe to flush.
    expect(canFlushChat(justSubmitted, 2000 + CHAT_IDLE_MS)).toBe(true);
  });

  it('a mid-drain injection is deferred across a burst of typing until idle', () => {
    // Simulate the user typing while a drain wants to inject: each keystroke
    // re-holds the queue; only after they stop (and the idle window elapses)
    // does the gate open.
    let state = INITIAL_TYPING_STATE;
    let t = 0;
    for (const ch of 'what is left'.split('')) {
      t += 100;
      state = reduceTyping(state, ch, t);
      expect(canFlushChat(state, t)).toBe(false);
    }
    state = reduceTyping(state, '\r', (t += 100));
    expect(canFlushChat(state, t)).toBe(false);
    expect(canFlushChat(state, t + CHAT_IDLE_MS)).toBe(true);
  });
});

// Issue 68 decision table: input chunks that are NOT typing — focus reports,
// mouse reports, bracketed-paste guards, and other bare terminal replies — must
// never arm the compose gate; printable characters and editing keys still do.
const NON_COMPOSE_CHUNKS: Array<[string, string]> = [
  ['focus-in report', '\x1b[I'],
  ['focus-out report', '\x1b[O'],
  ['SGR mouse press', '\x1b[<0;10;5M'],
  ['SGR mouse release', '\x1b[<0;10;5m'],
  ['SGR mouse-wheel burst', '\x1b[<64;3;4M\x1b[<64;3;4M\x1b[<65;3;5M'],
  ['legacy X10 mouse report', '\x1b[M !!'],
  ['bracketed-paste open guard', '\x1b[200~'],
  ['bracketed-paste close guard', '\x1b[201~'],
  ['cursor-position report', '\x1b[24;80R'],
  ['device-attributes reply', '\x1b[?1;2c'],
  ['mixed focus + mouse burst', '\x1b[I\x1b[<0;1;1M\x1b[O'],
];
const COMPOSE_CHUNKS: Array<[string, string]> = [
  ['printable character', 'a'],
  ['a word', 'hello'],
  ['arrow key (editing)', '\x1b[A'],
  ['delete key (editing)', '\x1b[3~'],
  ['backspace (editing)', '\x7f'],
  ['bracketed paste WITH pasted text inside', '\x1b[200~hi\x1b[201~'],
];

describe('isNonComposeInput (issue 68 decision table)', () => {
  for (const [label, chunk] of NON_COMPOSE_CHUNKS) {
    it(`classifies a ${label} as non-compose input`, () => {
      expect(isNonComposeInput(chunk)).toBe(true);
    });
  }

  for (const [label, chunk] of COMPOSE_CHUNKS) {
    it(`classifies ${label} as compose input`, () => {
      expect(isNonComposeInput(chunk)).toBe(false);
    });
  }

  it('empty input is not classified as non-compose (it is a plain no-op)', () => {
    expect(isNonComposeInput('')).toBe(false);
  });
});

describe('reduceTyping ignores non-compose input (issue 68)', () => {
  for (const [label, chunk] of NON_COMPOSE_CHUNKS) {
    it(`a ${label} never sets composing`, () => {
      const s = reduceTyping(INITIAL_TYPING_STATE, chunk, 5000);
      expect(s.composing).toBe(false);
    });
  }

  it('a non-compose chunk leaves the state untouched (no lastInputAt bump — a scroll is not a keystroke)', () => {
    const typing = reduceTyping(INITIAL_TYPING_STATE, 'hel', 1000);
    expect(reduceTyping(typing, '\x1b[I', 9000)).toBe(typing);
    expect(reduceTyping(INITIAL_TYPING_STATE, '\x1b[<64;3;4M', 9000)).toBe(INITIAL_TYPING_STATE);
  });

  it('a non-compose chunk does not clear an existing compose either', () => {
    const typing = reduceTyping(INITIAL_TYPING_STATE, 'hel', 1000);
    const after = reduceTyping(typing, '\x1b[O', 2000);
    expect(after.composing).toBe(true);
  });

  for (const [label, chunk] of COMPOSE_CHUNKS) {
    it(`${label} still sets composing`, () => {
      const s = reduceTyping(INITIAL_TYPING_STATE, chunk, 5000);
      expect(s.composing).toBe(true);
      expect(s.lastInputAt).toBe(5000);
    });
  }
});

describe('compose decay (issue 68): an abandoned line stops blocking the flush', () => {
  const abandoned: TypingState = { composing: true, lastInputAt: 10_000 };

  it('is generous: at least ~15s of idle before a compose is considered abandoned', () => {
    expect(COMPOSE_DECAY_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('holds right up to the decay window, then no longer blocks', () => {
    expect(canFlushChat(abandoned, 10_000 + COMPOSE_DECAY_MS - 1)).toBe(false);
    expect(canFlushChat(abandoned, 10_000 + COMPOSE_DECAY_MS)).toBe(true);
  });

  it('a submit still releases immediately (after only the short idle window)', () => {
    const submitted = reduceTyping(abandoned, '\r', 11_000);
    expect(canFlushChat(submitted, 11_000 + CHAT_IDLE_MS)).toBe(true);
  });

  it('a line-clear (Ctrl-C) still releases immediately (after only the short idle window)', () => {
    const cleared = reduceTyping(abandoned, '\x03', 11_000);
    expect(canFlushChat(cleared, 11_000 + CHAT_IDLE_MS)).toBe(true);
  });

  it('fresh typing after a decayed compose re-arms the hold', () => {
    const resumed = reduceTyping(abandoned, 'x', 10_000 + COMPOSE_DECAY_MS + 1000);
    expect(canFlushChat(resumed, 10_000 + COMPOSE_DECAY_MS + 1500)).toBe(false);
  });
});

describe('isStatusInjectionTrigger (issue 52)', () => {
  const composing: TypingState = { composing: true, lastInputAt: 100 };
  const idle: TypingState = { composing: false, lastInputAt: 0 };

  it('fires when the user submits a line they were composing', () => {
    expect(isStatusInjectionTrigger(composing, '\r')).toBe(true);
    expect(isStatusInjectionTrigger(composing, '\n')).toBe(true);
    expect(isStatusInjectionTrigger(composing, 'what is left?\r')).toBe(true);
  });

  it('does NOT fire on a bare Enter on an empty prompt (nothing composed)', () => {
    expect(isStatusInjectionTrigger(idle, '\r')).toBe(false);
  });

  it('does NOT fire on an ordinary keystroke mid-compose', () => {
    expect(isStatusInjectionTrigger(composing, 'x')).toBe(false);
    expect(isStatusInjectionTrigger(idle, 'w')).toBe(false);
  });

  it('does NOT fire on a line-clear (Ctrl-C / Ctrl-U), which abandons the line', () => {
    expect(isStatusInjectionTrigger(composing, '\x03')).toBe(false);
    expect(isStatusInjectionTrigger(composing, '\x15')).toBe(false);
  });

  it('agrees with isSubmitInput exactly when the line was being composed', () => {
    for (const data of ['\r', '\n', 'abc\r', 'x', '\x03', '']) {
      expect(isStatusInjectionTrigger(composing, data)).toBe(isSubmitInput(data));
    }
  });
});
