/**
 * Run Coordinator — the pure decision at the heart of "drain the backlog with a
 * concurrency cap" (issue 06).
 *
 * Given the backlog on disk, a user-chosen max-concurrent cap, and the Runs
 * currently in flight, it decides:
 *   - which eligible issues are **startable** right now (fresh Panes to open),
 *   - which eligible issues **queue** for the next free slot, and
 *   - whether the drain should **stop**, and why (nothing eligible remains, or a
 *     Run reported blocked).
 *
 * It is a PURE state machine (no spawning, no I/O, no Electron): the actual
 * spawning is done by the PTY Session Manager the UI drives with this plan, so
 * the decision itself is unit-testable in isolation (see PRD "Testing
 * Decisions"). It reuses the single source of truth for "can a Run start on
 * this issue?" — `eligibleForRun` from run-eligibility — rather than
 * re-deriving the open/deps-done rule here.
 *
 * Reactive by design: the UI re-invokes `planDrain` on every backlog change
 * (issue 05's live watch) and whenever a Run's status changes, so "auto-start a
 * queued Run as a slot frees" falls out of re-planning — there is no timer.
 */
import type { BacklogIssue } from './backlog-model';
import type { RunOutcome } from './completion-parser';
import { footprintOverlap, predictedFootprint } from './file-overlap';
import { eligibleForRun } from './run-eligibility';
import type { RunStatus } from './run-state';

/**
 * A Run currently tracked by the UI. `status` is the value `deriveRunStatus`
 * already produced (run-state) — the Coordinator does not re-derive it, it just
 * counts slots and excludes issues that already have a Run.
 */
export interface ActiveRun {
  issueId: number;
  status: RunStatus;
  /**
   * The outcome the latest Receipt ingested for this Run's issue DECLARED
   * (`issues/completions/NN-slug.md`, ADR-0013), or null/absent when no Receipt
   * exists for it. This is what lets the Coordinator tell a parked HITL Run
   * (`needs-verification` — success, the human verifies) from a genuinely
   * blocked one (issue 64). Declared state only — never prose heuristics.
   */
  receiptOutcome?: RunOutcome | null;
  /**
   * This Run is a LEFTOVER from a PRIOR drain generation, not the current one
   * (issue 132). A real `claude` Pane never exits — it finishes its message and
   * lingers at its prompt — so a Run from yesterday's drain that neither flipped
   * its issue `done` nor wrote a Receipt keeps reading `running` (run-state) for
   * as long as the app stays open. Counting such a phantom against a FRESH
   * drain's cap is the reported bug: a cap-3 drain over three eligible issues
   * saw two lingering phantoms, computed one free slot, started a single Run,
   * and the rest starved because those slots never freed.
   *
   * A leftover Run therefore does NOT occupy a slot in — nor halt — the current
   * drain: it is not this drain's responsibility, and the user starting a new
   * drain is the signal to schedule fresh work up to the cap regardless of it.
   * Its issue is STILL excluded from re-start (it has a Run — see `activeIds`),
   * and it is left alive and untouched (never killed). The caller marks this by
   * comparing the Run's drain generation to the current one; a current-drain Run
   * or a manual (non-drain) Run leaves this false and counts exactly as before.
   */
  leftover?: boolean;
}

/**
 * Whether a Run whose session ended without finishing is a **parked HITL Run**
 * rather than a genuinely blocked one (issue 64). Parking is success: the
 * Worker did its job and left the issue `wip` for the human to verify (the
 * afk-issue-runner's §2 HITL contract), so the drain must skip it and keep
 * going — issues that `depends_on` it stay blocked naturally.
 *
 * The distinction reads DECLARED state only (ADR-0013's declare-don't-imply):
 *   - The Run's status is already `parked` (issue 65) — run-state derived the
 *     park directly from the declared Receipt, session alive or not.
 *   - The Run's Receipt declares `outcome: needs-verification` ⇒ park.
 *   - Fallback: the issue carries the HITL marker (`hitl: true` / `(HITL)`),
 *     ended `wip`, and a Receipt EXISTS whose declaration isn't `blocked`
 *     (an unreadable/undeclared outcome on a marked HITL park still counts —
 *     the marker and the Receipt's existence are both declared facts).
 *   - A Receipt declaring `blocked`, or NO Receipt at all (the genuinely-
 *     unknown case, e.g. a Worker that died mid-exit), is never a park: the
 *     drain keeps today's conservative stop-and-report behavior.
 */
