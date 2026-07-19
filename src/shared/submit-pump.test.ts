/**
 * Issue 60 — the submit-pump must be unstallable.
 *
 * The live failure this guards: issue 05's `needs-verification` Receipt was
 * ingested, the pure derivation was unit-green, yet the HITL-waiting chat
 * notification never appeared. The loss was between enqueue and the chat PTY:
 * the old pump captured the session id in a closure, `shift()`ed each item
 * BEFORE its delivery was assured, had no error path around `writePty`, and its
 * `dispatcherPumping` flag had no recovery — a session replaced mid-pump (gate
 * churn) stranded the queue forever, silently.
 *
 * These tests encode the three issue-60 rules against the extracted pump:
 *   1. The pump can't stay stuck — a write failure or a session change mid-pump
 *      resets pump state; a watchdog re-kicks a stalled non-empty queue.
 *   2. Blocking notifications are never droppable — items stay queued across
 *      session replacement/death and are (re)delivered when a session attaches.
 *   3. Delivery is observable — queued → typed → submitted (and requeued /
 *      write-failed) phases are reported per item, keyed by the event key.
 *
 * The scheduler and clock are injected, so time is driven manually — no real
 * timers, no React, no Electron.
 */
import { describe, it, expect } from 'vitest';
import {
  createSubmitPump,
  PUMP_WATCHDOG_MS,
  CHAT_IDLE_MS,
  COMPOSE_DECAY_MS,
  INITIAL_TYPING_STATE,
  canFlushChat,
  isLineClearInput,
  isNonComposeInput,
  isSubmitInput,
  reduceTyping,
  type DeliveryPhase,
  type PumpScheduler,
  type TypingState,
} from './submit-pump';
import { SUBMIT_KEY } from './submit-sequence';

/** Deterministic manual scheduler: tasks run only when the test advances time. */
class FakeScheduler implements PumpScheduler {
  now = 0;
  private tasks: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;

  schedule(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.push({ at: this.now + ms, fn, id });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle);
  }

  /** Advance the clock, running due tasks in time order (including tasks they schedule). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t !== due);
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = target;
  }
}

interface Harness {
  sched: FakeScheduler;
  writes: { session: string; data: string }[];
  phases: { key: string; phase: DeliveryPhase }[];
  setCanFlush(v: boolean): void;
  setFailWrites(v: boolean): void;
  pump: ReturnType<typeof createSubmitPump>;
}

function makeHarness(): Harness {
  const sched = new FakeScheduler();
  const writes: { session: string; data: string }[] = [];
  const phases: { key: string; phase: DeliveryPhase }[] = [];
  let canFlush = true;
  let failWrites = false;
  const pump = createSubmitPump({
    write: (session, data) => {
      if (failWrites) throw new Error('EPIPE: session is gone');
      writes.push({ session, data });
    },
    canFlush: () => canFlush,
    now: () => sched.now,
    onDelivery: (key, phase) => phases.push({ key, phase }),
    scheduler: sched,
  });
  return {
    sched,
    writes,
    phases,
    setCanFlush: (v) => (canFlush = v),
    setFailWrites: (v) => (failWrites = v),
    pump,
  };
}

/** The submits (Enter writes) that landed in a given session. */
function submitsTo(h: Harness, session: string): number {
  return h.writes.filter((w) => w.session === session && w.data === SUBMIT_KEY).length;
}

/** The text (non-submit) writes that landed in a given session. */
function textsTo(h: Harness, session: string): string[] {
  return h.writes.filter((w) => w.session === session && w.data !== SUBMIT_KEY).map((w) => w.data);
}

