# The Workbench: pipeline artifacts and memory live in one private repo, outside the code

**Status:** accepted. Refines ADR-0013 (Receipt location) and the Project model implicit in ADR-0002/0004; the ecosystem's data-layer decision.

Two forces converged. (1) Diego's repos are shared with a 5-person team: `issues/`, `completions/`, PRDs and HUMAN-SETUP riding shared repos and PRs confuse colleagues who don't work this pipeline. (2) The tool ecosystem needs a memory system — per-project facts injected into every session, session summaries, curated growth — and cross-repo features need one backlog whose dependency graph spans repos. One move answers all of it: **all pipeline artifacts move out of code repos into `~/Workbench/` — a single private git repo that is the ecosystem's data layer.**

```
~/Workbench/                      ← ONE private git repo (private remote; manual push)
  registry.md                     ← repo path → project mapping (bare-session discovery)
  <project>/
    CONFIG.md                     ← repos: map (key → path), default_repo, test commands
    PRD*.md  issues/  completions/  HUMAN-SETUP.md
    memory/CORE.md                ← curated, hard cap ~1.5k tokens — THE injected file
    memory/topics/  memory/journal/
  meetings/  todos/  …            ← RESERVED for future tools; shapes undesigned (own grills)
  .obsidian/                      ← committed (workspace.json ignored)
```

## Decisions

- **Project redefined:** a Project is a Workbench entry referencing **one or more** code repos (`repos:` map + `default_repo` in its CONFIG), no longer "a repo path". Issues gain optional `repo:` frontmatter (omitted = default). **One issue targets exactly one repo** — cross-repo work is a `depends_on` chain with the interface contract stated in the upstream issue. A Run's worktree/branch/merge/verify mechanics stay per-repo.
- **Boundary:** pipeline artifacts (PRD, issues, Receipts, CONFIG, HUMAN-SETUP, memory) live in the Workbench, uniformly, for every project including solo repos. Code-describing docs (CONTEXT.md, `docs/adr/`) stay with the code they describe.
- **Discovery order** (afk-issue-runner + MC): explicit paths in the spawning prompt → `registry.md` lookup by cwd → **legacy fallback: an in-repo `issues/` keeps today's behavior** (QA sandbox, other skill users).
- **Git model:** Workers flip claims and write Receipts directly in the Workbench (the shared claim surface). MC auto-commits the Workbench after each Run event (claim/park/done+Receipt) with boring messages; push is manual. **Single-machine by construction — tripwire:** running from a second machine requires designing claim sync (auto-push/pull) FIRST, else silent double-claims.
- **Memory:** `CORE.md` (capped) is injected into every Worker prompt and Dispatcher seed; bare terminal sessions get it via one standing instruction in the global `~/.claude/CLAUDE.md` (resolve cwd via registry — zero trace in any repo). The Dispatcher appends drain summaries to `journal/`; a **weekly scheduled curator agent** promotes/prunes/dedupes, flags contradictions and secret-shaped content, and is autonomous on `topics/`/`journal/` but **proposes CORE.md edits for human sign-off** (memory poisoning steers every future session; CORE changes are cheap to approve, expensive to miss).
- **Obsidian is a lens, never a dependency:** one vault at the Workbench root, plain frontmatter + `[[wikilinks]]` only; no plugin/template may be load-bearing for MC, skills, or agents.
- **Migration: move-and-delete, machine-gated.** MC's in-repo backlog (issues 01–68, Receipts, PRDs) moves to `~/Workbench/mission-control/` with `## Parent` links rewritten; originals `git rm`'d with a pointer note; exactly one source of truth from that moment (git history preserves the past). The migration is the batch's final issue, gated on a workbench-shaped e2e fixture passing (machine-before-human, per CONFIG).

## Considered Options

- **In-repo artifacts, gitignored** — invisible to colleagues but unversioned/machine-local; receipts and memory need history.
- **One workbench repo per project** — no home for cross-project memory; N backups; fragmented vault.
- **Workbench only for shared repos** — dual layouts forever; this codebase's history shows dual paths are where the bugs live.
- **Notion / cloud tools as the store** — not file-first; hostile to agents and to MC's watch-the-disk architecture.
- **Multi-repo issues** — would need multi-worktree Runs and multi-merge reporting; rejected as the PTY-glue class of complexity.

## Consequences

- Receipts land at `~/Workbench/<project>/completions/NN-slug.md` for workbench projects: **no Receipts riding worktree branches, and the stray-adoption machinery (issue 62) becomes legacy-layout-only.** The e2e harness keeps both fixtures (workbench + legacy).
- `ProjectView`'s `repoPath` identity is a breaking refactor across the registry, IPC contract, watchers, and ownership model.
- The afk-issue-runner skill gains: workbench resolution (prompt → registry → legacy), the `repo:` field (cwd = that repo), and CORE.md context injection.
- Parallel isolation keys on concurrency **per repo**: concurrent issues targeting different repos don't contend and need no mutual isolation.
- Workbench privacy is a standing requirement: Receipts and memory contain employer facts; the remote must be private, and the curator treats secret-shaped content as a defect.