export function isParkedHitl(
  run: Pick<ActiveRun, 'status' | 'receiptOutcome'>,
  issue: Pick<BacklogIssue, 'hitl' | 'status'> | undefined,
): boolean {
  if (run.status === 'parked') return true;
  if (run.status !== 'blocked') return false;
  const receipt = run.receiptOutcome ?? null;
  if (receipt === 'needs-verification') return true;
  return (
    (issue?.hitl ?? false) &&
    issue?.status === 'wip' &&
    receipt !== null &&
    receipt !== 'blocked'
  );
}

/**
 * Whether a blocked Run is a declared-blocked **park** (issue 137) rather than a
 * genuinely-unknown halt. A Worker that hits a blocker only the human can clear
 * writes a Receipt declaring `outcome: blocked` and leaves its issue not-done;
 * ADR-0013's declare-don't-imply makes that a fact of its own. The drain treats
 * it exactly as it already treats a parked HITL Run (`isParkedHitl`, issue 64's
 * precedent): it does NOT halt — the blocked issue parks awaiting the human, its
 * dependents stay excluded naturally via eligibility (their dependency never
 * reached `done`), and everything else keeps scheduling. The blocked Run does
 * not go quiet — it surfaces as an Attention item and a Run-narrative message —
 * but it no longer stops the whole drain.
 *
 * The distinction reads DECLARED state only, nothing else:
 *   - status `blocked` AND the Receipt declares `blocked` ⇒ a park.
 *   - status `blocked` with NO Receipt (`receiptOutcome` null/absent) ⇒ the
 *     Worker died mid-exit with genuinely-unknown state — NOT a park; today's
 *     conservative stop-and-report stands.
 * A LEFTOVER blocked Run (issue 132) is never THIS drain's park to report — a
 * stale Pane from a prior drain is out of scope here exactly as it is for the
 * halt — so it is excluded too.
 */
export function isBlockedPark(
  run: Pick<ActiveRun, 'status' | 'receiptOutcome' | 'leftover'>,
): boolean {
  return (
    !run.leftover &&
    run.status === 'blocked' &&
    (run.receiptOutcome ?? null) === 'blocked'
  );
}

/**
 * A dependent held back purely by an unmerged (not-yet-integrated) dependency
 * (issue 147, ADR-0021). Every OTHER dependency is `done`; the only thing
 * standing between this issue and startable is the auto-merge lane landing
 * `mergeIssueId`. Distinct from an issue blocked on genuinely unfinished work
 * (still `open`/`wip`) — that case is not a merge wait and is not reported here.
 */
export interface WaitingOnMerge {
  /** The held dependent's issue id. */
  issueId: number;
  /** The lowest not-yet-integrated dependency id it is waiting on. */
  mergeIssueId: number;
}

/**
 * The open issues held back ONLY by an unmerged dependency — the Map's
 * "waiting on merge of NN" state (issue 147). An issue qualifies when every
 * dependency is `done` on disk but at least one is still `finishedUnmergedIds`
 * (its `afk/` branch hasn't landed on main yet, the same fact `eligibleForRun`
 * now gates on). Reports the LOWEST such dependency id — once the auto-merge
 * lane lands it, the next sweep either clears the wait or reports the next one.
 * An issue with a genuinely not-done dependency is excluded: it is blocked on
 * unfinished work, not a pending merge, and must not read as "almost there".
 * PURE and derived from `BacklogIssue.dependsOn`/`status` plus the on-disk scan
 * alone, so the coordinator and the Map agree by construction.
 */
