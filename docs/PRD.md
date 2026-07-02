# PRD — Mission Control

*Parent for the `/to-issues` batch. Vocabulary per [CONTEXT.md](./../CONTEXT.md); decisions per [docs/adr/0001–0005](./adr/).*

## Problem Statement

Diego runs the whole `grill → to-prd → to-issues → afk` pipeline by hand across a scatter of terminals. Working an issue backlog means firing `/afk-issue-runner` sessions one at a time, `/clear`-ing between each to keep context fresh, and mentally tracking what's `open`/`wip`/`done`, what's blocked on what, whether parallel runs have collided, and whether finished work still needs merging. The friction is real and recurring: *"do i need to merge or not?"*, issue statuses drifting from reality, "done" work that turns out broken, and losing the mental model of a feature after a burst of autonomous runs. There's no single place to **start** the process, **watch** it progress, and **steer** it — and juggling multiple projects means juggling multiple terminals and remembering which is which.

## Solution

**Mission Control** — a local Electron desktop app that is the single home for the whole pipeline. It shows a structured **Map** of a Project's backlog (statuses, dependency graph, what's blocked, completion blocks) drawn from the files on disk, and hosts the work itself as live **Panes** — real, interactive Claude Code sessions embedded in the app, one fresh session per issue. You start a Run (or drain the backlog) from the Map; each Run opens a Pane you can watch and talk to; permission prompts and "blocked, need you" moments happen live in the Pane. Mission Control owns the isolation lifecycle — a lone Run works on `main`, concurrent Runs each get a worktree and a **Merge** button appears when they finish. One backend coordinates everything; each Project opens in its own Window, so you can work billing-platform and vapi side by side without collisions.

## User Stories

