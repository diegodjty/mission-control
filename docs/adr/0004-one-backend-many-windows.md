# One multi-project backend, many single-project windows

Mission Control runs as a **single backend** (one port, one state store, one coordinator for panes/worktrees/merges) that owns a registry of many **Projects**. The UI is **one Project per Window**, and working on 2+ projects at once means opening **multiple Windows onto the same backend** — not launching multiple copies of the app. A portfolio overview Window (all Projects + stages) is a later additive view.

## Considered Options

- **Multiple app instances** — one Mission Control per project, launched separately. Rejected: each instance binds its own port (the recurring "something already on that port" pain), keeps separate state, has no cross-project view, and two instances pointed at one repo would collide managing worktrees/merges.
- **One backend, many windows** (chosen) — analogous to a code editor: one running app, several project windows.

## Consequences

- The data model must treat **Project** as first-class from day one (a registry of repo paths, each with backlog + stage + Runs) — the "portfolio-ready data model" is now load-bearing, not optional.
- Single backend = one coordinator, so it can enforce that no two Windows double-manage the same repo, and there are no port/state collisions.
- v1 ships one-Project-per-Window with a switcher; the portfolio overview is a later view over the same model, not a rewrite.