describe('dispatcher pump — basic delivery', () => {
  it('types then submits a queued item into the attached session', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'k1', text: 'hello there' });
    h.sched.advance(1000);
    expect(textsTo(h, 'A')).toEqual(['hello there']);
    expect(submitsTo(h, 'A')).toBe(1);
  });

  it('submits close-together items as distinct messages, in order', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'k1', text: 'first' });
    h.pump.enqueue({ key: 'k2', text: 'second' });
    h.sched.advance(5000);
    expect(h.writes.map((w) => w.data)).toEqual(['first', SUBMIT_KEY, 'second', SUBMIT_KEY]);
  });

  it('reports queued → typed → submitted for a delivered item', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'k1', text: 'hello' });
    h.sched.advance(1000);
    expect(h.phases.filter((p) => p.key === 'k1').map((p) => p.phase)).toEqual([
      'queued',
      'typed',
      'submitted',
    ]);
  });

  it('holds while the user is composing and flushes once the line is idle', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.setCanFlush(false);
    h.pump.enqueue({ key: 'k1', text: 'held' });
    h.sched.advance(2000);
    expect(h.writes).toEqual([]); // still held — never interleave with typing
    h.setCanFlush(true);
    h.sched.advance(2000);
    expect(submitsTo(h, 'A')).toBe(1);
  });

  it('a held queue flushes in enqueue order once the gate opens (issue 68)', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.setCanFlush(false);
    h.pump.enqueue({ key: 'k1', text: 'first' });
    h.pump.enqueue({ key: 'k2', text: 'second' });
    h.pump.enqueue({ key: 'k3', text: 'third' });
    h.sched.advance(3000);
    expect(h.writes).toEqual([]); // all held — nothing interleaves with typing
    h.setCanFlush(true);
    h.sched.advance(5000);
    expect(textsTo(h, 'A')).toEqual(['first', 'second', 'third']);
    expect(submitsTo(h, 'A')).toBe(3);
  });

  it('dedupes a key that is already pending in the queue', () => {
    const h = makeHarness();
    expect(h.pump.enqueue({ key: 'k1', text: 'once' })).toBe(true);
    expect(h.pump.enqueue({ key: 'k1', text: 'once' })).toBe(false);
    h.pump.attachSession('A');
    h.sched.advance(5000);
    expect(submitsTo(h, 'A')).toBe(1);
  });
});

describe('dispatcher pump — never droppable (issue 60 rule 2)', () => {
  it('an item enqueued while no session is attached delivers when one attaches', () => {
    const h = makeHarness();
    h.pump.enqueue({ key: 'k1', text: 'early' });
    h.sched.advance(5000);
    expect(h.writes).toEqual([]); // nowhere to write yet — but NOT dropped
    h.pump.attachSession('A');
    h.sched.advance(1000);
    expect(textsTo(h, 'A')).toEqual(['early']);
    expect(submitsTo(h, 'A')).toBe(1);
  });

  it('redelivers into the replacement session when the session is replaced mid-pump', () => {
    // THE issue-60 reproduction: a blocking notification is mid-delivery when
    // gate churn replaces the Dispatcher session. The old pump kept writing to
    // the dead session (closure) and had already shift()ed the item — the
    // notification was silently lost. It must instead be fully re-typed and
    // submitted into the NEW session.
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'hitl-waiting:run-05', text: 'Issue 05 is waiting for you' });
    // The type write lands in A synchronously; the submit is still pending.
    expect(textsTo(h, 'A')).toEqual(['Issue 05 is waiting for you']);
    h.pump.attachSession('B'); // session replaced mid-pump
    h.sched.advance(5000);
    expect(submitsTo(h, 'A')).toBe(0); // never submit into the dead session
    expect(textsTo(h, 'B')).toEqual(['Issue 05 is waiting for you']);
    expect(submitsTo(h, 'B')).toBe(1); // delivered exactly once
    expect(h.phases.map((p) => p.phase)).toContain('requeued');
  });

  it('survives session death (detach) mid-pump and delivers to the next session', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'k1', text: 'important' });
    h.pump.attachSession(null); // the chat PTY died; no replacement yet
    h.sched.advance(10_000);
    expect(submitsTo(h, 'A')).toBe(0);
    h.pump.attachSession('B');
    h.sched.advance(1000);
    expect(textsTo(h, 'B')).toEqual(['important']);
    expect(submitsTo(h, 'B')).toBe(1);
  });
});

