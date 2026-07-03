/**
 * Dispatcher lifecycle-event reactions (PURE) — issue 37.
 *
 * The Dispatcher's input contract (ADR-0007, PRD "Input contract") is a seed
 * plus a stream of STRUCTURED events — never a Run's raw Pane transcript. Issue
 * 35 fed it Completion blocks; this slice adds lightweight **terminal lifecycle
 * events** so the Dispatcher can react MID-drain, before (or instead of) a
 * Completion block that may never come:
 *
 *   - `started`         — a Run's Pane spawned (light relay, no action).
 *   - `finished`        — a Run reached `done` (light relay; its substance is the
 *                          Completion block fed separately).
 *   - `blocked`         — a Run ended without finishing (issue 22): it will emit
 *                          no useful Completion block, so the Dispatcher surfaces
 *                          it and PROPOSES discard-and-continue (issue 22's
 *                          discard, gated by issue 36) rather than the drain
 *                          silently stalling.
 *   - `stranded`        — a blocked/stopped isolated Run left a worktree behind
 *                          (issue 22): same surface + discard-and-continue
 *                          proposal so a finished sibling's Merge isn't blocked.
 *   - `needs-attention` — a Run is stuck in a way the Dispatcher can't act on
 *                          (surfaced so a stuck drain doesn't silently stall).
 *   - `hitl-waiting`    — the drain reached a HITL issue parked awaiting the
 *                          human (a `hitl: true` / `(HITL)` issue left `wip` with
 *                          a "Ready for manual verification" block). The
 *                          Dispatcher PROACTIVELY notifies the user, names the
 *                          issue, and relays its manual-verification steps (from
 *                          the captured block `detail`, issue 42) — the user is
 *                          not left to notice the pause themselves.
 *
 * This module is the pure decision core: `reactToLifecycleEvent` maps one event
 * to a `DispatcherReaction` (a plain-language notification to relay + an optional
 * approval-gated proposal + whether it is proactive). Like the input-contract
 * assembler, the exclusion of raw Pane output is the property it guarantees: a
 * `LifecycleEvent` carries only WHITELISTED structured fields, and an optional
 * `rawPaneOutput` present ONLY so the boundary is a real, tested one — the
 * reaction builder never reads it.
 *
 * PURE: no I/O, no Electron, no LLM. Unit-testable in isolation and safe to
 * share across main/renderer. The caller (App.tsx) turns a reaction's proposal
 * into a `dispatcher-proposal` activity and feeds its notification through the
 * `dispatcher-feed` submit queue.
 */
import type { DispatcherAction } from './dispatcher-authority';
import type { RunOutcome } from './completion-parser';

/** The terminal lifecycle a Run passes through, as the Dispatcher observes it. */
export type LifecycleEventKind =
  | 'started'
  | 'finished'
  | 'blocked'
  | 'stranded'
  | 'needs-attention'
  | 'hitl-waiting';

/**
 * One structured lifecycle event. Built from a Run's structured facts (its id,
 * issue id/slug/title, and — for blocked/stranded/hitl-waiting — the captured
 * report `detail` from the completion parser, issue 42). There is deliberately
 * no field that could carry raw Pane scroll; `rawPaneOutput` exists ONLY so the
 * exclusion is a boundary the test can push on, and the reaction builder never
 * reads it.
 */
export interface LifecycleEvent {
  kind: LifecycleEventKind;
  /** Stable per-Run id (the PTY session id). */
  runId: string;
  issueId: number | null;
  slug: string | null;
  title: string | null;
  /**
   * The captured report body (the parser's `detail`, issue 42): a blocked Run's
   * reason, or an HITL Run's manual-verification steps. Whitelisted structured
   * text — never raw Pane scroll. Null when the event carries no body.
   */
  detail: string | null;
  /**
   * The Run's raw terminal/Pane scroll. Present ONLY to make "excludes raw Pane
   * output" a real, tested boundary — `reactToLifecycleEvent` must NEVER read it.
   */
  rawPaneOutput?: string;
}

/** A proposed, approval-gated next step attached to a reaction. */
export interface LifecycleProposal {
  /** Stable id (`<action>:<runId>`) so the caller's activity log de-dupes it. */
  id: string;
  action: DispatcherAction;
}

/**
 * What the Dispatcher should surface for a lifecycle event:
 *   - `notification` — the plain-language line to relay in the chat panel, or
 *     null for an event that warrants nothing (e.g. an unclassifiable one).
 *   - `proposal`     — an approval-gated next step (discard-and-continue), or
 *     null when the event needs no action.
 *   - `proactive`    — true when the Dispatcher must PUSH this to the user
 *     unprompted (blocked/stranded/needs-attention/hitl-waiting) so a stuck or
 *     human-gated drain never silently stalls; false for routine relays.
 */
