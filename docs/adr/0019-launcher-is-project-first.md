# Launcher is project-first

Status: accepted (refines ADR-0016)

ADR-0016 made the **Launcher** verb-first — every empty **Window** opened on *"what are we doing?"* (New project / Big feature / Quick fix / Just talk / Continue), with the **Project** coming along as a side-effect of the chosen action. We are inverting it to **noun-first**: the home page is a chooser showing **all registered Projects** as cards (toggle to a dense list, persisted; cards default), each card carrying its backlog counts (open·wip·done), a needs-you **HITL** badge, liveness, and pipeline **stage**. Clicking a card switches the Window in place to that Project's **Map**. The per-project entry verbs move onto the Map as **＋ Start something** — **Grill a feature** (→ **Planning view**) and **Simple issue** (→ one standalone issue) — and the Map's empty state *is* that chooser. Only **New project** and a quiet **Just talk** remain on the home page, because they belong to no existing Project. *(Issue 168: the same warm Just talk is also reachable per-project, as a third ＋ Start something verb on the Map — the project-agnostic home-page entry is unchanged; the Map's is additive, scoped to the current project with CORE.md injected, so Just talk no longer requires leaving the project to reach it.)*

## Why

The verb-first front door optimized for *starting fresh work* and treated the Project as a parameter. In practice most sessions are *returning to a Project that already has work in flight* — a live backlog, running **Runs**, parked **HITL** — which the "what are we doing?" prompt ignored. Leading with the Projects (and floating the ones that need attention to the top) matches how the tool is actually used, and it reuses the existing **Map** + `switchProject` machinery instead of inventing a new screen.

## Considered options

- **Keep verb-first (ADR-0016).** Rejected: forces a Project choice as a side-effect of an action and buries the state of work already underway.
- **Insert a dedicated "what do you want to do?" step between the card and the Map.** Rejected: a Project is rarely a blank slate; an intermediate prompt hides the live backlog. The two verbs were folded into the Map (＋ Start something) instead.
- **Fully merge Launcher and Map into one surface.** Rejected: the **Map** stays a per-Project surface; the home page is a distinct portfolio chooser *in front of* it.

## Consequences

- ADR-0016's **Inbox** and **SessionStart** warm-start hook are untouched; only the Launcher's orientation changes.
- Clicking a card uses the existing in-place `switchProject`. Switching away from a Project mid-drain leaves its **Dispatcher** running in the backend (re-open the Project to watch it) — unchanged behavior, now reachable from the home grid.
- The project-first grid partially delivers the deferred "portfolio overview Window" (at-a-glance Projects + stage badges); a dedicated cross-project *analytics* Window remains separate and deferred.
