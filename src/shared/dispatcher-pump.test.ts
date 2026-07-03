/**
 * Issue 60 — the Dispatcher submit-pump must be unstallable.
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
  createDispatcherPump,
  PUMP_WATCHDOG_MS,
  type DeliveryPhase,
  type PumpScheduler,
} from './dispatcher-pump';
import { SUBMIT_KEY } from './dispatcher-feed';

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
  pump: ReturnType<typeof createDispatcherPump>;
}

function makeHarness(): Harness {
  const sched = new FakeScheduler();
  const writes: { session: string; data: string }[] = [];
  const phases: { key: string; phase: DeliveryPhase }[] = [];
  let canFlush = true;
  let failWrites = false;
  const pump = createDispatcherPump({
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