export function waitingOnMergeIssues(
  issues: BacklogIssue[],
  finishedUnmergedIds: readonly number[] = [],
): WaitingOnMerge[] {
  const unmerged = new Set(finishedUnmergedIds);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const result: WaitingOnMerge[] = [];
  for (const issue of issues) {
    if (issue.status !== 'open') continue;
    const notDone = issue.dependsOn.filter((depId) => byId.get(depId)?.status !== 'done');
    if (notDone.length > 0) continue;
    const mergeBlockers = issue.dependsOn.filter((depId) => unmerged.has(depId));
    if (mergeBlockers.length === 0) continue;
    result.push({ issueId: issue.id, mergeIssueId: Math.min(...mergeBlockers) });
  }
  return result.sort((a, b) => a.issueId - b.issueId);
}

/**
 * An eligible issue's start deferred because its predicted file footprint
 * overlaps a Run already occupying a slot or another issue already chosen to
 * start this round (issue 171). Never silent — the Map/drain surface renders
 * this so "161 and 167 both touch App.tsx" is visible instead of a mystery
 * queue slot, and the merge collision it prevents never happens in the first
 * place.
 */
export interface OverlapNotice {
  /** The issue whose start this round was deferred by the overlap. */
  issueId: number;
  /** The issue (running, or already selected to start this round) it collides with. */
  blockingIssueId: number;
  /** The shared file path/glob responsible, for the human-facing message. */
  path: string;
}

/** Why a drain stopped. */
export type DrainStopReason = 'no-eligible' | 'run-blocked' | 'mid-merge';

export interface DrainDecision {
  /** True when the drain should start no further Runs. */
  stop: boolean;
  /** The reason, or null while the drain is still live. */
  reason: DrainStopReason | null;
  /**
   * When `reason` is 'run-blocked', the issue id whose Run halted the drain — a
   * Run that ended `blocked` with NO Receipt (the genuinely-unknown conservative
   * case, issue 137). A declared-blocked park never lands here; see
   * `blockedParkedIssueIds`.
   */
  blockedIssueId: number | null;
  /**
   * Issue ids whose Run declared `outcome: blocked` and PARKED (issue 137): the
   * drain skipped each and kept scheduling, and each now awaits the human to
   * unstick it. Populated on EVERY plan (live or stopped), ascending and
   * deduped, so the UI stop message, the drain-end journal, and the Attention
   * surface can report "N blocked awaiting you" instead of a premature
   * run-blocked halt. Empty when nothing parked blocked.
   */
  blockedParkedIssueIds: number[];
  /** A human-readable one-liner for the UI ("Stopped: …"), or '' while live. */
  message: string;
}

export interface DrainPlan {
  /** Issue ids to open a fresh Pane on now, ascending, capped by free slots. */
  startable: number[];
  /** Eligible issue ids waiting for a free slot, ascending. */
  queued: number[];
  /** Whether/why the drain should stop. */
  drain: DrainDecision;
  /**
   * Open issues held back ONLY by an unmerged dependency (issue 147) — the
   * Map's "waiting on merge of NN" state. Populated on every plan; empty when
   * nothing is waiting purely on a merge.
   */
  waitingOnMerge: WaitingOnMerge[];
  /**
   * Eligible issues this round's slot-fill skipped over because their
   * predicted footprint collides with a Run already occupying a slot, or with
   * another issue already chosen to start this round (issue 171). Ascending
   * by issue id; empty when no overlap forced a deferral. A deferred issue
   * still appears in `queued` as before — this just names WHY.
   */
  overlapNotices: OverlapNotice[];
}

