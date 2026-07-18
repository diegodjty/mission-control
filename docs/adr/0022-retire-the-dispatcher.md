# Retire the Dispatcher: Feeds watch, notifications summon, the Run log narrates

**Status:** accepted (2026-07-18). Retires the **Dispatcher** as a surface and concept. Retires outright ADR-0007 (hybrid authority), ADR-0009 (bounded-context rolling synthesis), ADR-0010 (lifecycle / drain-layer), ADR-0014 (run-narrative-in-conversation). Supersedes-and-rehomes ADR-0008, ADR-0011, ADR-0012 (their *decisions survive*, moved to the pieces named below; only the Dispatcher framing dies). Leaves ADR-0013 (Receipts) fully intact — it is the capture backbone, not a Dispatcher decision. Companion to the ADR-0001 amendment (headless Feeds) and ADR-0021 (auto-merge lane), which are what made the Dispatcher redundant.

The **Dispatcher** was a foreground conversational orchestrator: a Claude chat session you talked to during a drain, which relayed each Completion block, synthesized across Runs, and gated the few blocking decisions (ADRs 0007–0014). Its founding premise (ADR-0010) was "talk to one orchestrator instead of watching N terminals." Two later decisions answered that premise a different way and hollowed it out: **Feeds** (ADR-0001 amendment) gave you the watching, **OS notifications** (issue 138) gave you the summons, and the **Run log** already gave you the per-Run narrative from Receipts. What remained was a standing chat that mostly re-said Receipts you can already see.

Reconnaissance before this decision confirmed the drain does **not** route control through the Dispatcher: the drain loop calls the pure **Run Coordinator** (`planDrain`) directly. The Dispatcher rode alongside as a surface plus ~6,000 LOC of mostly-pure `shared/dispatcher-*` modules — and wave 2 quietly **repurposed** several of them.

## Decision

- **Remove the conversational surface and its chat-only plumbing:** `DispatcherPanel`, the chat submit-pump wiring *as a Dispatcher channel* (the pump itself is shared infrastructure Planning/Just-talk reuse — it stays), `dispatcher-proposal`, `dispatcher-status-model`, `dispatcher-channel`, `dispatcher-width`, `dispatcher-session` (main), and the `dispatcher-input-contract`/`dispatcher-bridge`/`dispatcher-lifecycle` seams that exist only to feed the chat.
- **Drop cross-run synthesis** (`dispatcher-synthesis`, `dispatcher-rolling-synthesis`). Its two jobs got better owners since it was built: per-issue **doc-drift** is caught at the source by the completion-block rule (and the ARCHITECTURE.md doc-drift rule), and cross-run **pattern spotting** is now `/debrief` — on-demand, visual, grounded in the real diffs. Retires ADR-0009.
- **Keep, but rename out of the `dispatcher-` namespace, the modules wave 2 repurposed** — deleting them would rip out live logic:
  - `dispatcher-merge` → the **auto-merge lane**'s clean-vs-gate classifier (`auto-merge-lane-executor` already calls it; ADR-0021). Rename to `merge-classification`.
  - `dispatcher-authority` / `dispatcher-narrative` → the **notification + Run-log tiering** (issue 138). Rename to the notification/run-log tier modules.
  - `dispatcher-noise-floor` → the notification/Run-log noise floor (ADR-0012's logic, re-homed).
- **What drives a drain now:** the drain loop drives the **Run Coordinator** directly (already true) and the **auto-merge lane** integrates finished branches (ADR-0021). No orchestrator session is spawned. A drain's human-facing surfaces are the **Map** (status), **Feeds** (live watch), the **Run log** (per-Run narrative from Receipts), and **OS notifications** (the three blocking summons). "Ask the drain a question" is served by a **Just-talk Pane** (which reads the journal/Receipts and hosts `/debrief`) — not a dedicated always-on chat.
- **The blocking-approval set is unchanged** (merge conflict, HITL sign-off, abort drain). It was never the Dispatcher's to own — it is now surfaced by notifications + the Merge affordance directly.

## Considered Options

- **Keep the Dispatcher** (status quo). Rejected: its premise was met by Feeds/notifications/Run log; a standing chat that relays visible Receipts is pure surface area, and it carried ~6,000 LOC of test-and-maintenance weight.
- **Slim it to a bare chat box** (strip synthesis/authority, keep a text field). Rejected: keeps the channel/pump/lifecycle wiring alive for a box you'd rarely type into — the worst of both; Just-talk already serves the rare "ask" case better (not locked to one drain's context).
- **Delete all `shared/dispatcher-*`.** Rejected by the code: `dispatcher-merge` and the authority/narrative tiers are load-bearing for the wave-2 auto-merge lane and notifications. Renaming, not deleting, is the honest move.
- **Keep synthesis, re-homed as a passive note.** Rejected: redundant with per-issue doc-drift and `/debrief`; ~600 LOC to emit a note rarely seen.

## Consequences

- **Gained:** ~a dozen modules and a whole UI surface retired; `App.tsx` (the god-file) sheds its largest tenant; no orchestrator session spun up per drain (one fewer PTY, one fewer context to keep lean); the mental model shrinks to Map + Feeds + Run log + notifications.
- **Given up:** the automatic "here's a cross-Run pattern" nudge. Accepted — `/debrief` is the on-demand replacement, and the user prefers pulling that visually over an ambient chat note.
- **Migration honesty:** ADR-0011/0012's *decisions* (auto-merge-on-clean, the noise-floor tiers, the blocking set) are not lost — they moved to ADR-0021's lane and issue-138's notifications. A reader of the retired ADRs is pointed here, and here to their new homes.
- **Docs:** CONTEXT.md's Dispatcher, Worker, Run log, Completion block, Dispatcher-authority, and noise-floor entries plus the Dispatcher relationship bullets are updated to the post-retirement reality in the same change.
- **Risk:** the rename touches live imports (auto-merge-lane-executor, the notification path). Low and mechanical, covered by the existing sibling tests moving with their modules.