describe('dispatcher pump — cannot stay stuck (issue 60 rule 1)', () => {
  it('a write failure resets pump state and the watchdog redelivers', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.setFailWrites(true);
    // The enqueue itself must not throw even though the write does.
    expect(() => h.pump.enqueue({ key: 'k1', text: 'retry me' })).not.toThrow();
    expect(h.phases.map((p) => p.phase)).toContain('write-failed');
    // The session recovers; the watchdog must re-pump without any external kick.
    h.setFailWrites(false);
    h.sched.advance(PUMP_WATCHDOG_MS * 2 + 1000);
    expect(textsTo(h, 'A')).toEqual(['retry me']);
    expect(submitsTo(h, 'A')).toBe(1);
  });

  it('a write failure mid-item does not lose the item or later items', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'k1', text: 'one' });
    // First item typed fine; make its submit write fail.
    h.setFailWrites(true);
    h.sched.advance(200); // the submit step fires and throws
    h.setFailWrites(false);
    h.pump.enqueue({ key: 'k2', text: 'two' });
    h.sched.advance(PUMP_WATCHDOG_MS * 2 + 2000);
    expect(submitsTo(h, 'A')).toBe(2);
    expect(textsTo(h, 'A')).toEqual(['one', 'one', 'two']); // k1 fully re-typed after the failure
  });

  it('reset clears the queue and stops the watchdog (project switch / dismiss)', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.setCanFlush(false); // keep the item pending
    h.pump.enqueue({ key: 'k1', text: 'stale' });
    h.pump.reset();
    h.setCanFlush(true);
    h.pump.attachSession('B');
    h.sched.advance(PUMP_WATCHDOG_MS * 3);
    expect(h.writes).toEqual([]); // nothing survives a reset
    expect(h.pump.pending()).toBe(0);
  });
});

describe('dispatcher pump — type-only items (issue 91: a prefix the user completes)', () => {
  it('types the prefix verbatim (trailing space kept) and writes NO submit key', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'stage:grill:1', text: '/grill-with-docs ', submit: false });
    h.sched.advance(1000);
    expect(textsTo(h, 'A')).toEqual(['/grill-with-docs ']);
    expect(submitsTo(h, 'A')).toBe(0);
    // The item is consumed once typed — the queue doesn't wait for an Enter.
    expect(h.pump.pending()).toBe(0);
  });

  it('honours the defer-while-typing gate exactly like a submitted item', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.setCanFlush(false); // the user is mid-keystroke
    h.pump.enqueue({ key: 'stage:grill:1', text: '/grill-with-docs ', submit: false });
    h.sched.advance(1000);
    expect(h.writes).toEqual([]); // never garble a mid-keystroke line
    h.setCanFlush(true);
    h.sched.advance(1000);
    expect(textsTo(h, 'A')).toEqual(['/grill-with-docs ']);
    expect(submitsTo(h, 'A')).toBe(0);
  });

  it('reports queued → typed as its delivery — no phantom "submitted" phase', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'stage:grill:1', text: '/grill-with-docs ', submit: false });
    h.sched.advance(1000);
    expect(h.phases).toEqual([
      { key: 'stage:grill:1', phase: 'queued' },
      { key: 'stage:grill:1', phase: 'typed' },
    ]);
  });

  it('a following submitted item still types-then-submits normally', () => {
    const h = makeHarness();
    h.pump.attachSession('A');
    h.pump.enqueue({ key: 'stage:grill:1', text: '/grill-with-docs ', submit: false });
    h.pump.enqueue({ key: 'stage:prd:2', text: '/to-prd' });
    h.sched.advance(2000);
    expect(textsTo(h, 'A')).toEqual(['/grill-with-docs ', '/to-prd']);
    expect(submitsTo(h, 'A')).toBe(1);
  });
});

// --- Defer-while-typing gate (ADR-0012) — shared by every chat-tier PTY this
// pump feeds (Planning, Just-talk, and historically the Dispatcher).

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
