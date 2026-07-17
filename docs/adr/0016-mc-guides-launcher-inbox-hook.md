# MC guides: the Launcher front door, the cross-project Inbox, and deterministic warm start

**Status:** accepted. Builds on ADR-0015 (the Workbench as data layer); realizes the "one application" hub.

V1 automated the *work* but not the *deciding*: choosing the entry path, onboarding projects, and noticing what awaits the human all lived in memory or a terminal. Decision: **Mission Control becomes the guide.**

- **Launcher (front door):** every empty Window IS the Launcher — *what are we doing?* → New project / Big feature / Quick fix / Just talk / Continue. Each action performs its own setup: New/Existing scaffolds the Workbench entry + registry line + CONFIG; Big feature opens a Planning view on the chosen project; Quick fix turns one sentence into a standalone issue (`## Source`) in the workbench backlog and offers Run-now; Just talk opens a warm bare Pane. Always reachable via a home affordance.
- **Inbox (cross-project attention):** the backend lightly watches **every `status: active` registry project's** workbench dirs (issues/, completions/, memory/) — not just open ones — and derives attention items via a pure model: HITL parks awaiting sign-off, curator `CORE.proposed.md` proposals, latest-Receipt-blocked Runs, HUMAN-SETUP unchecked boxes that gate issues, plus a since-last-seen journal briefing (quiet text in the window — **see the issue-138 amendment below** for the one OS-notification exception). Items click through to the project. Walkthrough readiness stays a checklist step (the park is the item; no e2e dashboard).
- **Planning view v1 (thin):** a normal Pane running grill/to-prd/to-issues beside a live markdown preview of the documents as they are written (workbench PRD/issues + repo CONTEXT/ADRs, file-watched), with stage buttons. Deliberately not a bespoke structured chat.
- **Deterministic warm start:** a Claude Code `SessionStart` hook (script in `~/Workbench/tools/`) does the cwd→registry→CORE.md lookup as executed code and injects the context — instruction-following (global CLAUDE.md text) demotes to fallback. The `settings.json` change is human-applied (HITL, issue-74 pattern).

## Consequences

- Background watching of N projects must stay cheap (fs watches + debounced reads; no polling, ADR-0006 discipline) and respect ownership (read-only aggregation; acting on an item opens/claims the project normally).
- The Launcher's Quick fix writes issues without a PRD — standalone `## Source` issues are now a first-class UI product, not just a skill convention.
- The Inbox is the ecosystem hub: future tools (meetings, todos) surface their attention items through the same pure model by writing workbench artifacts — no new UI channel per tool.
- Last-seen state for the briefing is app-level (userData), not workbench data — reading the Inbox must not create commits.

## Amendment (issue 138) — OS notifications on the blocking/terminal tiers

The original "quiet text, never notifications" line was right for the *steady-state* Inbox: passive attention that the human polls. But the stated goal is "handle it yourself, notify me only when I'm needed" — and a quiet surface can't reach a human who has walked away. So this amends the "never notifications" rule **for the OS channel only, and only for the blocking/terminal tiers**:

- **Fires a native OS notification:** an HITL Run parks awaiting sign-off/verification; a Run parks blocked; a Merge hits a conflict; the drain stops or finishes.
- **Never notifies (unchanged — window-only):** routine claim/done flips, curator proposals, setup gates, new-repo candidates, the journal briefing, and every passive note. This is the ADR-0012 noise floor applied at OS level — an OS ping is the loudest interruption the app has, so "if in doubt, stay silent" governs here too.

Structure: the tier filter + per-issue dedupe are a **pure decision module** (`shared/attention-notifications`, attention/lifecycle event → notification intents); a **thin main-process adapter** shows the `electron.Notification` and, on click, focuses the Window and lands on that Project's attention surface (the same click-through the Inbox performs). One notification per event, deduped so a re-scan never re-pings; parks already on disk at launch are seeded (not re-announced). Driven from the SINGLE app-level attention watch (so multiple open Windows never ping in duplicate) plus the merge and drain-journal edges. The in-window Inbox stays exactly as quiet as before.
