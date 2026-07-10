# Mission Control

A local home for the entire `grill → prd → issues → afk` pipeline. It shows a structured **map** of an `issues/` backlog and hosts live, interactive Claude Code sessions (**panes**) that do the work — so you can start, watch, and steer the whole process from one screen instead of a scatter of terminals. It spans both *planning* and *execution*, via two purpose-built views.

## Language

**Mission Control**:
The app itself. A local (runs-on-your-machine) tool that combines a read-only backlog map with embedded interactive Claude Code sessions. Runs as **one backend** (one port, one state store, one coordinator) with **many windows** on top — like a code editor with one app and several project windows.
_Avoid_: dashboard (too narrow — it also controls), orchestrator (implies headless).

**Window**:
One view onto the single backend, scoped to one **Project**. Multiple windows run at once (billing in one, vapi in another) without a second backend — no port collisions, no double-managing a repo.

**Project** (redefined by ADR-0015, extended by ADR-0017):
A first-class entry in Mission Control's registry — a **Workbench** entry (backlog, Receipts, PRDs, memory) referencing **zero or more code repos** (`repos:` map + optional `default_repo` in its CONFIG) plus a **workspace root**. An issue targets exactly one repo via optional `repo:` frontmatter (omitted = default); cross-repo work is a `depends_on` chain, never one multi-repo issue. The backend owns *many* Projects; each **Window** shows one.
_Avoid_: "repo" as a synonym for Project — a Project may span several repos, or none yet.

**Repo-less project** (ADR-0017):
A Project created with **no repos** — just a name and a **workspace root** — so planning (grill → PRD → issues, all Workbench-only) can start before any code exists. The **drain** creates the codebases: a **no-repo issue** scaffolds a repo, which **self-heals** into the registry. `repo:` frontmatter resolves only at run time, so an issue may name `repo: api` before `api` exists, provided it `depends_on` the issue that creates it.

**Workspace root** (ADR-0017):
The directory where a Project's **code** will live (default `~/Developer/<name>/`). Distinct from the **Workbench entry** (artifacts) and from any **repo**. A **no-repo issue** runs with its cwd here — where a scaffold (`mkdir api && git init && npm create`) naturally works. MC watches it: a new git repo appearing under it surfaces in the **Inbox** to register (never silent). As an isolation key it **cannot cut worktrees**, so no-repo issues serialize solo against each other while running in parallel with repo-targeted issues.
_Avoid_: conflating with the **Workbench** dir (`git init` there would nest repos in the shared artifacts repo) or with a **repo**.

**Map**:
The structured, birds-eye view of a backlog — issue statuses (open/wip/done), the dependency graph, git state, and completion blocks. Rendered from the **artifacts on disk**, never from a live agent stream.
Exception (issue 89): issue FILES only — the detail panel can edit (parser-validated, saved verbatim) or delete (never `wip`) an issue file; everything else the Map shows stays read-only.
_Avoid_: dashboard, board.

**Pane** (a.k.a. cockpit):
One embedded, fully-interactive Claude Code session — the same TUI you'd get in a terminal — rendered inside Mission Control. This is where work happens and where permission prompts are answered live.
_Avoid_: terminal (ambiguous), agent, worker.

**Run**:
One issue being worked in one **Pane** — a single fresh Claude Code session claiming and completing a single issue.
_Avoid_: job, task (task = the issue itself, not the act of working it).

**Artifacts**:
The on-disk files the **Map** reads: `issues/NN-slug.md` (status/depends_on frontmatter), the project CONFIG, git history, and **Receipts** (the on-disk carrier of the completion blocks the afk-issue-runner emits). Pipeline artifacts live in the **Workbench** (ADR-0015); a legacy in-repo `issues/` layout remains supported (QA sandbox, external skill users).

**Workbench** (ADR-0015):
The ecosystem's data layer: ONE private git repo (`~/Workbench/`) holding every Project's pipeline artifacts (PRD, issues, Receipts, HUMAN-SETUP, CONFIG) and `memory/` (CORE.md — curated, capped, injected into every Worker/Dispatcher/bare session — plus topics/ and journal/), a `registry.md` mapping repo paths → Projects, and reserved folders for future tools. Code-describing docs (CONTEXT.md, ADRs) stay with the code. MC auto-commits it per Run event; push is manual; single-machine by construction (two machines ⇒ design claim sync first). An Obsidian vault at its root is the human browsing lens — **a lens, never a dependency**.
_Avoid_: vault (that's Obsidian's word for its viewer window, not the system).