export interface DispatcherReaction {
  notification: string | null;
  proposal: LifecycleProposal | null;
  proactive: boolean;
}

/**
 * Human-readable label for the event's issue: `NN — slug`, falling back to the
 * bare id, the slug, or "a Run" when nothing is known. Padded to two digits to
 * match the rest of the Dispatcher's rendering.
 */
function issueLabel(event: LifecycleEvent): string {
  const id = event.issueId !== null ? String(event.issueId).padStart(2, '0') : null;
  const slug = event.slug ?? event.title;
  if (id && slug) return `issue ${id} — ${slug}`;
  if (id) return `issue ${id}`;
  if (slug) return slug;
  return 'a Run';
}

/** The trailing " Reason: …" / " Steps: …" clause, or "" when no detail. */
function detailClause(label: string, detail: string | null): string {
  const body = detail?.trim();
  return body && body.length > 0 ? ` ${label}: ${body}` : '';
}

/**
 * Map one lifecycle event to the Dispatcher's reaction. PURE and total over the
 * kind union (a `switch` with no default, so a new kind forces a decision here).
 * Reads only whitelisted structured fields — never `event.rawPaneOutput`.
 */
export function reactToLifecycleEvent(event: LifecycleEvent): DispatcherReaction {
  const label = issueLabel(event);
  switch (event.kind) {
    case 'started':
      return { notification: `Started ${label}.`, proposal: null, proactive: false };

    case 'finished':
      return { notification: `Finished ${label}.`, proposal: null, proactive: false };

    case 'blocked':
      // A blocked Run emits no useful Completion block — surface it and propose
      // discarding it so the drain continues rather than stalling silently.
      return {
        notification:
          `${label} is blocked — its Run ended without finishing, so no completion block is coming.` +
          detailClause('Reason', event.detail) +
          ` Discard it and continue the drain?`,
        proposal: { id: `discard-and-continue:${event.runId}`, action: 'discard-and-continue' },
        proactive: true,
      };

    case 'stranded':
      // A stranded isolated Run left a worktree behind (issue 22); discarding it
      // frees its finished siblings' Merge.
      return {
        notification:
          `${label} stranded — its Run ended without a done commit and left a worktree behind.` +
          detailClause('Reason', event.detail) +
          ` Discard the worktree/branch and continue?`,
        proposal: { id: `discard-and-continue:${event.runId}`, action: 'discard-and-continue' },
        proactive: true,
      };

    case 'needs-attention':
      // Surfaced so a stuck drain doesn't silently stall; nothing safe to
      // propose, so it's a proactive notification with no gated action.
      return {
        notification: `${label} needs your attention.` + detailClause('Details', event.detail),
        proposal: null,
        proactive: true,
      };

    case 'hitl-waiting':
      // The CRUCIAL new requirement (issue 37): a HITL issue parked awaiting the
      // human. Proactively notify, name the issue, and relay its manual-
      // verification steps (the captured block `detail`, issue 42) so the user
      // knows a HITL gate is waiting and what to do — no proposal (the human
      // does the verifying, then marks it done).
      return {
        notification:
          `HITL gate waiting on you — ${label} is parked for manual verification.` +
          detailClause('Steps', event.detail),
        proposal: null,
        proactive: true,
      };
  }
}

/**
 * Map a captured Run outcome (from the completion parser, issue 42) to the
 * lifecycle kind that should react to it, given whether the issue is HITL
 * (`hitl: true` / `(HITL)`, per the afk-issue-runner's own detection):
 *   - `completed`          → `finished`.
 *   - `blocked`            → `blocked` (propose discard-and-continue).
 *   - `needs-verification` → `hitl-waiting` when the issue is HITL (relay its
 *     verification steps); otherwise `needs-attention` — a Run that stalled
 *     awaiting a manual step it never declared HITL, surfaced rather than
 *     silently stalled.
 *   - `unknown`            → null (nothing recognised to react to yet).
 * PURE; the caller pairs it with `reactToLifecycleEvent`.
 */
export function lifecycleKindForOutcome(
  outcome: RunOutcome,
  isHitl: boolean,
): LifecycleEventKind | null {
  switch (outcome) {
    case 'completed':
      return 'finished';
    case 'blocked':
      return 'blocked';
    case 'needs-verification':
      return isHitl ? 'hitl-waiting' : 'needs-attention';
    case 'unknown':
      return null;
  }
}
