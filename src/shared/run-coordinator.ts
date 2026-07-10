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
 * The issue ids that must run SOLO on the integration branch because they sit on
 * a dependency chain being drained (issue 111, option 2). An issue is
 * solo-chained when it shares a dependency edge — in EITHER direction (it
 * `depends_on` the other, or the other `depends_on` it) — with another issue
 * that is **not yet `done`**. Both endpoints of such an edge are returned.
 *
 * Why either direction, and why "not-done":
 *  - A DEPENDENT Run must build on its dependency's committed work. That work is
 *    on the integration branch only if the dependency itself ran solo (its
 *    `commitFinishedMain` landed there) rather than on a sibling `afk/NN`
 *    branch. So the DEPENDENCY must be kept solo too — hence both endpoints.
 *  - Edges to an already-`done` issue don't force solo: a dependency finished
 *    before this drain has its work merged into the integration branch already,
 *    and a dependency finished *during* this drain was itself solo-chained while
 *    its dependent was still open, so its work is on the integration branch by
 *    the time the dependent runs. Ignoring done-edges is what keeps a whole
 *    batch that all `depends_on` a finished foundation issue from being forced
 *    solo — genuine independents still parallelize (issue 111 out-of-scope note).
 *
 * PURE and derived from `BacklogIssue.dependsOn`/`status` alone, so the
 * coordinator, the isolation marking, and the tests agree by construction.
 */
export function soloChainedIssueIds(issues: BacklogIssue[]): Set<number> {
  const notDoneIds = new Set(issues.filter((i) => i.status !== 'done').map((i) => i.id));
  const solo = new Set<number>();
  for (const issue of issues) {
    if (!notDoneIds.has(issue.id)) continue;
    for (const dep of issue.dependsOn) {
      // An edge counts only when BOTH endpoints are still in play (not-done):
      // then both must stay solo so the dependency's work reaches the
      // integration branch before the dependent builds on it.
      if (notDoneIds.has(dep)) {
        solo.add(issue.id);
        solo.add(dep);
      }
    }
  }
  return solo;
}

/** Why a drain stopped. */
export type DrainStopReason = 'no-eligible' | 'run-blocked' | 'mid-merge';

export interface DrainDecision {
  /** True when the drain should start no further Runs. */
  stop: boolean;
  /** The reason, or null while the drain is still live. */
  reason: DrainStopReason | null;
  /** When `reason` is 'run-blocked', the issue id whose Run reported blocked. */
  blockedIssueId: number | null;
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
}

/** A Run still occupies a slot only while it is `running`. */
function isOccupyingSlot(run: ActiveRun): boolean {
  return run.status === 'running';
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
 *  - **Drain stop** — a Run that reported `blocked` stops the drain immediately
 *    (no new Runs start; in-flight Runs finish on their own) — UNLESS it is a
 *    parked HITL Run (`isParkedHitl`, issue 64), which the drain skips and
 *    continues past. Otherwise the drain is complete when nothing is running
 *    and nothing is eligible.
 *  - When the drain is stopping, `startable` is emptied — the whole point of a
 *    stop is to open no further Panes. `queued` still reports what was left
 *    un-started, for the UI to explain.
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

  const eligible = [...input.issues]
    .sort((a, b) => a.id - b.id)
    .filter((issue) => !activeIds.has(issue.id) && eligibleForRun(issue, input.issues))
    .map((issue) => issue.id);

  // Only a GENUINELY blocked Run halts the drain. A parked HITL Run — its
  // Receipt declares `needs-verification` (or its HITL-marked issue ended `wip`
  // with a Receipt) — is a success state (issue 64): the drain skips its issue
  // (it stays in `activeIds`) and keeps scheduling everything else.
  const issueById = new Map(input.issues.map((i) => [i.id, i]));
  const blocked =
    input.activeRuns.find(
      (r) => r.status === 'blocked' && !isParkedHitl(r, issueById.get(r.issueId)),
    ) ?? null;

  let drain: DrainDecision;
  if (input.midMerge) {
    // main is mid-merge (a partial afk-merge conflict): refuse to start anything
    // until it's resolved or aborted — never drain on top of a conflicted index.
    drain = {
      stop: true,
      reason: 'mid-merge',
      blockedIssueId: null,
      message:
        'Stopped: main is mid-merge — resolve the conflict or abort the merge before draining.',
    };
  } else if (blocked) {
    drain = {
      stop: true,
      reason: 'run-blocked',
      blockedIssueId: blocked.issueId,
      message: `Stopped: the Run on issue ${blocked.issueId} reported blocked.`,
    };
  } else if (runningCount === 0 && eligible.length === 0) {
    drain = {
      stop: true,
      reason: 'no-eligible',
      blockedIssueId: null,
      message: 'Stopped: no eligible issue remains.',
    };
  } else {
    drain = { stop: false, reason: null, blockedIssueId: null, message: '' };
  }

  // Fill the free slots in ascending id order, but honor the single
  // integration-branch slot (issue 111): a solo-chained Run works directly on
  // the integration branch, so at most ONE may be live at a time — two would
  // collide on the shared tree. Independent Runs isolate into their own
  // worktrees and fill the remaining slots freely. A solo-chained Run that can't
  // get the slot (one is already running, or an earlier solo-chained pick took
  // it this tick) queues, exactly like a Run over the cap. No further Panes open
  // once the drain is stopping.
  const solo = soloChainedIssueIds(input.issues);
  let soloSlotTaken = input.activeRuns.some(
    (r) => isOccupyingSlot(r) && solo.has(r.issueId),
  );
  const startable: number[] = [];
  if (!drain.stop) {
    for (const id of eligible) {
      if (startable.length >= freeSlots) break;
      if (solo.has(id)) {
        if (soloSlotTaken) continue;
        soloSlotTaken = true;
      }
      startable.push(id);
    }
  }
  const startableSet = new Set(startable);
  const queued = drain.stop ? eligible : eligible.filter((id) => !startableSet.has(id));

  return { startable, queued, drain };
}
