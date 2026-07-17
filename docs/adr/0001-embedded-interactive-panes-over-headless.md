# Embedded interactive Claude Code sessions, not a headless `claude -p` orchestrator

**Status:** accepted. Amended 2026-07-17 — **headless drain lane** (see **Amendment** below): drain Runs now execute headless by default; Panes remain the interactive surfaces.

Mission Control runs the AFK pipeline by embedding **real interactive Claude Code sessions** (one fresh session per issue, via a pseudo-terminal + browser terminal renderer such as node-pty + xterm.js), rather than spawning **headless `claude -p --output-format stream-json` agents** and parsing their event stream. The structured **Map** is drawn from the on-disk artifacts (issue files, git, completion blocks), not from a parsed agent stream.

## Considered Options

- **Headless orchestrator** — the app launches `claude -p` per issue, parses stream-json to render live step-by-step progress cards, and reimplements a permission-approval UI.
- **Embedded interactive panes** (chosen) — the app hosts the same interactive TUI you use by hand, tiled.

## Consequences

- **Gained:** native permission prompts (the "pause and ask before something risky" posture — see Q2 = hybrid — comes for free, answered live in the pane); the interactive "blocked, need you" loop stays real-time instead of a post-mortem; fresh-session-per-issue maps exactly onto the existing `/clear`-per-issue ritual; substantially less to build (no stream parser, no bespoke permission gate, no step-renderer).
- **Given up:** auto-rendered sub-step progress cards from a live stream. Mitigated by drawing the structured **Map** at *issue* granularity from the files; within a run, "watch the steps" means watching a real terminal pane.
- **Constraint introduced:** because panes are real sessions running with local auth and working directory, **Mission Control is a local app**, not a hostable web service (or its "server" is your own machine).
- **Open downstream:** concurrent panes on one repo need a collision strategy (parallel mode / worktrees) and an owner for the merge step — deferred to a later decision.

## Amendment (2026-07-17) — headless drain lane: drain Runs execute `claude -p`; Panes stay for interaction

**Motivation.** The original decision optimized for *watching and steering* every Run. Live use moved the goal to *"handle it yourself, notify me only when I'm needed"* — and the load-bearing reasons for interactive drain Runs have since dissolved: permission prompts are answered by auto-mode (never a human mid-run), results flow exclusively through Receipts (ADR-0013), and the afk-issue-runner contract escalates by **parking**, never by conversing. What remained of the interactive channel was cost: TUI sessions never exit (the phantom-slot class, issue 132), can't run unattended, and tax attention by their mere presence.

**Decision.** A **drain Run executes headless by default** — `claude -p --output-format stream-json`, no per-issue opt-in marker — and is watched through a **Feed** (read-only live view rendered from the event stream; see CONTEXT.md). **Panes remain** for every surface where interactivity is the point: manual single Runs, Planning view, Just talk, HITL verification, and take-overs. Receipts stay the sole capture input; the Feed's raw stream tail is peek/debug only.

- **Failure contract (park-only escalation).** A headless Run never receives human input. Anything needing a human ends as a Receipt (`needs-verification` / `blocked`); a permission denial is an explicit park-`blocked` case in the producer contract (never a retry-loop). A Run that exits non-zero with no Receipt, or breaches the per-Run wall-clock ceiling (`run_timeout` in project CONFIG, default 30 min; MC kills the process), lands in the existing no-Receipt path: conservative drain stop, attention item, OS notification.
- **Take over live.** Each headless Run's session id is stored; a *Take over in Pane* affordance kills the process and `claude --resume`s the same session interactively in the same worktree. The Run keeps occupying its drain slot until it ends, whatever its mode. Post-mortem resume uses the same mechanics.
- **Telemetry.** The stream's final result event (tokens, cost, duration) is stamped into the MC-owned Run log and drain journal (per-Run and per-drain totals). Receipts are producer-owned and stay untouched; Pane Runs remain time-only.

**Revisiting the original trade.** "Native permission prompts for free" is no longer needed (auto-mode + park contract). "No stream parser to build" is reversed knowingly: we now build a *thin* Feed renderer — but still no permission UI and no step-card machinery beyond it. The local-app constraint is unchanged.

**Rejected alternatives.** *Opt-in lane per issue* (perpetuates per-issue risk triage and ambient babysitting forever — the walk-away goal never arrives); *standing watch-mode toggle* (preserves the old behavior's full maintenance surface; the per-Run take-over is the escape hatch instead); *silent headless* (loses live awareness the Map can't provide); *rendering the stream into a read-only xterm* (cosplays as an interactive Pane and blurs the one distinction the glossary now draws: you watch a Feed, you talk to a Pane).
