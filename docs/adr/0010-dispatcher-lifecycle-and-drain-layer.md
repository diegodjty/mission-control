# The Dispatcher is per-Project, on-demand, and is the intelligent layer behind Drain

**Status:** retired by ADR-0022 (2026-07-18). There is no Dispatcher lifecycle to spin up or dismiss — the drain loop drives the Run Coordinator directly, with no orchestrator session in the loop.

The **Dispatcher** is spun up **on demand, per Project** — when a drain starts or the user explicitly opens it — lives for that drain/work session, and is dismissable; it is not an always-on daemon. Starting a **drain** *is* starting a Dispatcher session (it drives the deterministic **Run Coordinator** and spawns worker Panes). A **single manual Run stays bare**: just its one Pane, no Dispatcher. In the UI it is a **chat panel beside the Map**, with the **Run log** (Completion-block cards) as its visible history; worker Panes are one click away.

## Considered Options

- **Always-on daemon** vs **on-demand** — chose on-demand: a Dispatcher with nothing to orchestrate is wasted context/cost; it earns its place for multi-issue work.
- **Dispatcher for every Run** vs **only for drains/multi-issue** — chose drains/multi-issue: a lone Run is already legible in its single Pane; wrapping it in an orchestrator adds nothing.
- **One Dispatcher across all Projects** vs **per-Project** — chose per-Project, consistent with ADR-0004 (one backend, many Windows; a repo is owned by one Window) and issue 26 (per-Project state scoping).

## Consequences

- "Drain" becomes the entry point to the Dispatcher, unifying the CLI `afk-issue-runner` drain-mode dispatcher with Mission Control's UI: the workers' terminals are the visible Panes, the dispatcher's synthesis is the chat panel.
- The Dispatcher's lifetime is bounded by the drain/session, which composes with ADR-0009 (its context is bounded within that lifetime too).
- Per-Project scoping means multi-window use (ADR-0004) gets one Dispatcher per active Project, never a shared/global one.
- Single-run UX is unchanged (no regression to the bare-Pane path).
