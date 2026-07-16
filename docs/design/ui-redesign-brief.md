# Design brief — Mission Control UI redesign (issue 122)

**Where:** claude.ai/design project **"Jarvis-style assistant interface"** (id `c4327f25-2ba2-49b8-b549-185347143e32`) — the project the Atlas token language came from. Mocks live there; approval there is the gate before any view-rebuild issue (127–130) starts.
**Parent:** `~/Workbench/mission-control/PRD-ui-redesign.md`. Story numbers below refer to its User Stories section.
**Current-state screenshots** (for contrast, captured 2026-07-15 from the live app): `docs/design/current-state/*.png` in the app repo.

## Shared vocabulary

Mocks and app already speak the same language — reuse it, don't invent a second one:

- **Tokens (unchanged by this redesign):** the Atlas custom properties the app's stylesheet already uses — `--bg`, `--chrome`, `--surface`, `--fg`/`--fg-soft`/`--fg-mute`/`--fg-faint`, `--teal(-bg/-border/-soft)`, `--amber*`, `--green*`, `--red*`, `--violet*`, `--border(-strong/-teal)`, `--glow`, `--shadow-card`, `--shadow-cmd`, `--font-sans` (Montserrat). Dark navy stage is the default theme; light is the alternate. Spend these tokens consistently; do not redesign the palette.
- **Nouns (CONTEXT.md):** Window, Project, Map, Pane, Run, Launcher, Inbox → becomes the unified **attention surface**, Planning view, Dispatcher.
- **Source mock:** `Mission Control.dc.html` in the design project (the original Jarvis shell: rail, command bar, Home/Inbox/Dispatch, theme toggle).

## Global requirements (every screen)

- Sits on the **Atlas shell**: persistent slim rail (replaces the top tab bar), header always showing the active **Project** with a switcher, Cmd+K command palette.
- **At least one narrow-width variant per view** (split-screen Electron window, ≈700px). Today the app has 0 media queries and ~566 hard-coded px widths — see `07-map-narrow.png` for how the current header/content collapses.
- The **shell appears in dark and light at least once** across the set.
- Semantics are frozen: ADR-0019's project-first Launcher, Run/drain/merge behavior, Dispatcher behavior. This is presentation + navigation chrome only.

## Screens to mock

1. **Atlas shell itself** — rail with unambiguous active state; badges on rail entries (running-Run count on Pane, needs-you count on attention — same number everywhere, stories 1–8); Plan entry present only while a planning session exists (story 6); header Project switcher; the **Cmd+K palette open state** (fuzzy Projects/views/issues + entry-point actions, empty-query suggestions, stories 9–16); and the **icon-collapsed narrow rail** (story 30). Show dark + light here.
2. **Launcher (home)** — project-first card grid + dense-list variant, restyled on the primitives; cards keep backlog line, needs-you badge, liveness, stage badge, attention sort; New project + Just talk stay the only actions (stories 38–40). Contrast: `01-launcher-dark.png`, `02-launcher-light.png`, `08-launcher-narrow.png`.
3. **Map** — backlog with clear status/dependency/blocker hierarchy (story 34); shared badge/feed primitives for status, merge-preview badges, Run log (35); prominent, state-unambiguous drain + merge controls (36); ＋ Start something per ADR-0019 (37). Contrast: `03-map-dark.png`, `07-map-narrow.png`.
4. **Pane** — tiled terminals, per-tile header naming Run + issue (41), obvious maximize/restore (42), grid adapts to Run count and width (43). Contrast: `04-pane-dark.png` (single restored session today — mock the N-tile grid).
5. **Unified attention surface** (replaces the Inbox tab) — one cross-project surface: grouped by Project, parked-HITL first, since-last-seen briefing preserved, one-click jump to the right Project's Map/Pane (17–21). Contrast: `05-inbox-dark.png` (today's Inbox — the briefing bar + empty state).
6. **Planning view** — side-by-side Pane + live doc preview with stage controls, restyled on the primitives (44); keeps live state across navigation (5). No current-state capture (needs a live planning session) — see PRD for behavior.
7. **Dispatcher panel** — conversation + activity rows on shared primitives (45), beside the Map, drag-resizable with persisted width (31). No current-state capture (needs an active drain).

Cross-cutting for all mocks: dialogs/menus/tooltips/toasts from one primitives set (22–27); theme toggle reachable from shell and palette (46–47); graceful truncation with tooltips at narrow widths (32).

## Proposed screen names (for the approval record)

`shell-dark`, `shell-light`, `shell-rail-collapsed`, `palette-open`, `launcher-cards`, `launcher-list`, `launcher-narrow`, `map`, `map-narrow`, `pane`, `pane-narrow`, `attention`, `attention-narrow`, `planning`, `planning-narrow`, `dispatcher`, `dispatcher-narrow`.

Using these names in the design project makes the capture step mechanical: issue 122's acceptance criteria want each approved screen's name/id recorded in the issue so rebuild issues 127–130 can reference them.