**Execution view**:
The Mission Control surface for running a backlog — the **Map** plus parallel **Panes** plus the **Merge** action.

**Planning view** (v1 per ADR-0016):
The Mission Control surface for the planning stages: a normal **Pane** running `grill-with-docs`/`to-prd`/`to-issues` beside a live markdown preview of the documents as they are written (workbench PRD/issues + repo CONTEXT/ADRs, file-watched), with stage buttons launching each step. Deliberately thin — not a bespoke structured chat.

**Launcher** (ADR-0016, redefined **project-first** by ADR-0019):
The front door — the **home page** every empty **Window** shows: a chooser of **all registered Projects** rendered as cards (toggle to a dense list; the choice persists in `localStorage['mc.projectView']`, cards default). Each card shows the backlog line (open·wip·done), a "needs-you" **HITL** badge, liveness ("N running" or last-activity), and pipeline **stage**; a card's ⋯ menu carries *Open in new Window* / *Remove from list*. Clicking a card switches this **Window** in place to that Project's **Map** (via existing `switchProject`); the per-project entry verbs now live on the Map as **＋ Start something** — **Grill a feature** (→ **Planning view**) and **Simple issue** (→ one standalone issue). Only two actions are project-agnostic and stay on the home page: **New project** (scaffold + registry entry) and a quiet **Just talk** (warm bare **Pane**). The playbook as UI, now **noun-first**: pick the Project, then the tool asks what to do.
_Avoid_: dashboard (the **Map** is the dashboard); the verb-first "what are we doing?" front door (that was ADR-0016, superseded by ADR-0019).

**Inbox** (ADR-0016):
The cross-project attention surface: derived from lightly watching **every** `status: active` registry project's workbench artifacts — HITL parks awaiting sign-off, curator `CORE.proposed.md` proposals, blocked Runs, HUMAN-SETUP boxes gating issues — plus a since-last-seen journal briefing. Quiet text, never notifications; items click through to their project. The ecosystem hub: future tools surface here by writing workbench artifacts, no new UI channel per tool.

