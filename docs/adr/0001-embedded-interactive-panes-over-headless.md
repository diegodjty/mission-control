# Embedded interactive Claude Code sessions, not a headless `claude -p` orchestrator

Mission Control runs the AFK pipeline by embedding **real interactive Claude Code sessions** (one fresh session per issue, via a pseudo-terminal + browser terminal renderer such as node-pty + xterm.js), rather than spawning **headless `claude -p --output-format stream-json` agents** and parsing their event stream. The structured **Map** is drawn from the on-disk artifacts (issue files, git, completion blocks), not from a parsed agent stream.

## Considered Options

- **Headless orchestrator** — the app launches `claude -p` per issue, parses stream-json to render live step-by-step progress cards, and reimplements a permission-approval UI.
- **Embedded interactive panes** (chosen) — the app hosts the same interactive TUI you use by hand, tiled.

## Consequences

- **Gained:** native permission prompts (the "pause and ask before something risky" posture — see Q2 = hybrid — comes for free, answered live in the pane); the interactive "blocked, need you" loop stays real-time instead of a post-mortem; fresh-session-per-issue maps exactly onto the existing `/clear`-per-issue ritual; substantially less to build (no stream parser, no bespoke permission gate, no step-renderer).
- **Given up:** auto-rendered sub-step progress cards from a live stream. Mitigated by drawing the structured **Map** at *issue* granularity from the files; within a run, "watch the steps" means watching a real terminal pane.
- **Constraint introduced:** because panes are real sessions running with local auth and working directory, **Mission Control is a local app**, not a hostable web service (or its "server" is your own machine).
- **Open downstream:** concurrent panes on one repo need a collision strategy (parallel mode / worktrees) and an owner for the merge step — deferred to a later decision.