export interface DrainInput {
  /** The backlog (issues in any order — the Coordinator sorts by id). */
  issues: BacklogIssue[];
  /** The user-configurable max-concurrent cap. Non-positive is treated as 1. */
  maxConcurrent: number;
  /** The Runs the UI is currently tracking. */
  activeRuns: ActiveRun[];
  /**
   * True when `main` is left mid-merge — a partial `afk-merge.sh` run committed
   * some slugs then hit a conflict, leaving a conflicted index / MERGE_HEAD
   * (issue 24). A new drain must NOT start on top of that: worktree creation and
   * isolation all assume a clean `main`, and a fresh Run would compound the mess.
   * The user resolves or aborts the merge first. Optional (defaults false) so
   * callers/tests without merge state get the normal plan.
   */
  midMerge?: boolean;
  /**
   * Issue ids whose `afk/` branch is finished (committed `done`) but not yet
   * merged into main (issue 147, ADR-0021) — the same on-disk fact afk-scan
   * produces for `run-eligibility`'s `InFlightRuns.finishedUnmergedIds`. A
   * dependency in this set does NOT satisfy `eligibleForRun`'s dependency check
   * even though its issue frontmatter reads `done`; the dependent instead shows
   * up in `waitingOnMerge` until the auto-merge lane lands it. Optional/absent
   * ⇒ no dependency is held back for being unmerged (legacy/test callers).
   */
  finishedUnmergedIds?: readonly number[];
  /**
   * Issue ids with a pending timeout-salvage record (issue 170) — their Run
   * was killed for exceeding `run_timeout` and their worktree awaits a human
   * salvage decision (complete-from-worktree / discard-and-requeue). Ascending,
   * deduped by the caller. Optional/absent ⇒ none pending (legacy/test
   * callers, or a project with no such Runs). Named in the drain-stop message
   * distinctly from `blockedParkedIssueIds` — a timeout kill wrote no Receipt
   * at all, so it must never read as an ordinary "blocked awaiting you".
   */
  timeoutSalvageIssueIds?: readonly number[];
  /**
   * The project CONFIG's `hot_files` list (issue 171) — file paths any two
   * eligible issues both predicted to touch must serialize against, on top of
   * whatever each issue's own `touches:` frontmatter declares. Optional/absent
   * ⇒ no hot files (legacy/test callers get today's behavior: nothing forces
   * overlap serialization).
   */
  hotFiles?: readonly string[];
}

/**
 * A Run occupies a slot only while it is `running` AND it belongs to the
 * current drain. A leftover Run from a prior drain generation (issue 132) —
 * a Pane lingering alive at its prompt from yesterday's drain — is never this
 * drain's slot to spend, so it is excluded here; otherwise those phantom slots
 * would permanently shrink a fresh drain's effective cap.
 */
function isOccupyingSlot(run: ActiveRun): boolean {
  return run.status === 'running' && !run.leftover;
}

/**
 * The trailing "— N blocked awaiting you (issue(s) …)" clause the drain-end stop
 * message carries when the drain ran to completion but some Runs parked blocked
 * (issue 137). Empty when nothing parked blocked, so a clean drain reads exactly
 * as before. The blocked ids' one-line reasons live in the journal's per-Run
 * list; the stop message just names who is waiting.
 */
function blockedAwaitingClause(ids: readonly number[]): string {
  if (ids.length === 0) return '';
  const noun = ids.length === 1 ? 'issue' : 'issues';
  return ` — ${ids.length} blocked awaiting you (${noun} ${ids.join(', ')})`;
}

/**
 * The trailing "— N timed out awaiting salvage (issue(s) …)" clause (issue
 * 170): named SEPARATELY from `blockedAwaitingClause` so a timeout kill (no
 * Receipt at all) never reads as an ordinary "blocked awaiting you" — the
 * drain-end reason must name it as its own distinct thing.
 */
function timeoutSalvageClause(ids: readonly number[]): string {
  if (ids.length === 0) return '';
  const noun = ids.length === 1 ? 'issue' : 'issues';
  return ` — ${ids.length} timed out awaiting salvage (${noun} ${ids.join(', ')})`;
}

