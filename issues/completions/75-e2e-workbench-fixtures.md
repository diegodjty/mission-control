---
issue: 75
slug: 75-e2e-workbench-fixtures
outcome: completed
finished: 2026-07-04T15:56:00Z
---
## Completed issue 75 — e2e-workbench-fixtures

**What changed** — The automated end-to-end suite now proves the whole Workbench design works before any human has to walk through it. It builds a throwaway Workbench (registry, a project whose config maps two code repos, a memory folder) plus two throwaway code repos, then drives real drains over them with scripted no-LLM workers: issues run in the repo they each declare, a dependency chain that crosses from one repo to the other executes in order, Receipts land in the Workbench's single completions folder and each produces exactly one chat message, the project's memory file rides every worker's starting prompt and each finished drain writes one journal entry, the Workbench gets one boring git commit per Run event, and an issue pointing at a nonexistent repo is blocked and reported without holding up its siblings. Badly-behaved workers (ones that linger, die mid-exit, or never write a Receipt) are exercised against the new fixture too. The old in-repo layout keeps its entire existing suite unchanged, plus a new named check that a repo the registry doesn't know still falls back to it.

**Try it yourself**
1. `cd /Users/devteam/Developer/mission-control`
2. `source ~/.nvm/nvm.sh && nvm use 22`
3. `npm run test:e2e` — expect 2 test files passed, 20 tests passed, 8 skipped. The skipped ones are the declared `manual-only` items (live-shell/real-claude checks for walkthrough 77), listed by name in the output so nothing is silently untested.
4. To see the suite guard the repo-targeting feature: temporarily add `return { ok: true, repoPath: project.defaultRepoPath };` as the first line of `repoForIssue` in `src/shared/run-targeting.ts`, run `npx vitest run --config vitest.e2e.config.ts -t "Scenario a"` — it fails on the per-worker cwd assertions (workers land in repo-a instead of repo-b). Revert the line and it's green again.

**Verified** — Ran the full gates myself: `npm run test` (937 passed), `npm run type-check` (clean), `npm run test:e2e` (20 passed, 8 declared manual-only, both legacy and workbench files). Also performed the revert-check in acceptance criterion 2 for real: with `repoForIssue` short-circuited to the default repo, Scenario a failed exactly on the cwd assertions; restored the module (git diff confirms byte-identical) and everything is green again. The deliverable is itself a test suite, so running it green is the runtime verification.

**Bookkeeping**
- New: `e2e/workbench-harness.e2e.test.ts` — Scenarios a–f (each named), the misbehavior-modes spec, and 4 declared `manual-only` skips for walkthrough-77 items needing the live shell / a real claude Worker.
- Modified: `e2e/sandbox.ts` — additive only: `seedWorkbenchSandbox()` (workbench git repo with registry.md, two-repo CONFIG, WORKBENCH_ISSUES backlog incl. cross-repo dep chain / HITL / unknown-repo-key issues, memory skeleton with a distinctive CORE fact, plus two code-only repos); optional `repoKey` on `SandboxIssue` and a `repo:` frontmatter line in `issueFileContent` (legacy issues emit byte-identical files).
- Modified: `e2e/fake-worker.ts` — additive only: workbench mode (claim flips + Receipt go to the workbench paths, code work in the target repo), an `onClaimed` observation hook (the app's watcher window, used to fire the per-event auto-commit at the real moment), and `cwd` on the trace for scenario (a)'s assertions.
- Untouched: `e2e/drain-harness.e2e.test.ts` (scenario f's body — all legacy scenarios incl. stray-adoption still pass unchanged), all `src/` product code.
- No deviations from the acceptance criteria.

**Doc drift** — none. One small factual note (not drift): `commitFinishedMain`'s commit message uses the slug without its `NN-` prefix (`afk: complete issue 02 — core-api`), which walkthrough 77's "repo logs contain only code commits" check will see; the harness asserts the actual format.
