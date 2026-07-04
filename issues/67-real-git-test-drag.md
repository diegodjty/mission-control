---
status: open
depends_on: []
---

# 67 — Root-cause the cumulative real-git test drag (fsevents suspicion)

## Source

Dispatcher forensics, 2026-07-03. Measured: `parallel-lifecycle.e2e.test.ts > auto-commit-failure…` takes **0.9s isolated**, **5.3s** with one concurrent test file, **~32s** under the full 55-file parallel suite — pure load-proportional git-spawn slowdown (the test issues ~50 sequential git spawns). Ruled out: shared repo state (fresh mkdtemp per test), thread-pool starvation (`--pool=forks` fails identically), Spotlight indexing (`.noindex` temp parent — kept, but no effect). Stopgap in place: 60s timeout on that test with a pointing comment. Issue 63's harness independently hit macOS FSEvents flakiness during watcher startup.

## What to build

Find and fix (or conclusively attribute) the drag: measure per-git-spawn latency across the file's tests; try `vitest --pool=forks` for the real-git files; try pointing the temp repos at a Spotlight-excluded directory (`.noindex` suffix) to test the fsevents theory. If it is environmental and unfixable in-code, document the finding in the test file and CONFIG.md (e.g. "real-git suites use .noindex temp dirs") and keep honest per-test timeouts. Remove the stopgap comment/timeout if a real fix lands.

## Acceptance criteria

- [ ] The drag is measured and attributed (numbers in the completion block, not a guess).
- [ ] Either a fix (e.g. .noindex temp dirs / fork pool) restores the affected test to <2s in a full-file run, or the environmental cause is documented where the timeouts are set.
- [ ] Full suite + type-check + `npm run test:e2e` pass.

## Blocked by

None - can start immediately.
