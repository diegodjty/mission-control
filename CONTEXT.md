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
One embedded, fully-interactive Claude Code session — the same TUI you'd get in a terminal — rendered inside Mission Control. The surface for *interactive* work: manual single Runs, Planning, Just talk, HITL verification, and take-overs of headless Runs. Drain Runs are headless by default and watched via **Feeds** (ADR-0001 amendment, 2026-07-17).
_Avoid_: terminal (ambiguous), agent, worker.

**Run**:
One issue being worked by one fresh Claude Code session claiming and completing a single issue. A drain Run executes **headless** and is watched through a **Feed**; a manual Run gets an interactive **Pane**.
_Avoid_: job, task (task = the issue itself, not the act of working it).

**Worker model tier** (issue 154, declare-don't-imply per ADR-0013):
The model a **drain** Worker spawns on, chosen by declaration — never runtime guessing. A project CONFIG `worker_model` frontmatter key sets the default (`sonnet` when unset); an issue's optional `model:` frontmatter (`haiku`|`sonnet`|`opus`|`fable`) overrides it for that issue. The drain injects `--model <id>` ahead of the Worker prompt; a failed attempt (blocked / verify-gate fail / no-Receipt death) is re-run one tier UP from a **fresh worktree**, capped at CONFIG `escalation_ceiling` (`opus` default) and 3 attempts. **Drain Runs only, with ONE interactive exception (issue 203)** — every interactive entry point (Simple issue, Quick fix, Grill/Planning, Just talk) inherits the interactive default model and is never tiered, *except* the manual single-issue **Run now**: clicking "▶ Run" on one issue from the Map opens a small model picker (the same `haiku`|`sonnet`|`opus`|`fable` vocabulary) before the Pane spawns, defaulting to the interactive default (confirming it reproduces the exact untiered spawn command; the chosen tier rides `RunTarget.model` into the same `resolveRunCommand` plumbing). Exists because a drain that inherited the expensive interactive default burned ~50% of the daily limit in two minutes (cost incident 2026-07-17).
_Avoid_: "the model" (ambiguous — the interactive default is separate; the only interactive entry point that tiers is the manual Run-now picker, issue 203).

**Worker effort tier** (issue 155, same declare-don't-imply mechanism):
The reasoning **effort** a **drain** Worker spawns on (`low`|`medium`|`high`|`xhigh`|`max`) — a second per-invocation cost lever beside the model, so a mechanical issue doesn't burn the deliberate, token-heavy reasoning the hard engine work needs. **Derived from the resolved tier by default** — `haiku`→`low`, `sonnet`→`medium`, `opus`/`fable`→`high` (the tier already encodes issue difficulty, so this needs no extra authoring). An issue's optional `effort:` frontmatter overrides the derivation for that issue, and a CONFIG `worker_effort` key sets a project-wide override; precedence is issue `effort:` → CONFIG `worker_effort` → derived-from-tier. The drain injects `--effort <level>` ahead of the Worker prompt, alongside `--model`. When escalation bumps the tier, effort **re-derives** for the new tier (a retry is both smarter and more deliberate) unless a per-issue `effort:` pins it. Same **drain Runs only** scope as the model tier — interactive entry points inherit the interactive default effort and are never tiered. The two top tiers derive `high`, never `xhigh`/`max`: those are reserved for an explicit override.
_Avoid_: conflating with the model tier — effort is orthogonal (a cheap model can run at high effort, and vice-versa).

**Feed**:
The read-only live view of a **headless Run**, rendered from its event stream (current activity, elapsed time, last assistant message). You *watch* a Feed; you *talk to* a **Pane**. The raw stream tail is retained for debug peeking only — Receipts remain the sole capture input (ADR-0013).
_Avoid_: Pane (interactive), terminal, log (the Run log is the Receipt feed, not this).

**Run timeout** (issue 141):
The kill timeout a **headless** drain Run is armed with — a project CONFIG `run_timeout` frontmatter key (minutes, default 30). Watched, never talked-to, a headless Run has nothing else stopping it from hanging forever; the Headless Session Manager arms a real kill timer at spawn and kills the child once it elapses. A killed Run lands in the SAME no-Receipt handling as any other genuinely-unknown death (conservative drain stop, a missing-Receipt note) — no new failure vocabulary — with the cause named "timeout" (vs. "crashed" for a Worker that exits non-zero on its own). A Receipt that lands before death still wins, exactly as ADR-0013 already promises.
_Avoid_: conflating with a user-initiated **stop** (no cause named) or a declared **blocked** park (a Receipt, not a kill).

**Run telemetry** (issue 143, ADR-0001 amendment):
Tokens, cost, and duration, stamped from a **headless Run**'s terminal result event into the MC-owned **Run-log** record and drain journal — never into the **Receipt** (producer-owned, untouched, ADR-0013). A **Pane Run** carries duration only, every token/cost field null — by design, not a gap. The drain journal's per-Run line gets a telemetry suffix and the entry gets a `## Totals` section summing across whatever mix of headless/Pane Runs it holds.
_Avoid_: conflating with the Receipt's own narrative fields (whatChanged/verified/etc.) — telemetry is numeric and MC-derived, never producer-written prose.

**Scheduled drain** (ADR-0024):
A **drain** set to start later, at a chosen wall-clock time, over a chosen **subset** of eligible issues — so work runs while the human is away ("overnight"). It is a *deferred press of the existing Drain control*, not a new engine: at fire time an **open Window's** timer calls the same start path the Drain button does. **One-shot** (fires once; forgotten if MC is quit before it fires — no persisted schedule, no recurrence). **Window-coupled** (a live renderer drives the loop, ADR-0022 — there is deliberately no headless daemon, so a quit app or a closed project Window means it simply does not run). **Scoped by selection** (default = all eligible, i.e. today's whole-backlog behavior; a selected issue whose dependency isn't `done` just stays blocked — the schedule never pulls unselected issues in). **Non-interactive** (any moment the manual Drain would pop a dialog — protected branch, detached HEAD, non-git workspace + cap>1, mid-merge, nothing eligible — the scheduled drain instead *skips and notifies* the reason; it never hangs on a prompt and never makes a git decision unwatched). While pending or running it arms `powerSaveBlocker('prevent-app-suspension')` so idle-sleep/App Nap can't freeze the loop, released the moment it ends. Its start, end, HITL parks, and skips are surfaced by the existing local macOS **notifications** (issue 138) — no remote/phone push; the morning review is the **Receipts** and **Cost** tabs (ADR-0023).
_Avoid_: "overnight daemon" / "background scheduler" (implies a headless, app-can-be-quit driver — deliberately NOT this); "recurring drain" (this is one-shot); conflating its selection with the concurrency **cap** (cap = how many at once; selection = which issues at all).

**Artifacts**:
The on-disk files the **Map** reads: `issues/NN-slug.md` (status/depends_on frontmatter), the project CONFIG, git history, and **Receipts** (the on-disk carrier of the completion blocks the afk-issue-runner emits). Pipeline artifacts live in the **Workbench** (ADR-0015); a legacy in-repo `issues/` layout remains supported (QA sandbox, external skill users).

**Workbench** (ADR-0015):
The ecosystem's data layer: ONE private git repo (`~/Workbench/`) holding every Project's pipeline artifacts (PRD, issues, Receipts, HUMAN-SETUP, CONFIG) and `memory/` (CORE.md — curated, capped, injected into every Worker/Just-talk/bare session — plus topics/ and journal/), a `registry.md` mapping repo paths → Projects, and reserved folders for future tools. Code-describing docs (CONTEXT.md, ADRs) stay with the code. MC auto-commits it per Run event; push is manual; single-machine by construction (two machines ⇒ design claim sync first). Since ADR-0023 the **primary lens is Mission Control itself** (the Review surfaces below render Receipts, cost, and docs in-app); an Obsidian vault at the Workbench root remains an **optional** external browser — no longer *the* lens, still never a dependency.
_Avoid_: vault (that's Obsidian's word for its viewer window, not the system).

**Review surfaces** (ADR-0023):
The in-app home for *understanding* the work (not just running it), all built on one shared **rich viewer** — MC's hand-rolled markdown renderer extended with lazy-loaded **mermaid** diagrams and hand-rolled **SVG** charts (no webview, no chart library). Three nav-rail tabs consume it: **Receipts** (browse finished Runs, each rendered with its completion prose + its "How it works" mermaid diagram — replaces the old inline Run-log strip), **Cost** (Run telemetry as charts — per-drain totals, per-issue bars, token breakdown, trend), and **Docs** (the code repo's ARCHITECTURE.md / CONTEXT.md / ADRs rendered with live diagrams). **Debrief** stays a **Pane** pointing at these tabs.
_Avoid_: "Run log" for the review surface (that inline strip is superseded by the Receipts tab); webview/embedded browser (MC renders natively).

**Execution view**:
The Mission Control surface for running a backlog — the **Map** plus parallel **Runs** (**Feeds** for headless drain Runs, **Panes** for interactive ones) plus the **Merge** action.

**Planning view** (v1 per ADR-0016):
The Mission Control surface for the planning stages: a normal **Pane** running `grill-with-docs`/`to-prd`/`to-issues` beside a live markdown preview of the documents as they are written (workbench PRD/issues + repo CONTEXT/ADRs, file-watched), with stage buttons launching each step. Deliberately thin — not a bespoke structured chat.

**Launcher** (ADR-0016, redefined **project-first** by ADR-0019):
The front door — the **home page** every empty **Window** shows: a chooser of **all registered Projects** rendered as cards (toggle to a dense list; the choice persists in `localStorage['mc.projectView']`, cards default). Each card shows the backlog line (open·wip·done), a "needs-you" **HITL** badge, liveness ("N running" or last-activity), and pipeline **stage**; a card's ⋯ menu carries *Open in new Window* / *Remove from list*. Clicking a card switches this **Window** in place to that Project's **Map** (via existing `switchProject`); the per-project entry verbs now live on the Map as **＋ Start something** — **Grill a feature** (→ **Planning view**) and **Simple issue** (→ one standalone issue). Only two actions are project-agnostic and stay on the home page: **New project** (scaffold + registry entry) and a quiet **Just talk** (warm bare **Pane**). The playbook as UI, now **noun-first**: pick the Project, then the tool asks what to do.
_Avoid_: dashboard (the **Map** is the dashboard); the verb-first "what are we doing?" front door (that was ADR-0016, superseded by ADR-0019).

**Inbox** (ADR-0016):
The cross-project attention surface: derived from lightly watching **every** `status: active` registry project's workbench artifacts — HITL parks awaiting sign-off, curator `CORE.proposed.md` proposals, blocked Runs, HUMAN-SETUP boxes gating issues — plus a since-last-seen journal briefing. Quiet text in the window; items click through to their project. The ecosystem hub: future tools surface here by writing workbench artifacts, no new UI channel per tool.

**OS notifications** (ADR-0016 amendment, issue 138): the Inbox is quiet *in the window*, but the **blocking-approval tier plus terminal drain moments** also fire a native OS notification so the human can walk away — an **HITL park**, a **blocked park**, a **merge conflict**, and the **drain stopping or finishing**. Nothing else ever notifies (routine flips, proposals, setup gates, new-repo candidates, the briefing, passive notes stay window-only — the ADR-0012 noise floor at OS level). The decision (tier filter + per-issue dedupe) is a **pure module** (`shared/attention-notifications`); a thin main-process adapter shows the `Notification` and, on click, focuses the Window and lands on that Project's attention surface. One ping per event, deduped so a re-scan never re-pings; pre-existing parks are seeded at launch, not re-announced. Fired from the single app-level attention watch (so N Windows never ping N times) plus the merge / drain-journal edges.

**Dispatcher** — *retired (ADR-0022, 2026-07-18)*:
The former foreground conversational orchestrator (a chat session you talked to during a drain). Retired: its premise ("talk to one orchestrator instead of watching N terminals") was met a different way — **Feeds** watch, **OS notifications** summon, the **Run log** narrates. A drain now drives the **Run Coordinator** directly and the **auto-merge lane** integrates; "ask the drain a question" is a **Just-talk** Pane (which hosts `/debrief`). Its repurposed pure modules survive renamed (merge classification → the lane; authority/noise tiers → notifications). No standing chat surface exists.
_Avoid_: reintroducing an orchestrator chat; that role is Map + Feeds + Run log + notifications now.
_Avoid_: coordinator (that's the deterministic scheduler), agent (too generic).

**Worker**:
A **Run**'s session — a fresh Claude Code session that does exactly one issue and emits a **Completion block** (via its **Receipt**) as its result. Headless during a drain (watched via a **Feed**), interactive for a manual Run (a **Pane**).

**Completion block**:
The structured summary a **Worker** emits when its Run ends (what changed / try-it / verified / bookkeeping / doc-drift / how-it-works diagram). Carried by a **Receipt** and read into the **Run log** — the source of the per-Run narrative and notifications. This, never the raw Pane/Feed scroll, is the captured result (ADR-0013).

**Receipt** (ADR-0013, location per ADR-0015):
The on-disk carrier of a **Completion block**: `~/Workbench/<project>/completions/NN-slug.md` (legacy layout: `issues/completions/` in-repo), committed, one per issue (latest Run wins). YAML frontmatter declares the machine-facing facts (`issue`, `slug`, `outcome: completed | needs-verification | blocked`, `finished`); the body is the verbatim block. Written by the **Worker** at *every* exit — finish, HITL park, or blocked — per the afk-issue-runner skill (producer-owned contract). Receipts are the **sole capture input**: the live Pane scroll is never parsed (peek/debug only). Trust hierarchy: git/issue frontmatter is ground truth for *state*; the Receipt is ground truth for *narrative*. A Run that ends with no Receipt surfaces as one explicit passive note, never a scrape. Intended as the standard result-handoff pattern for future companion tools.
_Avoid_: completion file, run report, capture (the thing captured is the block; the Receipt is the artifact).

**Guided QA** (ADR-0025, issues 196–201):
An interactive, structured alternative to the plain issue-156 checklist for walking a HITL issue's manual verification steps. A **`## QA Steps` block** — one **action**, one **expected** outcome, and an optional **command** per step, in a Receipt's `detail` (else the issue body) — parses deterministically into ordered steps; the detail panel renders them with a per-step **pass/fail verdict** and an optional note (a fail's note is "what I actually saw", feeding a prefilled failure-filing draft). The session's own verdict derives from its steps: all-pass → green, any fail → failed, otherwise in progress. State persists **only** as a durable **QA receipt** — one markdown file per QA pass under the project's Workbench `qa/` directory, append-only (re-QA after a fix writes pass N+1, never touching pass N) — so quitting and relaunching mid-session resumes exactly where the human left off, with no app-level (userData) state involved. **Coexists by mode** with the 156 checklist: a document with no `## QA Steps` block keeps the ephemeral 156 tick-store byte-for-byte unchanged; the two never share state. Display + copy only, same as the 156 checklist's command boundary — MC executes nothing during a Guided QA session.
_Avoid_: conflating with the 156 checklist's ephemeral userData tick-store (Guided QA's store is the durable `qa/` Receipt on disk, never userData); "QA Receipt" alone without "pass" (one issue's Guided QA history is many pass files, not one).

**Run log**:
The feed of **Completion blocks** read from **Receipts**, one card per Run. The lean, scannable record of a drain and the human's at-a-glance history; the source of the per-Run **narrative** and the **OS notifications** (issue 138) that replaced the retired Dispatcher's chat relay.

**Authority (silent-autonomy default)** — *re-homed from the Dispatcher (ADR-0022)*:
The drain acts **silently and autonomously by default**; interruptions are a small, explicit exception (ADR-0011). The tiers below now govern **OS notifications** (issue 138) and the **Run log**, not a chat surface. Three tiers:
- **Blocking approval** (must click before it proceeds) — the *entire* list is: (1) a **Merge that hits a conflict**, (2) **aborting/stopping a drain**, (3) a **HITL issue awaiting sign-off**. Nothing else blocks.
- **Run narrative** (a Run-log entry + an OS notification for the blocking cases, never a gate): a Run's Completion block as it finishes, an HITL park ("waiting for you"), drain stopped/halted, strays adopted, finished-without-receipt. The Run log is history; notifications (issue 138) are the summons surface.
- **Passive note** (history strip only): routine facts below narrative — debounced status refreshes, delivery phases, checkpoint bookkeeping.
- **Silent** — everything else; answerable on-demand ("what's happening?").
A **clean, conflict-free Merge auto-proceeds** (refines ADR-0002's "human-triggered" to *auto-on-clean, gate-on-conflict*), and **logging a follow-up issue** is a silent+passive action, not a gate.

**Noise floor & interaction (ADR-0012)**:
"If in doubt, stay silent." Empty/unclassifiable inputs are dropped (never a Run or note) — with ADR-0013, capture input is **Receipts** only. Doc-drift surfaces only on a real contradiction (per-issue now, not a cross-run consolidation — the latter retired with the Dispatcher, ADR-0022). Inferred/speculative signals must clear a high confidence bar. **Run narrative lands in the Run log; the blocking cases fire an OS notification (issue 138)** — routine status flips and speculative signals stay out of the notification surface. Backward status moves (finished→open) are debounced ≥1 reconcile checkpoint before surfacing.

## Relationships

- **Mission Control** shows one **Map** and hosts many **Panes**.
- A **Run** happens in exactly one **Pane**; each **Pane** is one fresh session for one issue (matches the `/clear`-per-issue habit).
- The **Map** reads **Artifacts**; **Panes** produce changes to **Artifacts** (issue status flips, code, completion blocks), which the **Map** then reflects.
- The **Launcher** (home) is the Project chooser in front of the **Map**; the per-project entry verbs (**＋ Start something**: **Grill a feature** / **Simple issue**) live on the **Map**, whose empty state *is* that chooser (ADR-0019).
- Concurrent **Runs** are capped by a **max-concurrent** setting.
- **Mission Control owns the isolation lifecycle:** a lone **Run** works on `main` (solo, no worktree); the moment there are 2+ concurrent **Runs**, it enables parallel mode and gives each **Run** its own **worktree**; the **auto-merge lane** integrates each finished branch as it completes (ADR-0021). An issue is startable only when its dependencies are `done` **and integrated** — a done-but-unmerged dependency holds dependents in a visible "waiting on merge of NN" (solo-chaining is retired).
- **The drain drives itself** (ADR-0022, retiring the Dispatcher): the drain loop calls the deterministic **Run Coordinator** (`planDrain`) directly and the **auto-merge lane** (ADR-0021) integrates finished branches. No orchestrator session is spawned. Auto on reversible mechanics, human-approved on scope (see **Authority**).
- **A drain's surfaces:** the **Map** (status), **Feeds** (live watch of headless Runs), the **Run log** (per-Run narrative from Receipts), and **OS notifications** (the three blocking summons). "Ask the drain a question" is a **Just-talk** Pane (reads the journal/Receipts, hosts `/debrief`) — not a standing chat.
- **Capture input** is Receipts + terminal lifecycle events (started/finished/blocked/stranded/needs-attention/finished-without-receipt), **never raw Pane/Feed output** (ADR-0013).

**Merge** (action):
Everyday integration belongs to the **auto-merge lane** (ADR-0021): finished, Receipt-backed `afk/NN-slug` branches merge continuously in **finish order** (via `afk-merge.sh`) whenever main is idle — a clean auto-merge is silent+passive; a conflict gates as a blocking approval and pauses the lane. The Map-level **Merge button** remains for the exceptions only: resolving/aborting a conflict, merging adopted strays (never auto-merged), and forcing a sweep.
_Avoid_: sync, integrate; "human-triggered" (that was pre-ADR-0021).

**Merge preview**:
The background-computed prediction of what the next merge would do, per finished-unmerged `afk/` branch. Simulated over the **full merge sequence in current merge order** (**finish order** — first finished, first merged, per ADR-0021), never pairwise-against-main: pairwise can badge branch 2-of-N "clean" and still conflict at merge time, which defeats the feature. The simulation **stops at the first predicted conflict** — later branches read "blocked behind NN", because a conflict pauses the **auto-merge lane**. Advisory to the human; the lane consults the verdict as its go/no-go (badges never reorder anything).
Read-only means: a preview never touches **refs, worktrees, or the index**; unreachable object-database writes (`merge-tree --write-tree` / `commit-tree` chaining, later gc-pruned) are acceptable by design. Requires git ≥ 2.38 (`merge-tree --write-tree`); on older git there are **no badges plus one passive note**, no fallback merge machinery.
The badge predicts **the outcome of pressing Merge, restricted to per-branch, stable facts**. Verdicts: `clean` / `conflicts (files…)` / `blocked behind NN` / `won't merge — adds install artifacts` / `recalculating`. The issue-98 artifact-hygiene refusal IS folded in (per-offender only — innocent siblings keep their real merge verdicts; the batch-level refusal stays a press-time message). NOT modeled: CHOKEPOINT union auto-resolution (badge is conservative on legacy hand-written confs) and transient repo states (dirty main, wrong branch — point-in-time facts, not branch properties).
**Staleness:** every preview is stamped with the (default-branch tip, ordered finished-branch tips) it was computed against; the existing ~1.5 s scan tick compares stamps — a mismatch flips affected badges to `recalculating` (never a stale verdict) and queues **one coalesced recompute per repo** through the per-repo serializer. A repo that is **mid-merge suspends its previews** ("merge in progress", not `recalculating`) until main is clean again.
**Scope (v1, ADR-0018):** finished-unmerged branches only (no wip early warnings); verdicts live in **main-process memory** and travel with the scan result — no disk artifact, no Workbench writes, and the Inbox is not a consumer; previews are advisory to the human and the go/no-go for the auto-merge lane (ADR-0021).
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

- **Merge preview** follow-ups: wip early-warning previews remain deferred (ADR-0018). Conflict-aware merge ordering and auto-rebase-after-each-merge are **mostly mooted by ADR-0021** (finish-order merging collapses the divergence window those existed to manage) — revisit only if conflict gates stay frequent after it lands.
- Detailed design of the **Planning view** (split-screen interview + live docs) — direction set, specifics deferred.
- Portfolio overview **Window** (all Projects + stages on one page) — partially delivered by the project-first **Launcher** (ADR-0019, the at-a-glance grid of cards with stage badges); a dedicated cross-project *analytics* Window remains a later additive view, not v1.
- How the **Map** gets live updates — file-watch on `issues/` vs. polling. Implementation-level; defer to build-time.
- Build order: **Execution view** is the first slice; **Planning view** is a later slice.
- Tech stack for the shell (Next.js + node-pty/xterm.js is the leading candidate but unconfirmed).