/**
 * Normalize the cap: at least one slot, integer. A non-positive or NaN cap
 * would make a drain that starts nothing (useless), so we floor it at 1 and let
 * the UI surface the effective value.
 */
export function normalizeCap(maxConcurrent: number): number {
  if (!Number.isFinite(maxConcurrent)) return 1;
  return Math.max(1, Math.floor(maxConcurrent));
}

/**
 * Whether starting a drain right now has any real work ahead of it, and — when
 * it does not — the truthful reason the Drain control shows instead of a dead
 * click (issue 90).
 *
 * The drain has work when at least one issue is **startable now or unblockable
 * by the drain itself**: `open` with every dependency either already `done`,
 * itself drain-startable (the drain will run it first), or `wip` **with a live
 * Run** (`runningIssueIds` — the coming `done` flip lands without the human).
 * A plain `wip` (parked HITL, or claimed by another session) is *awaiting the
 * human*, so it never counts as satisfiable — an all-parked backlog must read
 * unavailable, not "the drain will sort it out".
 *
 * PURE and derived from the same `BacklogIssue` statuses `planDrain` plans
 * over, so the control and the coordinator agree by construction. Reasons:
 *   - `no issues` — the backlog is empty.
 *   - `nothing eligible — all issues done` — the batch is finished.
 *   - `nothing eligible — X wip awaiting you, Y running, Z blocked` — only the
 *     non-zero parts, in that order.
 */
export interface DrainAvailability {
  /** True when a drain started now would actually start (or unblock) work. */
  available: boolean;
  /** The truthful inline reason when unavailable; null when available. */
  reason: string | null;
}

export function drainAvailability(
  issues: BacklogIssue[],
  runningIssueIds: readonly number[] = [],
): DrainAvailability {
  if (issues.length === 0) return { available: false, reason: 'no issues' };

  const running = new Set(runningIssueIds);
  const byId = new Map(issues.map((i) => [i.id, i]));

  // Fixed point: the set of open issues the drain can eventually start. A
  // dependency is satisfiable when it is done, will be landed by a live Run,
  // or is itself drain-startable. Cycles and missing/parked dependencies never
  // satisfy, so they stay out of the set.
  const startable = new Set<number>();
  const satisfiable = (depId: number): boolean => {
    const dep = byId.get(depId);
    if (dep === undefined) return false; // can't be unblocked by an absent issue
    if (dep.status === 'done') return true;
    if (dep.status === 'wip' && running.has(dep.id)) return true;
    return startable.has(dep.id);
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const issue of issues) {
      if (issue.status !== 'open' || startable.has(issue.id)) continue;
      if (issue.dependsOn.every(satisfiable)) {
        startable.add(issue.id);
        grew = true;
      }
    }
  }
  if (startable.size > 0) return { available: true, reason: null };

  const wipAwaiting = issues.filter((i) => i.status === 'wip' && !running.has(i.id)).length;
  const live = issues.filter((i) => i.status !== 'done' && running.has(i.id)).length;
  const blocked = issues.filter((i) => i.status === 'open' && !running.has(i.id)).length;

  const parts: string[] = [];
  if (wipAwaiting > 0) parts.push(`${wipAwaiting} wip awaiting you`);
  if (live > 0) parts.push(`${live} running`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  const reason =
    parts.length === 0
      ? 'nothing eligible — all issues done'
      : `nothing eligible — ${parts.join(', ')}`;
  return { available: false, reason };
}

