---
issue: 71
slug: project-identity-refactor
outcome: completed
finished: 2026-07-04T14:33:37Z
---
## Completed issue 71 — project-identity-refactor

**What changed** — Mission Control no longer assumes a Project *is* a repo folder. A Project is now an identity that can be either a Workbench entry (a folder under `~/Workbench/` that references one or more code repos) or, as before, a plain repo with its own `issues/` folder. When you open a project — by typing a repo path, picking a folder, or opening a workbench directory — the app resolves whatever you gave it to one canonical identity, so opening the same project two different ways (its workbench folder vs. one of its repos) lands on the same Project, with one owner window, one backlog, one map. Everything downstream (the Map, the live backlog watcher, the "what's left?" status) now reads the project's resolved issues location wherever it lives, instead of hard-coding `<repo>/issues`. Existing repo-based projects (the QA sandbox, this repo itself) behave exactly as before — verified against the real registry on disk, where mission-control's entry is still `inactive` and correctly resolves to the legacy layout until the migration issue flips it.

**Try it yourself**
1. `cd /Users/devteam/Developer/mission-control && source ~/.nvm/nvm.sh && nvm use 22`
2. `npm run dev` — the Mission Control window opens. (Stop it later with Ctrl-C in that terminal.)
3. In the Project bar, type `/Users/devteam/Developer/mc-qa-sandbox/repo-a` and click **Open here**. Expect: the sandbox backlog appears in the Map exactly as it always has (legacy layout, unchanged).
4. Now type `/Users/devteam/Workbench/mission-control` and click **Open here**. Expect: it opens as project "mission-control" with an empty backlog (the workbench `issues/` folder is an empty scaffold until issue 76 migrates the files) — no crash, no error about a missing repo.
5. Alias-dedupe check (the headline rule): open a second window (**Open in new Window**) on `/Users/devteam/Workbench/mission-control` while the first window still holds it, and also try opening it via a member-repo path once one is registered `active` in `~/Workbench/registry.md`. Expect: the second window is refused with "already open in another Window" — both handles hit the same ownership key. (Today, with the registry entry still `inactive`, repo paths deliberately resolve legacy — so the two-alias case is fully drivable in the QA walkthrough's workbench fixture, issue 77.)

**Verified**
- Full unit suite: 876 tests green (25 new: 18 pure identity/alias tests, 6 filesystem resolver tests, 1 workbench-shaped backlog-watcher test). `npm run type-check` green. `npm run test:e2e` green (12 passed, 4 declared manual-only — unchanged).
- Live resolver run against the REAL disk (`npx tsx` script): QA sandbox → legacy identity unchanged; `/Users/devteam/Developer/mission-control` → legacy (its registry entry is `inactive` and is correctly skipped — no premature workbench flip before migration); `/Users/devteam/Workbench/mission-control` → workbench identity with `issuesRoot`/`completionsRoot` under the workbench and `defaultRepoPath` read from its real CONFIG.md.
- App boot smoke: `npm run dev` builds main/preload and starts Electron cleanly with the refactor in place.
- NOT runtime-verified: the in-app click-through of opening by both aliases (needs a live GUI drive; per CONFIG, UI seams verify via type-check + the batch QA walkthrough — issue 77's checklist has "Open by either handle" as its first item).

**Bookkeeping**
- New: `src/shared/project-identity.ts` (+test) — pure locate/resolve of an opened handle to a `ProjectIdentity` (key, kind, label, issuesRoot, completionsRoot, defaultRepoPath, repoPaths), built on issue 70's workbench-model; `src/main/project-resolver.ts` (+test) — the fs adapter (reads `~/Workbench`, `registry.md`, project `CONFIG.md`).
- `src/shared/project-registry.ts` — identity break: `Project.repoPath` → `Project.key`; `normalizeRepoPath`/`checkRepoOwnership`/`ownsRepo` → `normalizeProjectKey`/`checkProjectOwnership`/`ownsProject`; docs rewritten around the key. Test updated.
- `src/shared/ipc-contract.ts` — `ProjectView` reshaped (`key`/`kind`/`label`/`issuesRoot`/`defaultRepoPath`); `activeRepoPath` → `activeProjectKey`; open/window requests take `path` (any handle), switch/transition take `key`.
- `src/main/index.ts` — resolves identity once at ProjectOpen (aliases collapse before ownership); holds a key→identity map; backlog load/watch read the resolved issues root; git-flavored handlers (scan/commits/isolation/merge/receipt-watch) act on the identity's default repo (identical to the key for legacy Projects).
- `src/main/backlog-reader.ts` (`readBacklogAt(issuesDir)`, legacy wrapper kept), `src/main/backlog-watcher.ts` (watches a `{projectPath, issuesRoot}` target, echoes the key; +test), `src/shared/window-bootstrap.ts` (+test), `src/main/run-log-store.ts` (rename), `src/renderer/src/App.tsx` (`activeProjectKey`; new `activeDefaultRepo` so Run cwd/isolation checks use the repo, not the key), `src/renderer/src/ProjectBar.tsx` (labels/keys), `src/shared/workbench-model.ts` (export `expandTilde`).
- Scope bridge, deliberate: for a workbench Project, Runs/Receipts still execute in and land in the identity's *default repo* (legacy convention) — per-issue `repo:` targeting and workbench-completions Receipts are issue 72, which this identity layer was shaped to feed.

**Doc drift** — none. Code and data matched ADR-0015 and issue 70's module as documented (including the real registry's documented-by-example schema block, which the parser correctly ignores).
