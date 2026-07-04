---
issue: 70
slug: pure-workbench-model
outcome: completed
finished: 2026-07-04T14:06:48Z
---
## Completed issue 70 — pure-workbench-model

**What changed** — Mission Control (and the AFK skill machinery) can now understand the Workbench — the new `~/Workbench` folder where all project backlogs, receipts, and memory will live. There's a new brain module that reads the Workbench's registry ("which code folder belongs to which project"), reads a project's config ("which repos this project spans, which one is the default, how to test it"), reads an issue's optional "which repo am I for" tag, and decides where a session's backlog actually lives: paths named outright win, then the registry lookup, then today's in-repo `issues/` folder as the fallback. It refuses to guess — an unknown repo tag or an unmatchable folder comes back as an explicit "can't resolve" answer instead of a made-up path. This is pure logic only; nothing in the app's behavior changes yet (issues 71–72 wire it in).

**Try it yourself** — This is a logic-only module with no screen or endpoint, so the test suite is the way to see it:
1. `cd ~/Developer/mission-control`
2. `source ~/.nvm/nvm.sh && nvm use 22`
3. `npm run test -- src/shared/workbench-model.test.ts` — you should see 1 file, 43 tests, all passing, covering registry/CONFIG/issue parsing (including malformed junk) and the full resolution decision table.

**Verified** — Beyond the unit tests: bundled the module and ran it against the *real* `~/Workbench/registry.md` and `~/Workbench/mission-control/CONFIG.md` from issue 69's scaffold. It parsed exactly one registry entry (mission-control, inactive), correctly ignored the registry's fenced schema example and HTML comment with zero malformed-input notes, read the `repos:` map + `default_repo: app` + test-commands section, and resolved MC's own cwd to the **legacy** in-repo layout (correct — the registry entry stays inactive until migration issue 76). Full suite: 56 unit files / 851 tests green, `npm run type-check` clean, and `npm run test:e2e` also ran green in the same sweep.

**Bookkeeping** — Added `src/shared/workbench-model.ts` (pure: zero imports, no fs/Electron) and `src/shared/workbench-model.test.ts` (43 tests). No other source files touched. TDD: tests written and confirmed red before implementation. Design notes: parsers return paths verbatim and `resolveProject` only rewrites a leading `~/` via a caller-supplied `homeDir`, keeping actual tilde discovery at the edge per the issue; a missing/unrecognized registry `status` degrades to *inactive* (the conservative "must not resolve" reading) with an explicit note. Untracked `SESSION-HANDOFF.md` was already in the tree before this Run — not mine, left alone.

**Doc drift** — none. The real `~/Workbench` shapes from issue 69 match ADR-0015 and parsed cleanly.