/**
 * Plan one step of the drain. Deterministic and idempotent: calling it again
 * with the same inputs yields the same plan, so the UI can re-plan freely on
 * every state change.
 *
 * Rules:
 *  - **Startable/queued** are the eligible issues (per `eligibleForRun`) that do
 *    NOT already have a Run, in ascending id order. The first `freeSlots` are
 *    startable; the rest queue. `freeSlots = cap − (running Runs)`.
 *  - **Drain stop** — a Run that ended `blocked` with NO Receipt (a Worker that
 *    died mid-exit, state genuinely unknown) stops the drain immediately (no new
 *    Runs start; in-flight Runs finish on their own). A Run whose Receipt
 *    DECLARES `outcome: blocked` (`isBlockedPark`, issue 137) does NOT stop the
 *    drain — like a parked HITL Run (`isParkedHitl`, issue 64) it parks and the
 *    drain continues past it, reported in `blockedParkedIssueIds`. Otherwise the
 *    drain is complete when nothing is running and nothing is eligible.
 *  - When the drain is stopping, `startable` is emptied — the whole point of a
 *    stop is to open no further Panes. `queued` still reports what was left
 *    un-started, for the UI to explain.
 *  - **Overlap-aware slot-fill (issue 171)** — an eligible issue whose
 *    predicted footprint (its `touches:` frontmatter, or a CONFIG `hot_files`
 *    entry its body mentions) collides with a Run already occupying a slot,
 *    or with another issue already picked to start this round, is skipped for
 *    that slot rather than co-scheduled; a later, disjoint issue fills the
 *    slot instead. The skip is reported in `overlapNotices`, never silent.
 */
