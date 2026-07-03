/**
 * Per-repo serializer — a lightweight async mutex keyed by repo path.
 *
 * ADR-0004's ownership rule already stops two *different* Windows driving git
 * work on the same repo at once (a repo has one owner). But the single owning
 * Window can itself fire overlapping repo-mutating IPC calls — a drain applying
 * isolation while a finished Run auto-commits, a Merge while a stray scan-driven
 * commit lands — and git worktree/branch mutations on one repo are not safe to
 * run concurrently (index locks, `.git/worktrees` races, a merge racing a
 * commit). This serializer chains tasks that share a key so they run strictly
 * one-after-another, while tasks on *different* repos still run in parallel.
 *
 * It is deliberately tiny and side-effect-free at construction: `run(key, task)`
 * appends `task` to that key's promise chain and returns the task's own promise.
 * A task's rejection is isolated — it never poisons later tasks on the same key
 * (the internal tail always settles), and the caller still sees the real
 * rejection from its own `run(...)` promise. The chain entry is dropped once its
 * last task settles, so long-lived processes don't accumulate keys.
 */

/** A unit of repo work to serialize. Runs when earlier same-key work settles. */
export type RepoTask<T> = () => Promise<T> | T;

/** A serializer instance: one shared queue set for the whole backend. */
export interface RepoSerializer {
  /**
   * Run `task` after all previously-queued tasks for `key` have settled. Tasks
   * with different keys run concurrently. Returns the task's result/rejection.
   */
  run<T>(key: string, task: RepoTask<T>): Promise<T>;
  /** How many keys currently have an in-flight chain (for tests/inspection). */
  activeKeys(): number;
}

export function createRepoSerializer(): RepoSerializer {
  // The current tail promise per key. Always a non-rejecting promise so a failed
  // task can't break the chain for the next waiter.
  const tails = new Map<string, Promise<void>>();

  function run<T>(key: string, task: RepoTask<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    // Run `task` once `prev` settles, regardless of how it settled.
    const result = prev.then(() => task());
    // The chain's new tail swallows this task's outcome so the next task always
    // runs; identity-checked cleanup drops the key once this is the last task.
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  return {
    run,
    activeKeys: () => tails.size,
  };
}