**Seeing the backlog (the Map)**
1. As a developer, I want to open a Project and see every issue with its status (open/wip/done), so that I know the state of the backlog at a glance.
2. As a developer, I want to see the dependency graph between issues, so that I understand what unblocks what.
3. As a developer, I want blocked issues shown as blocked and *why* (which dependency isn't done), so that I don't wait on the wrong thing.
4. As a developer, I want to see which issues are HITL, so that I know which ones will need me.
5. As a developer, I want the Map to update when the underlying issue files change, so that it reflects reality without a manual refresh.
6. As a developer, I want to read an issue's full body from the Map, so that I don't have to open the file separately.
7. As a developer, I want to see each completed issue's completion block (what changed + try-it steps), so that I can review and manually test without hunting.
8. As a developer, I want to see which issue is in-batch (matches the active PRD) vs. standalone, so that I understand the shape of the current sweep.

**Running issues (Panes)**
9. As a developer, I want to start a Run on an eligible issue from the Map, so that I don't drop to a terminal to fire `/afk-issue-runner`.
10. As a developer, I want each Run to open as a live, interactive Pane, so that I can watch what the agent is doing in real time.
11. As a developer, I want to type into a Pane, so that I can answer the agent's questions and steer it exactly like a normal session.
12. As a developer, I want each Run to be a fresh session, so that context stays clean per issue (my `/clear` habit, automated).
13. As a developer, I want permission prompts to appear in the Pane, so that risky actions pause and ask me instead of running unattended.
14. As a developer, I want to stop a Run, so that I can kill a session that's going the wrong way.
15. As a developer, I want to see when a Run has finished (the issue reached done, or stopped blocked), so that I know when to look.
16. As a developer, I want a Run that stops "blocked" to surface its reason on the Map, so that I can act on it.

**Draining and concurrency**
17. As a developer, I want to drain the backlog, so that Mission Control works eligible issues without me firing each one.
18. As a developer, I want a max-concurrent cap on Runs, so that I control how many sessions run at once.
19. As a developer, I want concurrent Runs to each open in their own Pane, so that I can watch several at once.
20. As a developer, I want Runs beyond the cap to queue and start as slots free, so that the cap is enforced automatically.
21. As a developer, I want the drain to stop when no eligible issue remains or a Run reports a blocker, so that it doesn't spin uselessly.

**Isolation and merge**
22. As a developer, I want a lone Run to work directly on `main`, so that the simple case has no worktree overhead.
23. As a developer, I want Mission Control to auto-enable parallel mode and give each Run its own worktree when 2+ run concurrently, so that parallel sessions don't collide on the shared checkout.
24. As a developer, I want a **Merge** button to appear on the Map when parallel Runs finish, so that integrating their branches is one obvious action, not an open question.
25. As a developer, I want the Merge to report conflicts clearly, so that I know when I need to intervene.
26. As a developer, I want the Merge to be human-triggered, never automatic, so that a costly integration is always my call.
27. As a developer, I want worktrees cleaned up after a successful merge, so that the repo doesn't accumulate cruft.

**Multiple projects, multiple windows**
28. As a developer, I want to register multiple Projects (repo paths) in Mission Control, so that all my work lives in one tool.
29. As a developer, I want each Project to open in its own Window, so that I can work on more than one at a time.
30. As a developer, I want all Windows backed by one backend, so that opening several projects doesn't cause port collisions or double-manage a repo.
31. As a developer, I want to switch the active Project within a Window, so that I can move between backlogs without launching anything.
32. As a developer, I want Mission Control to prevent two Windows from managing the same repo at once, so that worktrees/merges can't stomp each other.

**Planning (later slice)**
33. As a developer, I want to start a planning session (`grill-with-docs`) from Mission Control, so that the front of the pipeline lives here too.
34. As a developer, I want a planning interface that shows the interview alongside the documents it writes (CONTEXT.md, PRD, ADRs) rendering live, so that I watch decisions crystallize as I answer.
35. As a developer, I want to move a Project from planning into an executable backlog within the app, so that the whole pipeline is continuous.

**Portfolio (later slice)**
36. As a developer, I want a portfolio overview of all Projects and their pipeline stages, so that I can see everything in flight on one screen.

## Implementation Decisions

**Architecture (see ADRs):**
- **Electron desktop app** (ADR-0005). The **main process** (Node/TypeScript) is the single backend/coordinator (ADR-0004): it owns PTY sessions, state, and the isolation/merge lifecycle. Each **Project Window** is a **renderer** running a **React + TypeScript** UI. Main ↔ renderer over Electron **IPC**.
- **Embedded interactive sessions, not headless `claude -p`** (ADR-0001). Panes are real interactive Claude Code sessions via **node-pty** (spawn) ↔ **xterm.js** (render). The Map's structured data comes from the **Artifacts on disk**, not from a parsed agent stream.
- **Hybrid permissions** — inherited free from interactive Claude Code: routine steps run, risky ones surface a prompt in the Pane.
- **One backend, many Windows** (ADR-0004); **one fresh Pane per issue**, capped concurrency.
- **Mission Control owns isolation** (ADR-0002): solo Run → `main`; 2+ concurrent → parallel mode + per-Run worktree + human-triggered Merge via `afk-merge.sh`.

**Modules — pure/deep (unit-tested):**
- **Backlog Model** — parses `issues/*.md` + `CONFIG.md` → structured backlog: per-issue status, dependency graph, eligibility, blocked-by chains, HITL flags, in-batch vs. standalone. Mirrors the afk-issue-runner pick logic. Interface: `(files) → BacklogState`.
- **Run Coordinator** — `(BacklogState, maxConcurrent, activeRuns) → { startable, queued, runStates }`. Owns the solo-vs-parallel decision and the drain-stop condition. A pure state machine.
- **Project Registry** — the set of Projects (repo path + pipeline stage + Runs) and stage transitions (planning → backlog → executing → merge/QA). Enforces "no two Windows own the same repo."
- **Isolation Policy** — pure decisions of ADR-0002: given the set of active Runs, decide worktree-vs-`main` and whether a Merge is offered. Emits commands for the Git/Worktree Adapter to execute.

**Modules — adapters/shallow (integration or manual verification):**
- **PTY Session Manager** — node-pty spawn/kill/exit-detection, byte piping to renderer over IPC.
- **Git/Worktree Adapter** — executes worktree create/remove, `issues/.afk-parallel` toggling, and `afk-merge.sh` invocations that the Isolation Policy decides.
- **IPC Contract** — typed message set between main and renderers.

**UI (renderer):**
- **Map view** (dependency graph, status cards, completion blocks, Merge button), **Pane view** (xterm.js host). **Planning view** (split-screen interview + live docs) and **Portfolio view** are later slices.

## Testing Decisions

- **A good test asserts external behavior, not implementation.** Feed a module its inputs and assert its outputs — never reach into internals. The four pure modules were designed with file/data-in, structure-out interfaces precisely so they're testable without Electron, git, or a live agent.
- **Unit-tested modules: Backlog Model, Run Coordinator, Project Registry, Isolation Policy** (the four pure ones — confirmed with the developer). Examples of the behavior to cover:
  - *Backlog Model:* a fixture set of `issues/*.md` → correct statuses, dependency edges, and blocked-by reasons; HITL detection via frontmatter and `(HITL)` heading; in-batch vs. standalone classification against a CONFIG PRD.
  - *Run Coordinator:* given a backlog + cap, the right issues are startable, the queue respects the cap, and the drain-stop condition fires when nothing's eligible.
  - *Project Registry:* stage transitions are legal; registering a second Window on an already-owned repo is rejected.
  - *Isolation Policy:* 1 active Run → work on `main`, no worktree; a 2nd concurrent Run → parallel mode + worktree for each; Merge offered only when parallel Runs have finished.
- **Adapters (PTY, Git/Worktree) and the IPC Contract** are verified by **integration/manual runs**, not unit tests — they're thin I/O edges.
- **UI (Map, Pane) is verified by `type-check` + the batch QA walkthrough**, matching the developer's standing convention (no component-test harness; visual/routing changes verify via type-check + acceptance criteria).
- **Test framework:** the Node/TS default for the chosen backend runtime; do not introduce a second framework.

## Out of Scope

- **Planning view** detailed design and **Portfolio view** — acknowledged as later slices, not v1. v1 is the Execution view (Map + Panes + Merge) end-to-end.
- **Headless/unattended operation** — Mission Control is interactive by design; there is no fire-and-forget mode that runs without a human reachable in the Pane.
- **Packaging, code-signing, auto-update, distribution** — personal local tool; not needed for v1.
- **Remote/hosted access** — Panes run local `claude` with local auth and cwd; the app is local-only.
- **Replacing the skills** — Mission Control *drives* `afk-issue-runner`, `grill-with-docs`, `to-prd`, `to-issues`; it does not reimplement their logic.
- **Cross-machine sync of Project state.**

## Further Notes

- **Live-update mechanism for the Map** (file-watch on `issues/` vs. polling) is an open build-time probe — behavior is fixed (the Map reflects disk), the mechanism is not yet chosen.
- **Electron's main/renderer/IPC split is the one real learning curve** — the PTY spawning, state, Isolation Policy, and Git adapter live in **main**; UI lives in **renderers**. Keep pure modules importable by main and free of Electron APIs so they stay unit-testable.
- **Tracer-bullet first slice** (for `/to-issues`): a single Pane running a single issue end-to-end in the Execution view — main-process PTY spawn → xterm.js render → issue reaches `done` → Map reflects it. Everything else (dependency graph rendering, drain, concurrency, worktrees, Merge) layers onto that spine.
- **Prior art to lean on:** VS Code is Electron + node-pty + xterm.js — the exact terminal-embedding stack; consult its integrated-terminal approach when wiring the PTY↔xterm bridge.
