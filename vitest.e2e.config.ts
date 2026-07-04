import { defineConfig } from 'vitest/config';

/**
 * The e2e drain-harness suite (issue 63): real modules against real
 * infrastructure — temp git repos, real fs watchers, real worktrees and the
 * real afk-merge.sh, real timers. Kept separate from `npm run test` (the fast
 * pure-module unit suite); run it with `npm run test:e2e` — ALWAYS before any
 * human QA walkthrough.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // Real watchers/timers/git are in play: give each spec headroom, and run
    // files serially so concurrent scratch repos never contend on git locks.
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
