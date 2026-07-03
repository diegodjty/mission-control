import { describe, it, expect } from 'vitest';
import { createRepoSerializer } from './repo-serializer';

/** A manually-resolvable promise, for controlling task timing in tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createRepoSerializer', () => {
  it('runs same-key tasks strictly one after another', async () => {
    const s = createRepoSerializer();
    const order: string[] = [];
    const gate1 = deferred<void>();

    const t1 = s.run('/repo/a', async () => {
      order.push('t1:start');
      await gate1.promise;
      order.push('t1:end');
    });
    const t2 = s.run('/repo/a', async () => {
      order.push('t2:start');
      order.push('t2:end');
    });

    // t2 must not have started while t1 is still in flight.
    await Promise.resolve();
    expect(order).toEqual(['t1:start']);

    gate1.resolve();
    await Promise.all([t1, t2]);
    expect(order).toEqual(['t1:start', 't1:end', 't2:start', 't2:end']);
  });

  it('runs tasks on different keys concurrently', async () => {
    const s = createRepoSerializer();
    const order: string[] = [];
    const gateA = deferred<void>();

    const a = s.run('/repo/a', async () => {
      order.push('a:start');
      await gateA.promise;
      order.push('a:end');
    });
    const b = s.run('/repo/b', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    // b (different key) is free to finish while a is blocked.
    await b;
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    gateA.resolve();
    await a;
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('a failing task does not poison later same-key tasks', async () => {
    const s = createRepoSerializer();
    const failed = s.run('/repo/a', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    const after = s.run('/repo/a', async () => 'ok');
    await expect(after).resolves.toBe('ok');
  });

  it('surfaces the task result to the caller', async () => {
    const s = createRepoSerializer();
    await expect(s.run('/repo/a', () => 42)).resolves.toBe(42);
  });

  it('drops a key once its chain drains, keeping different keys isolated', async () => {
    const s = createRepoSerializer();
    await s.run('/repo/a', async () => undefined);
    // Give the identity-checked cleanup a microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(s.activeKeys()).toBe(0);
  });
});