export function planDrain(input: DrainInput): DrainPlan {
  const cap = normalizeCap(input.maxConcurrent);
  const runningCount = input.activeRuns.filter(isOccupyingSlot).length;
  const freeSlots = Math.max(0, cap - runningCount);

  // Any issue with a Run already tracked is off the table — regardless of that
  // Run's status. A `finished` Run's issue is `done` on disk (never eligible
  // anyway); a `blocked`/`stopped` Run's issue must not be silently restarted
  // inside the same drain.
  const activeIds = new Set(input.activeRuns.map((r) => r.issueId));

  const finishedUnmergedIds = input.finishedUnmergedIds ?? [];

  const eligible = [...input.issues]
    .sort((a, b) => a.id - b.id)
    .filter(
      (issue) =>
        !activeIds.has(issue.id) && eligibleForRun(issue, input.issues, finishedUnmergedIds),
    )
    .map((issue) => issue.id);

  const waitingOnMerge = waitingOnMergeIssues(input.issues, finishedUnmergedIds);

  const issueById = new Map(input.issues.map((i) => [i.id, i]));

  // The declared-blocked PARKS (issue 137): non-leftover Runs whose Receipt
  // declares `outcome: blocked`. They no longer halt the drain — each parks
  // awaiting the human while everything else keeps scheduling — but they are
  // reported so the stop message, the drain-end journal, and the Attention
  // surface can say "N blocked awaiting you" instead of a premature stop.
  // Ascending + deduped (defensive; one Run per issue in practice).
  const blockedParkedIssueIds = [
    ...new Set(input.activeRuns.filter(isBlockedPark).map((r) => r.issueId)),
  ].sort((a, b) => a - b);

  // Only a GENUINELY blocked Run halts the drain: one that ended `blocked` with
  // NO Receipt (the Worker died mid-exit, state unknown — issue 137's
  // conservative case). A declared-blocked PARK (`isBlockedPark`, issue 137) and
  // a parked HITL Run (`isParkedHitl`, issue 64) are both success-adjacent states
  // the drain skips and keeps scheduling past — their issues stay in `activeIds`,
  // their dependents stay excluded by eligibility. A LEFTOVER blocked Run from a
  // prior drain (issue 132) likewise never halts THIS drain — a stale Pane from
  // yesterday is not the current drain's concern, and letting it stop a
  // freshly-started drain was part of the phantom-slot bug.
  const blocked =
    input.activeRuns.find(
      (r) =>
        r.status === 'blocked' &&
        !r.leftover &&
        !isParkedHitl(r, issueById.get(r.issueId)) &&
        !isBlockedPark(r),
    ) ?? null;

  let drain: DrainDecision;
  if (input.midMerge) {
    // main is mid-merge (a partial afk-merge conflict): refuse to start anything
    // until it's resolved or aborted — never drain on top of a conflicted index.
    drain = {
      stop: true,
      reason: 'mid-merge',
      blockedIssueId: null,
      blockedParkedIssueIds,
      message:
        'Stopped: main is mid-merge — resolve the conflict or abort the merge before draining.',
    };
  } else if (blocked) {
    drain = {
      stop: true,
      reason: 'run-blocked',
      blockedIssueId: blocked.issueId,
      blockedParkedIssueIds,
      message: `Stopped: the Run on issue ${blocked.issueId} reported blocked.`,
    };
  } else if (runningCount === 0 && eligible.length === 0) {
    // The drain ran to completion: nothing running, nothing eligible. When some
    // Runs parked blocked along the way (issue 137), the drain still FINISHED —
    // it did not halt on them — so the message stays "no eligible issue remains"
    // (which `classifyDrainStop` reads as a finished drain) and appends who is
    // awaiting the human, rather than reporting a run-blocked stop. A pending
    // timeout-salvage strand (issue 170) gets its OWN named clause — it must
    // never be silently folded into "no eligible" with no further explanation.
    const timeoutSalvageIssueIds = [...new Set(input.timeoutSalvageIssueIds ?? [])].sort(
      (a, b) => a - b,
    );
    drain = {
      stop: true,
      reason: 'no-eligible',
      blockedIssueId: null,
      blockedParkedIssueIds,
      message: `Stopped: no eligible issue remains${blockedAwaitingClause(blockedParkedIssueIds)}${timeoutSalvageClause(timeoutSalvageIssueIds)}.`,
    };
  } else {
    drain = { stop: false, reason: null, blockedIssueId: null, blockedParkedIssueIds, message: '' };
  }

  // Fill the free slots in ascending id order — every eligible issue starts in
  // its own worktree like any other (issue 147, ADR-0021): solo-chaining and its
  // single integration-branch slot are retired now that a dependency's work
  // reaches main via the auto-merge lane rather than a shared solo commit. No
  // further Panes open once the drain is stopping.
  //
  // Overlap-aware scheduling (issue 171): a candidate whose predicted
  // footprint collides with a Run already occupying a slot, or with another
  // issue already picked to start THIS round, is skipped for now (it stays
  // queued and gets an `overlapNotices` entry) rather than co-scheduled — the
  // whole point being that a disjoint issue further down the list still fills
  // the slot instead of the drain just running fewer Runs than the cap allows.
  const hotFiles = input.hotFiles ?? [];
  const footprintOf = new Map<number, string[]>();
  const footprintFor = (id: number): string[] => {
    const cached = footprintOf.get(id);
    if (cached) return cached;
    const issue = issueById.get(id);
    const footprint = issue ? predictedFootprint(issue, hotFiles) : [];
    footprintOf.set(id, footprint);
    return footprint;
  };
  // Seed with every Run already occupying a slot — a fresh start must never
  // collide with what's already in flight, not just with its round-mates.
  const committed: { issueId: number; footprint: string[] }[] = input.activeRuns
    .filter(isOccupyingSlot)
    .map((r) => ({ issueId: r.issueId, footprint: footprintFor(r.issueId) }));

  const startable: number[] = [];
  const overlapNotices: OverlapNotice[] = [];
  if (!drain.stop) {
    for (const id of eligible) {
      if (startable.length >= freeSlots) break;
      const footprint = footprintFor(id);
      let deferred = false;
      for (const c of committed) {
        const path = footprintOverlap(c.footprint, footprint);
        if (path) {
          overlapNotices.push({ issueId: id, blockingIssueId: c.issueId, path });
          deferred = true;
          break;
        }
      }
      if (deferred) continue;
      startable.push(id);
      committed.push({ issueId: id, footprint });
    }
  }
  const startableSet = new Set(startable);
  const queued = drain.stop ? eligible : eligible.filter((id) => !startableSet.has(id));

  return { startable, queued, drain, waitingOnMerge, overlapNotices };
}
