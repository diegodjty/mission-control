# Session handoff — Mission Control (and the setup work that spawned it)

Paste this into a new session as context. It's written for a fresh model that has none of this history.

---

## 0. TL;DR of where we are RIGHT NOW

We're deep in building **Mission Control**, a local Electron app at `/Users/devteam/Developer/mission-control`. Its **execution view** works; we're finishing the **Dispatcher** (a conversational orchestrator). The Dispatcher is functionally built but the user has been live-testing it and catching real bugs.

**The immediate open decision** (the user asked for this summary instead of answering): the Dispatcher's completion-block **capture scrapes the live `claude` TUI's raw PTY scroll**, so it grabs boot-screen banners ("✳ Claude Code / Welcome back Diego / Run /init…") instead of the Worker's actual completion block. This one bug causes (a) ~15 "unclassifiable" boot-screen entries polluting the Dispatcher's status, and (b) HITL issues never triggering their "waiting for you" notification (05's block is never really captured). Ground-truth status (done/open) is correct because it comes from git/afk-scan, not these captures.

I proposed three paths and recommended **option 1**:
1. **`/grill-with-docs` the capture-handoff redesign** — have the afk-issue-runner Worker write its completion block to a **file** MC reads, instead of MC scraping the TUI. Touches the global skill + MC. (recommended)
2. Just log+fix with the file-handoff approach + immediately stop injecting boot-screen chrome into status.
3. Pause the Dispatcher here (execution view + ground-truth status all work; only the narration/notify layer is affected).

**Start by resolving that.**

---

## 1. Who the user is + how they work (important)

- Diego (diegot@answeringlegal.com). Fast typist, heavy typos — read through them, don't nitpick.
- **Wants pushback and recommendations, not compliance.** Give a recommendation, argue for it, don't just do what's said if it's wrong.
- **Answer questions; don't take actions until told.** End substantial/autonomous work with **"what changed" + "how to try it yourself"** in plain language.
- Prod-replicated DBs are **read-only**; data claims need **proof (runnable queries)**. Secrets never pasted in chat — name the env var.
- Prefers **free/self-hosted over paid vendors**. Node 22 via nvm.
- His whole dev workflow is a pipeline: **`/grill-with-docs` → `/to-prd` → `/to-issues` → `/afk-issue-runner` (drain)**. He values fresh context per issue (his `/clear`-between-issues ritual), which we automated as the **dispatcher drain** (below).
- Global `~/.claude/CLAUDE.md` now encodes these preferences. Global `~/.claude/settings.json` has `permissions.defaultMode: "auto"` (auto-approve with safety classifier) — set this session so MC-spawned `claude` sessions don't block on prompts.

## 2. Environment & key locations

- **Mission Control app:** `/Users/devteam/Developer/mission-control` — git repo, work on `main`, committed per-issue. Electron + React + TypeScript + electron-vite; **node-pty + xterm.js** for embedded terminals (the VS Code stack). ~605 vitest tests currently, all green.
  - Commands (ALWAYS prefix node/npm with nvm): `source ~/.nvm/nvm.sh && nvm use 22` then `npm run test` / `npm run type-check` / `npm run build` / `npm run dev`.
  - node-pty is rebuilt for Electron via a `postinstall` (`electron-rebuild -f -w node-pty`) — don't remove it.
- **QA sandbox:** `/Users/devteam/Developer/mc-qa-sandbox/repo-a` (and `repo-b`) — throwaway git repos for driving live walkthroughs. `repo-a` has issues 01–07 (01 `foundation` seeded done; 05 `manual-check` is **HITL** `hitl: true`; 03 `blocked` depends on 02; 04/06/07 independent). **Reset pattern** (used constantly): remove afk worktrees, `git worktree prune`, delete `afk/*` branches, `git reset --hard <root>`, `git clean -fdx`, `rm -rf ../.afk-worktrees`.
- **Reflection note:** `/Users/devteam/reflection-note.md` — the setup meta-analysis (see §5).
- **Session storage** (where this convo lives): `~/.claude/projects/-Users-devteam/*.jsonl`.

## 3. The AFK drain mechanics (how we do the work — reuse this)

The user's skills live in `~/.claude/skills/` (afk-issue-runner, grill-with-docs, to-prd, to-issues, grill-me, tdd, diagnose, etc.). We UPGRADED several this session (verify gate, user-facing completion block, drain mode, HUMAN-SETUP emission, right-size check, fatigue exit, doc-drift rule, "don't hardcode sibling issue state in test steps").

**Drain = dispatcher pattern (I am the dispatcher):** for each eligible issue I spawn **one fresh `general-purpose` subagent** (synchronous, one at a time). Each subagent: reads `~/.claude/skills/afk-issue-runner/SKILL.md` + the project's `issues/CONFIG.md`, claims exactly ONE issue (flips `open`→`wip`), works it **solo on `main`** (no worktree), leaves changes **uncommitted**, and returns its **completion block verbatim** as its final message. Then I **commit a clean checkpoint** (`git commit` per issue) and relay a tight summary. This keeps my own context lean (I hold only summaries) — it's the automated version of the user's `/clear` ritual.

**The verify gate (central principle):** a subagent marks an issue `done` ONLY if it genuinely verified it. **Pure logic** → unit-tested → `done`. **GUI / live-LLM / interactive surfaces** that can't be verified headlessly → left **`wip`** with a "Ready for manual verification" block for the *human* to drive. This is why the human walkthroughs (issues 10/40/51) keep catching real bugs no test suite would. **This gate has repeatedly paid off — trust it; don't rubber-stamp GUI work as done.**

**Issue files:** `issues/NN-slug.md`, frontmatter `status` + `depends_on: [..]` + optional `hitl: true`. `issues/CONFIG.md` names the active PRD + test commands. `issues/HUMAN-SETUP.md` lists human prereqs (for MC: just Node 22 + authenticated `claude` CLI; auto mode is default). Each `/to-issues` batch ends with an auto-appended **HITL batch-QA-walkthrough** issue depending on all others.

## 4. Mission Control — what it is & the design (ADRs)

A local desktop app that is the single home for the `grill → prd → issues → afk` pipeline: a **Map** (backlog + dependency graph, drawn from `issues/` files on disk + git, NOT a parsed agent stream), embedded interactive **Panes** (one fresh `claude` session per issue), and a **Dispatcher** (conversational orchestrator). Docs: `CONTEXT.md` (glossary), `docs/PRD.md` (execution view), `docs/PRD-dispatcher.md`, `docs/adr/0001–0012`.

Key ADRs:
- **0001** embedded interactive Panes, not headless `claude -p`. **0002** MC owns worktree+merge lifecycle (solo→main, 2+→worktree per Run, human-triggered Merge) — *refined by 0011*. **0004** one backend, many Windows, one project per window. **0005** Electron + Node + React + node-pty/xterm.js.
- **0007** Dispatcher hybrid authority — *superseded by 0011*. **0008** Dispatcher delegates scheduling to the pure Run Coordinator (no LLM queue math). **0009** Dispatcher keeps its own context bounded (rolling synthesis; Run log on disk is durable record). **0010** Dispatcher is per-Project, on-demand, the layer behind "Drain."
- **0011 (current authority model)** Dispatcher = **silent autonomy by default**; the ENTIRE blocking-approval list is **{merge-conflict, abort-drain, HITL sign-off}**; clean merges auto-proceed; logging an issue is silent+passive.
- **0012** Noise floor + interaction: "if in doubt, stay silent." Empty/boot-screen captures dropped; doc-drift only on real contradiction; consolidation is a rare deduped passive note. Passive notes → ambient **log**, not the chat; chat is only blocking approvals + user Q&A; one serialized input queue; defer-while-typing; debounce backward status moves.

## 5. Status of everything

### Reflection-note setup work (`/Users/devteam/reflection-note.md`) — mostly done
Implemented: afk-issue-runner upgrades, global `~/.claude/CLAUDE.md`, per-project CLAUDE.md (billing-platform x3, vapi-ai-receptionist, livekit-agent), `/to-issues` HUMAN-SETUP emission, drain-mode dispatcher, batch-QA-walkthrough, doc-drift rule, grill right-size + fatigue exit, nvm loading fix in `~/.zshrc`. **Still open:** item 2 (direct DB/infra access), item 5 (`design-verify` skill), item 6 (partial — env bootstrap), and **item 4 — URGENT: rotate the exposed Google OAuth client secret** (`GOCSPX-…` sits in plaintext in `~/.claude/projects/-Users-devteam-Developer-claude-random-apps-savvy-backstage/53f24ef3-….jsonl`) **and the leaked `OPENAI_API_KEY`** (granola session). These are real credentials on disk — the one genuinely urgent real-world item, never done.

### Mission Control backlog (`issues/`)
- **01–09 done** — execution view (walking skeleton, Map, run-in-Pane, dep graph, live updates, drain+cap, worktree isolation, merge, multi-window).
- **10 open (HITL)** — execution-view QA walkthrough; **never completed by the user**.
- **11 done** (live run-guidance). **12–33 done** — tiling, and a big **parallel/merge hardening pass** (a 2-lens review found 20+ defects: manual-run isolation, duplicate-run guard, stranded-worktree recovery, merge report accuracy, partial-conflict abort, solo-run commits, project-switch reset, non-`main` branches, etc.) + an e2e lifecycle test (issue 32).
- **34–39 done** — Dispatcher: capture+Run-log, spine, authority gates, lifecycle+HITL-notify, cross-run synthesis, bounded context.
- **40 open (HITL)** — Dispatcher QA walkthrough; blocked, never done.
- **41–44 done** — feed auto-submit, parser body capture, panel resize; all found via live testing.
- **45–50 done** — recalibration (silent-autonomy authority remap, auto clean merges, noise floor, passive-to-log, debounce, worktree cleanup).
- **51 open (HITL)** — recalibration walkthrough; blocked on 52.
- **52 wip** — on-demand status injection. **Works** (2nd "what's left?" is accurate) with a known limit: pass-through PTY means the **first** ask in a session still answers from the seed. Pending final verify.
- **53 done** — HITL-notify parser fixes — **but still not firing live** because of the capture root cause in §0.

**Nothing is committed by workers themselves** (solo mode); I commit each issue. Working tree should be clean (all through issue 53 committed).

## 6. The pattern of the last many rounds (so you don't relearn it)
The user drives the app live; each drive catches a real integration/UX bug the headless tests missed (auto-submit 41, parser body 42, state grounding 43, running-label 33, panel resize 44, then the recalibration 45–50, then on-demand status 52, HITL 53, now the capture root cause). **Each finding → I confirm it in code, log a focused issue with the root cause, drain a worker to fix it (with a test), commit, and the user re-verifies.** Continue this loop. Investigate-in-code before diagnosing (don't guess — this bit us once with a `/bin/cat` suggestion). Reset `repo-a` before each walkthrough.

## 7. Parked threads to resurface
1. **Rotate the exposed secrets** (reflection item 4) — urgent, real-world; steps: Google Cloud Console → APIs & Services → Credentials (rotate the OAuth client secret); platform.openai.com → API keys (rotate). Only the user can do it.
2. **Issue 10** — execution-view HITL walkthrough, never run.
3. **Issue 40** — Dispatcher HITL walkthrough, blocked.
4. **Issue 51** — recalibration walkthrough, blocked on 52/53 + the capture fix.
5. Reflection-note items 2, 5, 6.

## 8. Immediate next action for the new session
Resolve §0: decide how to fix the TUI-scrape capture (recommend a **Worker-writes-completion-block-to-a-file** handoff that MC reads, replacing the fragile PTY-scrape; touches the afk-issue-runner skill + MC). Then it flows back into the normal loop: grill or log → drain → commit → user re-verifies issues 51/40, then flips 40/51/10 to close out the Dispatcher epic. After that, the Dispatcher is meant to be "daily-usable" (the bar the user actually cares about), and the parked secret-rotation should be surfaced.