**Dispatcher**:
The foreground *conversational orchestrator* — a Claude session you talk to in Mission Control (as you would in a terminal), which spawns the worker Panes, ingests each **Completion block** as a Run finishes, synthesizes across Runs (progress, cross-Run patterns, doc-drift), and recommends/acts on next steps. It holds **only the summaries**, never a Run's implementation context — so it stays lean across a long drain the way a fresh-context-per-issue worker does. It replaces *watching every Pane* with *talking to one orchestrator*. Distinct from the **Run Coordinator** (pure, deterministic scheduling) and from a **Worker** (does one issue).
_Avoid_: coordinator (that's the deterministic scheduler), agent (too generic).

**Worker**:
A **Run**'s Pane session, seen from the **Dispatcher**'s perspective — a fresh Claude Code session that does exactly one issue and emits a **Completion block** as its result. The Dispatcher's workers.

**Completion block**:
The structured summary a **Worker** emits when its Run ends (what changed / try-it / verified / bookkeeping / doc-drift). Carried by a **Receipt** and fed to the **Dispatcher** (see the **Run log**). This — not the raw Pane scroll — is what the Dispatcher holds.

**Receipt** (ADR-0013, location per ADR-0015):
The on-disk carrier of a **Completion block**: `~/Workbench/<project>/completions/NN-slug.md` (legacy layout: `issues/completions/` in-repo), committed, one per issue (latest Run wins). YAML frontmatter declares the machine-facing facts (`issue`, `slug`, `outcome: completed | needs-verification | blocked`, `finished`); the body is the verbatim block. Written by the **Worker** at *every* exit — finish, HITL park, or blocked — per the afk-issue-runner skill (producer-owned contract). Receipts are the **sole capture input**: the live Pane scroll is never parsed (peek/debug only). Trust hierarchy: git/issue frontmatter is ground truth for *state*; the Receipt is ground truth for *narrative*. A Run that ends with no Receipt surfaces as one explicit passive note, never a scrape. Intended as the standard result-handoff pattern for future companion tools.
_Avoid_: completion file, run report, capture (the thing captured is the block; the Receipt is the artifact).

**Run log**:
The feed of **Completion blocks** read from **Receipts**, one card per Run. The lean, scannable record of a drain; the Dispatcher's input and the human's at-a-glance history.

**Dispatcher authority (silent-autonomy default)**:
The Dispatcher acts **silently and autonomously by default**; interruptions are a small, explicit exception (ADR-0011, refining ADR-0007). Three tiers:
- **Blocking approval** (must click before it proceeds) — the *entire* list is: (1) a **Merge that hits a conflict**, (2) **aborting/stopping a drain**, (3) a **HITL issue awaiting sign-off**. Nothing else blocks.
- **Run narrative** (ADR-0014 — a message in the Dispatcher *conversation*, never a gate): a Run's Completion block as it finishes, an HITL park ("waiting for you"), drain stopped/halted, strays adopted, finished-without-receipt. "The chat" means the embedded claude session itself; the activity strip is history, not the notification surface.
- **Passive note** (history strip only): routine facts below narrative — debounced status refreshes, delivery phases, checkpoint bookkeeping.
- **Silent** — everything else; answerable on-demand ("what's happening?").
A **clean, conflict-free Merge auto-proceeds** (refines ADR-0002's "human-triggered" to *auto-on-clean, gate-on-conflict*), and **logging a follow-up issue** is a silent+passive action, not a gate.

**Noise floor & interaction (ADR-0012)**:
"If in doubt, stay silent." Empty/unclassifiable inputs are dropped (never a Run or note) — with ADR-0013, capture input is **Receipts** only, so the boot-screen class is gone by construction; doc-drift surfaces only on a real contradiction (not "none"); cross-run consolidation is a rare, deduped **passive note** (never a per-tick proposal). Inferred/speculative signals must clear a high confidence bar. **Run narrative lands in the Dispatcher conversation as messages (ADR-0014)**; routine status flips and speculative signals stay out of it (history strip only). One serialized queue; no injection while the user types. Backward status moves (finished→open) are debounced ≥1 reconcile checkpoint before surfacing.

## Relationships

- **Mission Control** shows one **Map** and hosts many **Panes**.
- A **Run** happens in exactly one **Pane**; each **Pane** is one fresh session for one issue (matches the `/clear`-per-issue habit).
- The **Map** reads **Artifacts**; **Panes** produce changes to **Artifacts** (issue status flips, code, completion blocks), which the **Map** then reflects.
- The **Launcher** (home) is the Project chooser in front of the **Map**; the per-project entry verbs (**＋ Start something**: **Grill a feature** / **Simple issue**) live on the **Map**, whose empty state *is* that chooser (ADR-0019).
- Concurrent **Runs** are capped by a **max-concurrent** setting.
- **Mission Control owns the isolation lifecycle:** a lone **Run** works on `main` (solo, no worktree); the moment there are 2+ concurrent **Runs**, it enables parallel mode and gives each **Run** its own **worktree**, then offers a **Merge** action once they finish.
- The **Dispatcher** drives **Workers** (Runs) via the deterministic **Run Coordinator** for scheduling; it consumes **Completion blocks** (the **Run log**), not raw Pane output. Auto on reversible mechanics, human-approved on scope (see **Dispatcher authority**).
- **Dispatcher input contract:** a one-time seed (backlog + PRD/CONTEXT) + a live stream of **{Completion blocks read from Receipts, terminal lifecycle events (started/finished/blocked/stranded/needs-attention/finished-without-receipt), doc-drift flags}** — and **never raw Pane output**. Lifecycle events let it react mid-drain (e.g. "05 stranded — discard and continue?") without ingesting any implementation transcript.
- **Dispatcher lifecycle:** **per-Project, on-demand** — spun up when a drain starts (or when explicitly opened), lives for that drain/work session, dismissable; not an always-on daemon. One Dispatcher per Project, hosted by the Window that owns it.
- **Dispatcher is the layer behind Drain:** starting a drain starts a Dispatcher session that drives the **Run Coordinator** and spawns worker Panes. A **single manual Run stays bare** (just its one Pane, no Dispatcher) — the Dispatcher earns its place only for multi-issue/drain work.
- **Dispatcher UI:** a **Dispatcher chat panel** (you converse with it) beside the **Map**, with the **Run log** as a feed of Completion-block cards; worker Panes are one click away to peek. "Talk to one orchestrator" instead of "watch N terminals."

**Merge** (action):
A Map-level button that appears when parallel **Runs** complete; it integrates their `afk/NN-slug` branches (via `afk-merge.sh`) and reports any conflicts. Human-triggered, never automatic.
_Avoid_: sync, integrate.

**Merge preview**:
The background-computed prediction of what pressing **Merge** now would do, per finished-unmerged `afk/` branch. Simulated over the **full merge sequence in current merge order** (ascending issue id — the order `mergeReadiness` already fixes), never pairwise-against-main: pairwise can badge branch 2-of-N "clean" and still conflict at press time, which defeats the feature. The simulation **stops at the first predicted conflict** — later branches read "blocked behind NN", because that is what `afk-merge.sh` actually does. Purely advisory: the Merge and Abort affordances are unchanged.
Read-only means: a preview never touches **refs, worktrees, or the index**; unreachable object-database writes (`merge-tree --write-tree` / `commit-tree` chaining, later gc-pruned) are acceptable by design. Requires git ≥ 2.38 (`merge-tree --write-tree`); on older git there are **no badges plus one passive note**, no fallback merge machinery.
The badge predicts **the outcome of pressing Merge, restricted to per-branch, stable facts**. Verdicts: `clean` / `conflicts (files…)` / `blocked behind NN` / `won't merge — adds install artifacts` / `recalculating`. The issue-98 artifact-hygiene refusal IS folded in (per-offender only — innocent siblings keep their real merge verdicts; the batch-level refusal stays a press-time message). NOT modeled: CHOKEPOINT union auto-resolution (badge is conservative on legacy hand-written confs) and transient repo states (dirty main, wrong branch — point-in-time facts, not branch properties).
**Staleness:** every preview is stamped with the (default-branch tip, ordered finished-branch tips) it was computed against; the existing ~1.5 s scan tick compares stamps — a mismatch flips affected badges to `recalculating` (never a stale verdict) and queues **one coalesced recompute per repo** through the per-repo serializer. A repo that is **mid-merge suspends its previews** ("merge in progress", not `recalculating`) until main is clean again.
**Scope (v1, ADR-0018):** finished-unmerged branches only (no wip early warnings); verdicts live in **main-process memory** and travel with the scan result — no disk artifact, no Workbench writes, and the Dispatcher/Inbox are not consumers; previews never gate or reorder the Merge.
_Avoid_: dry-run (`afk-merge.sh --dry-run` does not detect conflicts), merge check.

## Example dialogue

> **Dev:** "When I hit *drain* with 5 eligible issues, do I get 5 **Runs** at once?"
> **Domain expert:** "Up to the **max-concurrent** cap — say 3. Each **Run** gets a fresh **Pane**, so context stays clean per issue, but only 3 sessions are live at a time; the other 2 queue."
> **Dev:** "And the progress bars?"
> **Domain expert:** "Those are the **Map**, drawn from the issue files — not from the **Panes**. The **Panes** are the live terminals; the **Map** is the status picture."

## Flagged ambiguities

- "mission control" initially meant both "watch the process" and "run the process" — resolved: it does both, via two distinct surfaces (**Map** = watch, **Panes** = run).
- "terminal" was used for the live session — resolved to **Pane** to distinguish the rendered UI element from a raw OS terminal.
- The **Launcher** was **verb-first** ("what are we doing?" → pick an action, Project came along) — resolved to **noun-first** (ADR-0019): the home page is a Project chooser; the verbs (Grill a feature / Simple issue) moved onto the **Map**. Leading with the Project matches the common case — returning to work already in flight — which the verb prompt ignored.

## Open (not yet resolved)

- **Merge preview** follow-ups, deliberately deferred by ADR-0018: wip early-warning previews, auto-rebase of finished branches after each merge (needs its own grill — history rewrite on branches Receipts reference), and conflict-aware merge ordering (the sequence simulation already produces the data).
- Detailed design of the **Planning view** (split-screen interview + live docs) — direction set, specifics deferred.
- Portfolio overview **Window** (all Projects + stages on one page) — partially delivered by the project-first **Launcher** (ADR-0019, the at-a-glance grid of cards with stage badges); a dedicated cross-project *analytics* Window remains a later additive view, not v1.
- How the **Map** gets live updates — file-watch on `issues/` vs. polling. Implementation-level; defer to build-time.
- Build order: **Execution view** is the first slice; **Planning view** is a later slice.
- Tech stack for the shell (Next.js + node-pty/xterm.js is the leading candidate but unconfirmed).
