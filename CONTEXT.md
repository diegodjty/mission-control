# Mission Control

A local home for the entire `grill → prd → issues → afk` pipeline. It shows a structured **map** of an `issues/` backlog and hosts live, interactive Claude Code sessions (**panes**) that do the work — so you can start, watch, and steer the whole process from one screen instead of a scatter of terminals. It spans both *planning* and *execution*, via two purpose-built views.

## Language

**Mission Control**:
The app itself. A local (runs-on-your-machine) tool that combines a read-only backlog map with embedded interactive Claude Code sessions. Runs as **one backend** (one port, one state store, one coordinator) with **many windows** on top — like a code editor with one app and several project windows.
_Avoid_: dashboard (too narrow — it also controls), orchestrator (implies headless).

**Window**:
One view onto the single backend, scoped to one **Project**. Multiple windows run at once (billing in one, vapi in another) without a second backend — no port collisions, no double-managing a repo.

**Project**:
A first-class entry in Mission Control's registry — a repo path with its own backlog, pipeline stage, and Runs. The backend owns *many* Projects; each **Window** shows one.

**Map**:
The structured, birds-eye view of a backlog — issue statuses (open/wip/done), the dependency graph, git state, and completion blocks. Rendered from the **artifacts on disk**, never from a live agent stream.
_Avoid_: dashboard, board.

**Pane** (a.k.a. cockpit):
One embedded, fully-interactive Claude Code session — the same TUI you'd get in a terminal — rendered inside Mission Control. This is where work happens and where permission prompts are answered live.
_Avoid_: terminal (ambiguous), agent, worker.

**Run**:
One issue being worked in one **Pane** — a single fresh Claude Code session claiming and completing a single issue.
_Avoid_: job, task (task = the issue itself, not the act of working it).

**Artifacts**:
The on-disk files the **Map** reads: `issues/NN-slug.md` (status/depends_on frontmatter), `issues/CONFIG.md`, git history, and **Receipts** (the on-disk carrier of the completion blocks the afk-issue-runner emits).

**Execution view**:
The Mission Control surface for running a backlog — the **Map** plus parallel **Panes** plus the **Merge** action.

**Planning view**:
The Mission Control surface for the planning stages (`grill-with-docs`, `to-prd`, `to-issues`). Direction (not yet locked): a split screen with the interview conversation on one side and the documents it writes (`CONTEXT.md`, PRD, ADRs) rendering live on the other. Distinct from a raw **Pane** — planning is a conversation with live doc output, not a tiled terminal.

**Dispatcher**:
The foreground *conversational orchestrator* — a Claude session you talk to in Mission Control (as you would in a terminal), which spawns the worker Panes, ingests each **Completion block** as a Run finishes, synthesizes across Runs (progress, cross-Run patterns, doc-drift), and recommends/acts on next steps. It holds **only the summaries**, never a Run's implementation context — so it stays lean across a long drain the way a fresh-context-per-issue worker does. It replaces *watching every Pane* with *talking to one orchestrator*. Distinct from the **Run Coordinator** (pure, deterministic scheduling) and from a **Worker** (does one issue).
_Avoid_: coordinator (that's the deterministic scheduler), agent (too generic).

**Worker**:
A **Run**'s Pane session, seen from the **Dispatcher**'s perspective — a fresh Claude Code session that does exactly one issue and emits a **Completion block** as its result. The Dispatcher's workers.

**Completion block**:
The structured summary a **Worker** emits when its Run ends (what changed / try-it / verified / bookkeeping / doc-drift). Carried by a **Receipt** and fed to the **Dispatcher** (see the **Run log**). This — not the raw Pane scroll — is what the Dispatcher holds.

**Receipt** (ADR-0013):
The on-disk carrier of a **Completion block**: `issues/completions/NN-slug.md`, committed, one per issue (latest Run wins). YAML frontmatter declares the machine-facing facts (`issue`, `slug`, `outcome: completed | needs-verification | blocked`, `finished`); the body is the verbatim block. Written by the **Worker** at *every* exit — finish, HITL park, or blocked — per the afk-issue-runner skill (producer-owned contract). Receipts are the **sole capture input**: the live Pane scroll is never parsed (peek/debug only). Trust hierarchy: git/issue frontmatter is ground truth for *state*; the Receipt is ground truth for *narrative*. A Run that ends with no Receipt surfaces as one explicit passive note, never a scrape. Intended as the standard result-handoff pattern for future companion tools.
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

## Example dialogue

> **Dev:** "When I hit *drain* with 5 eligible issues, do I get 5 **Runs** at once?"
> **Domain expert:** "Up to the **max-concurrent** cap — say 3. Each **Run** gets a fresh **Pane**, so context stays clean per issue, but only 3 sessions are live at a time; the other 2 queue."
> **Dev:** "And the progress bars?"
> **Domain expert:** "Those are the **Map**, drawn from the issue files — not from the **Panes**. The **Panes** are the live terminals; the **Map** is the status picture."

## Flagged ambiguities

- "mission control" initially meant both "watch the process" and "run the process" — resolved: it does both, via two distinct surfaces (**Map** = watch, **Panes** = run).
- "terminal" was used for the live session — resolved to **Pane** to distinguish the rendered UI element from a raw OS terminal.

## Open (not yet resolved)

- Detailed design of the **Planning view** (split-screen interview + live docs) — direction set, specifics deferred.
- Portfolio overview **Window** (all Projects + stages on one page) — a later additive view, not v1.
- How the **Map** gets live updates — file-watch on `issues/` vs. polling. Implementation-level; defer to build-time.
- Build order: **Execution view** is the first slice; **Planning view** is a later slice.
- Tech stack for the shell (Next.js + node-pty/xterm.js is the leading candidate but unconfirmed).
