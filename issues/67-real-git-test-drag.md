---
status: open
depends_on: []
---

# 67 — Root-cause the cumulative real-git test drag (fsevents suspicion)

## Source

Dispatcher forensics, 2026-07-03: `parallel-lifecycle.e2e.test.ts > auto-commit-failure…` runs in ~1s isolated but slows cumulatively when preceded by the file's other real-git tests (~1s of added wall-clock per preceding test; >5s after three → timed out at the old 5s default). Fresh temp repo per test, so it is per-process/environment drag, not shared state. Issue 63's harness independently hit macOS FSEvents dropping events during watcher startup. The timeout was raised to 15s with a pointing comment as a stopgap.

## What to build

Find and fix (or conclusively attribute) the drag: measure per-git-spawn latency across the file's tests; try `vitest --pool=forks` for the real-git files; try pointing the temp repos at a Spotlight-excluded directory (`.noindex` suffix) to test the fsevents theory. If it is environmental and unfixable in-code, document the finding in the test file and CONFIG.md (e.g. "real-git suites use .noindex temp dirs") and keep honest per-test timeouts. Remove the stopgap comment/timeout if a real fix lands.

## Acceptance criteria

- [ ] The drag is measured and attributed (numbers in the completion block, not a guess).
- [ ] Either a fix (e.g. .noindex temp dirs / fork pool) restores the affected test to <2s in a full-file run, or the environmental cause is documented where the timeouts are set.
- [ ] Full suite + type-check + `npm run test:e2e` pass.

## Blocked by

None - can start immediately.
