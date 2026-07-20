# Scheduled drains are window-coupled and one-shot, not a headless daemon

**Status:** accepted (2026-07-20). Realizes roadmap item 4 ("overnight drains", Slice B — scheduled start). Builds on ADR-0022 (the drain loop drives the Run Coordinator directly, **from the renderer**), ADR-0001 amendment (headless Run lane), issue 64 (a drain continues past a parked HITL), and issue 138 (local OS notifications). Companion to the still-unbuilt Slice A (drain budget ceiling).

A **scheduled drain** lets you set a drain to start later, at a chosen time, over a chosen subset of issues, so work runs while you're away. The tempting shape is a background daemon that fires even when Mission Control is quit. We deliberately did **not** build that. Reconnaissance found the drain loop is a reactive React effect in the renderer (`useDrain.ts` — "The drain loop, expressed as a pure re-plan"); it only runs while a Window is alive. Relocating it into the main process to survive a closed app is a large, separate effort (a true daemon), not part of this slice.

## Decision

- **Window-coupled trigger, not a daemon.** A scheduled drain is a *deferred press of the existing Drain control*: a timer in an **open Window** calls the same start path the button does at the chosen time. If MC is quit, or no Window has that project open at fire time, it simply does not run. This is honest about where the loop lives (ADR-0022) and keeps the slice small. A headless main-process drain driver (fire from a fully-closed, launch-at-login app) is explicitly deferred to a future "MC as background daemon" effort.
- **One-shot, not recurring.** A schedule fires once and is forgotten on MC restart — no persisted `drain_schedule` CONFIG key, no re-arm-on-launch. Recurring ("every weeknight") was considered and dropped for v1: it forces durable storage + backend ownership, which is most of the daemon work we're deferring. Revisit if one-shot proves too manual on an always-on machine.
- **Scoped by selection.** You pick which eligible issues are in scope; default is all eligible (identical to today's whole-backlog drain). A selected issue whose dependency isn't `done` stays blocked — the schedule never pulls unselected issues in. Selection is orthogonal to the concurrency **cap** (cap = how many at once). A count-based limit ("do any N") was rejected: it stops at a number, not at the work the human trusts.
- **Non-interactive: skip-and-notify.** At fire time, any condition where the manual Drain would pop a dialog — protected branch / detached HEAD (issue 167), non-git workspace + cap>1 (issue 158), `main` mid-merge (issue 24), or nothing eligible — makes the scheduled drain **not start and fire a notification naming the reason**. It never hangs waiting for a click nobody will give, and never auto-answers a git decision unwatched (the opposite of "trust the pipeline"). A parked HITL mid-drain still continues, unchanged (issue 64).
- **Sleep is handled.** While a scheduled drain is pending or running, MC arms `powerSaveBlocker('prevent-app-suspension')` (released the instant it ends) so idle system-sleep and macOS App Nap can't freeze the renderer-side loop. `prevent-display-sleep` was rejected as needlessly keeping the screen lit.
- **Reuse local notifications.** Start / end / HITL-park / skip are surfaced through the existing issue-138 macOS notifications — no remote or phone push (a cloud/self-hosted push service is against the local-first default and a large surface for a one-line convenience). The morning review is the existing **Receipts** and **Cost** tabs (ADR-0023), not a new summary surface.

## Considered Options

- **Headless main-process daemon** (fire with the app quit, via launch-at-login). Rejected for this slice: relocates ADR-0022's loop out of the renderer and makes the backend own Run/Pane lifecycle headlessly — its own multi-issue project. Named here as the deferred future path, not a no.
- **Recurring schedule in CONFIG frontmatter, backend-armed.** Rejected for v1: durable storage + backend timer + open-a-Window-at-fire-time is most of the daemon work above. One-shot first; recurring is additive later.
- **Count-based stopping point** instead of selection. Rejected: blind to *which* issues run.
- **Auto-answer the interactive gates** (e.g. branch off `main` and go). Rejected: an irreversible git decision at 3am with nobody watching.
- **Remote/phone push.** Deferred: needs a push service; unjustified for an always-at-desk Mac mini.

## Consequences

- **Gained:** "start it and walk away" for the real overnight case (machine on, MC open, human asleep) at near-zero new architecture — a timer, a `powerSaveBlocker` call, an issue-selection filter on the existing coordinator, and one new notification message. Every prior investment (headless lane, HITL-continue, telemetry, Receipts/Cost tabs, notifications) is reused.
- **Given up / documented limitation:** it will **not** fire if MC is quit or the project's Window is closed at the scheduled time — by design, surfaced in the scheduling UI. Closing a laptop lid would force sleep regardless, but the target hardware is a desktop Mac mini, so that caveat does not apply here.
- **Docs:** CONTEXT.md gains a **Scheduled drain** term; this ADR is the reference the term and the roadmap point at. The roadmap's "overnight drains" item is now Slice B (this) + Slice A (budget ceiling, still open).
- **Sequencing:** Slice A (a cost/time budget ceiling that halts a runaway) is the natural safety companion — an unattended scheduled drain most wants a hard cap — but is independent and not required for this slice to ship.
