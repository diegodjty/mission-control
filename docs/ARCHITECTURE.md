# Architecture — the picture

Four diagrams that stay true. **Doc-drift rule applies here:** a Run whose change
makes one of these wrong updates the diagram in the same Run. Vocabulary is
CONTEXT.md's; decisions live in `docs/adr/`. Diagrams render in Obsidian, GitHub,
and any mermaid viewer.

> **In flight (2026-07-17):** drain-reliability wave (issues 135–138) and the
> headless-lane + merge-as-you-go batch (139–149, ADR-0001 amendment + ADR-0021).
> Where a diagram will change, a note says so.

## 1. System map — one backend, many Windows

```mermaid
flowchart LR
  subgraph R["Renderer (per Window)"]
    APP["App orchestrator"] --> MAP["Map"]
    APP --> LCH["Launcher"]
    APP --> PANE["Panes (xterm)"]
    APP --> ATT["Attention hub"]
  end
  subgraph M["Main process (the backend)"]
    HUB["Coordinator hub / IPC"]
    PTY["PTY session manager"]
    WATCH["Watchers: backlog · receipt · attention · planning"]
    GITA["Worktree adapter + merge + preview"]
    WB["Workbench git (auto-commit)"]
  end
  subgraph S["Shared pure modules (all decisions)"]
    COORD["run-coordinator"]
    ISO["isolation policy"]
    MODELS["receipt · launcher · attention models"]
  end
  APP <-->|"window.mc bridge"| HUB
  HUB --> PTY & GITA & WB
  WATCH --> HUB
  HUB --> COORD & ISO & MODELS
```

Decisions are pure functions in `src/shared/` (each with a sibling test);
`src/main/` is thin adapters; the renderer draws state it is handed.
Heavy files to know: `main/index.ts` (hub), `renderer/App.tsx` (orchestrator),
`main/git-worktree-adapter.ts`, `main/run-merge.ts`.

## 2. A Run's life (drain)

```mermaid
sequenceDiagram
  participant U as You
  participant C as Coordinator
  participant W as Worker session
  participant F as Files (issues/ + completions/)
  participant MC as Watchers → Run log
  U->>C: press Drain (cap N)
  C->>C: planDrain — startable = eligible + deps done
  C->>C: cut + provision worktree (copy node_modules)
  C->>W: spawn fresh claude (NODE_ENV=development)
  W->>F: flip issue open→wip (the claim)
  W->>W: work · verify gate
  W->>F: flip wip→done, write Receipt (before final message)
  F-->>MC: receipt-watcher ingests → Run log card + journal
  MC-->>C: re-plan → next issue fills the slot
```

Results travel **only** through Receipt files (ADR-0013) — the terminal is never
parsed. *Changes queued:* Workers go headless behind **Feeds** (139–140), hung
Runs are killed at `run_timeout` (141), blocked Runs park instead of halting the
drain (137), and the summon moments get OS notifications (138).

## 3. Merge lifecycle

```mermaid
stateDiagram-v2
  [*] --> FinishedUnmerged: Run finishes on afk/NN
  FinishedUnmerged --> Previewed: sequence simulation stamps badge
  Previewed --> Merged: Merge pressed · clean
  Previewed --> Conflict: predicted or real conflict
  Previewed --> Refused: adds install artifacts
  Conflict --> Merged: you resolve
  Conflict --> Aborted: you abort
  Merged --> [*]
```

Today the press is yours and order is ascending issue id. *Queued (ADR-0021,
145–148):* an always-on **auto-merge lane** merges clean Receipt-backed branches
in **finish order** with no press; a conflict pauses the lane and pings you;
solo-chaining retires — an issue starts only when its deps are done **and
integrated** ("waiting on merge of NN" otherwise).

## 4. Data layer — the Workbench (ADR-0015)

```mermaid
flowchart TD
  REG["registry.md (repo → project)"] --> P["~/Workbench/(project)/"]
  P --> I["issues/NN-slug.md"]
  P --> CMP["completions/ (Receipts)"]
  P --> PRD["PRD-*.md + CONFIG.md"]
  P --> MEM["memory/ CORE.md · topics · journal"]
  MEM -->|"CORE injected into every Worker/Dispatcher/bare session"| SESS["sessions"]
  CMP -->|"drain journal + Run log"| MEM
```

One private git repo holds every project's pipeline artifacts; MC auto-commits
per Run event; Obsidian is a lens, never a dependency. Code-describing docs
(CONTEXT.md, ADRs, this file) stay with the code.
