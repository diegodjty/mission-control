import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Backlog } from '../../../shared/backlog-model';
import {
  planDrain,
  drainAvailability,
  branchGuardDecision,
  type ActiveRun,
} from '../../../shared/run-coordinator';
import { scheduledDrainSkipReason, scheduledDrainSkipMessage } from '../../../shared/scheduled-drain';
import { overlapSerializationNote } from '../../../shared/file-overlap';
import {
  unknownRepoKeyNote,
  plannedRepoHoldNote,
  nonGitRootNote,
  type IssueRepoResolution,
} from '../../../shared/run-targeting';
import { canFallBackToMain, type IsolationRun } from '../../../shared/isolation-policy';
import { isNotableDrainActivity } from '../../../shared/workbench-memory';
import { latestReceiptOutcomeFor } from '../../../shared/receipt-audit';
import { resolveWorkerEffort, resolveWorkerModel } from '../../../shared/worker-model';
import { resolveRunTimeoutMinutesFrom } from '../../../shared/run-timeout';
import type { RunLogRecord, RunTarget, GitBranchStatusResult, ProjectView } from '../../../shared/ipc-contract';
import type { RunStatus } from '../../../shared/run-state';
import type { ShellEvent } from '../../../shared/shell-model';
import type { DispatcherAction } from '../../../shared/action-authority';
import { slugOf, RECEIPT_AUDIT_GRACE_MS } from './appHelpers';
import { newRun, type TrackedRun } from './appTypes';

/** What the branch-awareness prompt (issue 167) is holding a drain start for. */
export type DrainBranchPromptTarget = {
  kind: 'drain';
  cap: number;
  /** The in-scope issue selection (issue 192) the resumed start carries through, if any. */
  selectedIds?: readonly number[];
};

/**
 * What the branch-awareness prompt is holding a scheduled-drain ARM for (issue
 * 195): the same protected-branch/detached-HEAD guard the manual Drain shows,
 * but caught at the moment you press "Schedule drain" — while you can still act
 * — instead of only silently skipping at fire time (`scheduledDrainSkipReason`).
 * Resuming (Create/Switch/Schedule-anyway) arms the schedule rather than
 * starting a drain now; the fire-time skip remains the backstop if you land
 * back on a protected branch before it fires.
 */
export type ScheduleBranchPromptTarget = {
  kind: 'schedule';
  /** Wall-clock fire time, epoch ms — armed unchanged once the branch is resolved. */
  fireAt: number;
  cap: number;
  /** The in-scope issue selection (issue 192) the armed schedule carries through, if any. */
  selectedIds?: readonly number[];
};

export interface DrainDeps {
  backlog: Backlog | null;
  projectPath: string | null;
  activeProject: ProjectView | null;
  runs: TrackedRun[];
  setRuns: Dispatch<SetStateAction<TrackedRun[]>>;
  setFocusedId: Dispatch<SetStateAction<number | null>>;
  runLog: RunLogRecord[];
  /** Live mirror of `runLog`, read by the journal-write grace-window timer. */
  runLogRef: { current: RunLogRecord[] };
  /** Live mirror of the ambient activity notes, read by the same timer. */
  activityNotesRef: { current: { id: string; label: string }[] };
  /** Live mirror of `projectPath`, so a timer firing after a switch can skip. */
  projectPathRef: { current: string | null };
  runStatusOf: (run: TrackedRun) => RunStatus;
  isIsolated: (run: TrackedRun) => boolean;
  needsIsolation: (run: TrackedRun) => boolean;
  midMerge: boolean;
  finishedUnmergedIds: number[];
  issueRepoResolutions: Map<number, IssueRepoResolution>;
  repoForIssueId: (issueId: number) => string;
  workbenchPathsForRun: { issuesRoot: string; completionsRoot: string } | null;
  logNote: (id: string, action: DispatcherAction, label: string) => void;
  applyShellEvent: (event: ShellEvent) => void;
  branchStatus: GitBranchStatusResult | null;
  notUnderGit: boolean;
  setGitInitPrompt: (v: { cap: number } | null) => void;
  setGitInitError: (v: string | null) => void;
  setBranchPrompt: (
    v:
      | { kind: 'run'; target: RunTarget }
      | DrainBranchPromptTarget
      | ScheduleBranchPromptTarget
      | null,
  ) => void;
  setBranchPromptMode: (v: 'choose' | 'create' | 'switch') => void;
  setBranchPromptError: (v: string | null) => void;
}

export interface Drain {
  draining: boolean;
  drainMessage: string;
  debriefAvailable: boolean;
  cap: number;
  setCap: Dispatch<SetStateAction<number>>;
  /**
   * The drain start post branch-guard (the git-init/eligibility gates still
   * run) — used to resume a branch prompt once it's resolved. `selectedIds`
   * (issue 192) scopes the drain to that issue set; omitted/undefined means
   * every eligible issue is in scope, the whole-backlog behavior.
   */
  startDrain: (chosenCap: number, selectedIds?: readonly number[]) => void;
  /** The Map's "Drain" control: branch-aware, the entry point the UI calls. */
  guardedStartDrain: (chosenCap: number, selectedIds?: readonly number[]) => void;
  /** Bypasses the notUnderGit gate — the "Initialize git" / "Drain serially" dialog action. */
  proceedDrain: (chosenCap: number, selectedIds?: readonly number[]) => void;
  /**
   * The scheduled-drain fire path (issue 191, ADR-0024): re-checks every gate
   * `guardedStartDrain`/`startDrain` would, but a gate that would PROMPT
   * instead SKIPS — fires a "scheduled drain skipped — <reason>" notification
   * and never starts, since nobody is there to answer a dialog at fire time.
   * `selectedIds` (issue 192) scopes the fired drain to that issue set;
   * omitted means every eligible issue is in scope, same as a manual press.
   */
  scheduledFire: (chosenCap: number, selectedIds?: readonly number[]) => void;
  stopDrain: () => void;
  /** Marks the "Debrief this drain" affordance consumed. */
  dismissDebrief: () => void;
  /** Clears all drain state on a Project switch. */
  reset: () => void;
}

/**
 * The drain-coordinator seam (issue 186, re-scope of 172): the drain loop
 * expressed as a pure re-plan against the Run Coordinator (`planDrain`), the
 * per-drain generation (`drainSeq`) that tells a leftover Pane from a prior
 * drain apart from this one's own Runs, and the journal-baseline bookkeeping
 * that gives each drain's journal entry exactly its own delta.
 *
 * The spawn/telemetry glue — resolving each startable issue's worker tier/
 * effort/timeout and stamping its drain generation — lives here too, since
 * it's inseparable from the re-plan effect that decides what to start.
 */
export function useDrain(deps: DrainDeps): Drain {
  const {
    backlog,
    projectPath,
    activeProject,
    runs,
    setRuns,
    setFocusedId,
    runLog,
    runLogRef,
    activityNotesRef,
    projectPathRef,
    runStatusOf,
    isIsolated,
    needsIsolation,
    midMerge,
    finishedUnmergedIds,
    issueRepoResolutions,
    repoForIssueId,
    workbenchPathsForRun,
    logNote,
    applyShellEvent,
    branchStatus,
    notUnderGit,
    setGitInitPrompt,
    setGitInitError,
    setBranchPrompt,
    setBranchPromptMode,
    setBranchPromptError,
  } = deps;

  const [draining, setDraining] = useState(false);
  const [cap, setCap] = useState(2);
  const [drainMessage, setDrainMessage] = useState('');
  const [debriefAvailable, setDebriefAvailable] = useState(false);

  // Monotonic per-drain sequence, so each drain's stopped/halted note gets a
  // stable, deduped id (issue 66), and a leftover Pane from an earlier drain
  // generation is told apart from this one's own Runs (issue 132).
  const drainSeq = useRef<number>(0);
  // What was ALREADY in the Run log / activity strip when the current drain
  // started, so the journal entry carries exactly THIS drain's story — the
  // delta — not the Project's whole history. Snapshotted in `proceedDrain`.
  const drainLogBaseline = useRef<Set<string>>(new Set<string>());
  const drainNotableBaseline = useRef<Set<string>>(new Set<string>());
  // The last drain sequence whose journal write was scheduled — "written once
  // per drain": the user-stop and Coordinator-stop paths can't both fire it.
  const drainJournalSeq = useRef<number>(0);
  // The in-scope issue selection for the CURRENT drain (issue 192, ADR-0024):
  // set once at `proceedDrain` and read by the re-plan effect below on every
  // pass, since a drain's scope doesn't change mid-run. `undefined` (the
  // default — a manual Drain press never passes one) means every eligible
  // issue is in scope, identical to today's whole-backlog behavior.
  const drainScopeRef = useRef<readonly number[] | undefined>(undefined);

  // Write the drain's journal entry (issue 73, ADR-0015): when a drain ends —
  // any stop reason — ONE dated summary lands in the workbench project's
  // `memory/journal/`, built from THIS drain's Run-log delta plus its notable
  // events (adoptions, finished-without-receipt), and auto-committed in main.
  // Once per drain (both stop paths funnel here), after one Receipt grace
  // window — a drain often ends on the `done` flip a beat before the final
  // Run's Receipt is ingested, and the journal should name that Run too.
  // Legacy Projects: no memory dir; the guard makes both halves inert.
  const writeDrainJournalFor = useCallback(
    (reason: string): void => {
      if (projectPath === null || activeProject?.kind !== 'workbench') return;
      const seq = drainSeq.current;
      if (drainJournalSeq.current >= seq) return;
      drainJournalSeq.current = seq;
      const journalPath = projectPath;
      const logBaseline = drainLogBaseline.current;
      const notableBaseline = drainNotableBaseline.current;
      setTimeout(() => {
        // A Project switch mid-window: this journal belongs to the old
        // Project; writing it against the new one would be a lie — skip.
        if (projectPathRef.current !== journalPath) return;
        const records = runLogRef.current.filter((rec) => !logBaseline.has(rec.id));
        const notables = activityNotesRef.current
          .filter((a) => !notableBaseline.has(a.id) && isNotableDrainActivity(a.id))
          .map((a) => a.label);
        void window.mc
          .writeDrainJournal({ projectPath: journalPath, reason, records, notables })
          .then((result) => {
            // Same Project-switch guard as the write itself: a stale offer
            // must never surface against whatever Project is now open.
            if (result.offerDebrief && projectPathRef.current === journalPath) {
              setDebriefAvailable(true);
            }
          })
          .catch(() => {});
      }, RECEIPT_AUDIT_GRACE_MS);
    },
    [projectPath, activeProject, projectPathRef, runLogRef, activityNotesRef],
  );

  // The actual drain start (issue 158 split this out of `startDrain`, below):
  // everything that happens once every refusal gate has passed. Called
  // directly by the "Initialize git" / "Drain serially" dialog actions so
  // neither has to re-run the notUnderGit gate it just resolved.
  const proceedDrain = useCallback(
    (chosenCap: number, selectedIds?: readonly number[]): void => {
      drainScopeRef.current = selectedIds;
      setCap(Math.max(1, Math.floor(chosenCap) || 1));
      setDrainMessage('');
      setDebriefAvailable(false);
      setDraining(true);
      // Each drain gets its own sequence so its stopped/halted note (issue 66)
      // carries a stable, deduped id.
      drainSeq.current += 1;
      // Journal baselines (issue 73): what predates this drain is not this
      // drain's story — the entry is built from the delta past these sets.
      drainLogBaseline.current = new Set(runLogRef.current.map((rec) => rec.id));
      drainNotableBaseline.current = new Set(activityNotesRef.current.map((a) => a.id));
      // The drain loop drives the Run Coordinator (`planDrain`) directly
      // (ADR-0022) — no orchestrator session to spin up here.
      applyShellEvent({ kind: 'run-started' });
    },
    [applyShellEvent, runLogRef, activityNotesRef],
  );

  const startDrain = useCallback(
    (chosenCap: number, selectedIds?: readonly number[]): void => {
      // Refuse to drain onto a mid-merge main (issue 24) — resolve/abort first.
      if (midMerge) {
        setDrainMessage(
          'Cannot drain: main is mid-merge — resolve the conflict or Abort the merge first.',
        );
        return;
      }
      // Drain honesty (issue 90): the Map disables the control when nothing is
      // startable/unblockable, but a click can land in the beat before the
      // watch push re-disables it. Refuse here with the same truthful reason
      // rather than spinning a Dispatcher session up over nothing. (If
      // eligibility vanishes AFTER this guard passes, the plan effect below
      // ends the drain immediately with the normal no-eligible stop fact.)
      const gate = drainAvailability(
        backlog?.issues ?? [],
        runs.filter((r) => runStatusOf(r) === 'running').map((r) => r.target.issueId),
      );
      if (!gate.available) {
        setDrainMessage(`Cannot drain: ${gate.reason}.`);
        return;
      }
      // Non-git workspace root + a concurrency ask above 1 (issue 158,
      // ADR-0017): explain the limitation and offer Initialize git rather than
      // silently letting issue 157's engine clamp/serialize behind the scenes.
      if (notUnderGit && Math.max(1, Math.floor(chosenCap) || 1) > 1) {
        setGitInitError(null);
        setGitInitPrompt({ cap: chosenCap });
        return;
      }
      proceedDrain(chosenCap, selectedIds);
    },
    [midMerge, backlog, runs, runStatusOf, notUnderGit, proceedDrain, setGitInitError, setGitInitPrompt],
  );

  // Branch-aware drain start (issue 167): a drain on a protected branch or a
  // detached HEAD is caught here, BEFORE `startDrain`'s own gates run — so the
  // human resolves the branch first and every gate below sees the branch they
  // actually chose.
  const guardedStartDrain = useCallback(
    (chosenCap: number, selectedIds?: readonly number[]): void => {
      const decision = branchGuardDecision(branchStatus);
      // Same "never fail open while loading" rule as guardedStartRun (issue
      // 176) — the Drain control is disabled for this same window.
      if (decision === 'pending') return;
      if (decision === 'prompt') {
        setBranchPromptMode('choose');
        setBranchPromptError(null);
        setBranchPrompt(
          selectedIds === undefined
            ? { kind: 'drain', cap: chosenCap }
            : { kind: 'drain', cap: chosenCap, selectedIds },
        );
        return;
      }
      startDrain(chosenCap, selectedIds);
    },
    [branchStatus, startDrain, setBranchPromptMode, setBranchPromptError, setBranchPrompt],
  );

  // Scheduled-drain fire path (issue 191, ADR-0024): the SAME gates
  // `guardedStartDrain`/`startDrain` check, evaluated purely and up front
  // (`scheduledDrainSkipReason`) so a gate that would PROMPT interactively
  // instead SKIPS the fire — no dialog is ever shown for a scheduled drain
  // (ADR-0024). A HITL park mid-drain is a separate, later code path (issue
  // 64) and is unaffected: it only runs once the drain has already started.
  const scheduledFire = useCallback(
    (chosenCap: number, selectedIds?: readonly number[]): void => {
      const cap = Math.max(1, Math.floor(chosenCap) || 1);
      const availability = drainAvailability(
        backlog?.issues ?? [],
        runs.filter((r) => runStatusOf(r) === 'running').map((r) => r.target.issueId),
      );
      const skip = scheduledDrainSkipReason({ branchStatus, midMerge, notUnderGit, cap, availability });
      if (skip !== null) {
        if (projectPath !== null) {
          void window.mc
            .notifyScheduledDrainSkipped({ projectPath, reason: scheduledDrainSkipMessage(skip) })
            .catch(() => {});
        }
        return;
      }
      // Every gate passed exactly like a manual press of Drain now — the same
      // entry point, so it re-derives (not re-decides) the same outcome. The
      // schedule's in-scope selection (issue 192) rides through unchanged.
      guardedStartDrain(cap, selectedIds);
    },
    [backlog, runs, runStatusOf, branchStatus, midMerge, notUnderGit, projectPath, guardedStartDrain],
  );

  const stopDrain = useCallback((): void => {
    setDraining(false);
    const message = 'Drain stopped by you — in-flight Runs keep going.';
    setDrainMessage(message);
    logNote(`drain-stopped:${drainSeq.current}`, 'relay', message);
    // A user stop is a drain end like any other (issue 73): journal it.
    writeDrainJournalFor(message);
  }, [logNote, writeDrainJournalFor]);

  const dismissDebrief = useCallback((): void => {
    setDebriefAvailable(false);
  }, []);

  const reset = useCallback((): void => {
    setDraining(false);
    setDrainMessage('');
    setDebriefAvailable(false);
    drainScopeRef.current = undefined;
  }, []);

  // --- The drain loop, expressed as a pure re-plan ------------------------
  // On any change to the backlog, the tracked Runs, or the cap, ask the Run
  // Coordinator what to do. Startable issues get a fresh Pane; a stop condition
  // ends the drain with its reason. This is reactive (no timer): a Run reaching
  // `done` (disk → backlog push) or its session exiting frees a slot and
  // re-triggers this effect, which auto-starts the next queued Run.
  //
  // Before opening those Panes, isolation is reconciled (ADR-0002): the Git/
  // Worktree Adapter puts a lone Run on `main` and gives each Run its own
  // worktree once 2+ are concurrent, then hands back each Run's cwd — so a
  // parallel Run's Pane spawns inside its worktree, never the shared checkout.
  //
  // This effect no longer re-fires on every ~1.5s poll tick (issue 30): its only
  // status input, `runStatusOf`, now derives from the value-guarded scan
  // (`committedStatusById`), whose identity is stable across no-change ticks — so
  // `applyIsolation` runs when the backlog / tracked Runs / cap actually change,
  // not once per scan. It still early-returns when nothing new is startable, so a
  // steady-state drain issues no reconcile at all.
  useEffect(() => {
    if (!draining || !backlog || projectPath === null) return;

    // Issues whose `repo:` key doesn't resolve are excluded from the plan and
    // must not stall their siblings (issue 72), but for two DIFFERENT reasons
    // (issue 96, ADR-0017):
    //   - `planned` — the repo is declared but not yet created (planned-first).
    //     The issue is HELD, not errored: once its creating issue makes the
    //     repo, it resolves and runs. Surfaced once as a plain hold note.
    //   - `unknownKey` — the key names neither an existing nor a declared repo
    //     (a typo/misconfig). Flagged distinctly as an error, as before.
    // Either way the issue is dropped from `plannable` (its dependents stay
    // blocked naturally — a missing dependency is an unmet dependency).
    const plannable = backlog.issues.filter((issue) => {
      const resolution = issueRepoResolutions.get(issue.id);
      if (resolution === undefined || resolution.ok) return true;
      if (resolution.reason === 'planned') {
        logNote(
          `repo-planned:${issue.id}:${resolution.repoKey}`,
          'relay',
          plannedRepoHoldNote(issue.id, resolution.repoKey),
        );
      } else {
        logNote(
          `repo-unresolved:${issue.id}:${resolution.unknownKey}`,
          'relay',
          unknownRepoKeyNote(
            issue.id,
            resolution.unknownKey,
            Object.keys(activeProject?.repos ?? {}),
          ),
        );
      }
      return false;
    });

    // Each Run carries the outcome its latest Receipt DECLARED (or null when
    // none exists) so the Coordinator can tell a parked HITL Run — a success
    // the drain continues past — from a genuinely blocked one that halts it
    // (`isParkedHitl`, issue 64). Declared state only, never prose heuristics.
    const activeRuns: ActiveRun[] = runs.map((r) => ({
      issueId: r.target.issueId,
      status: runStatusOf(r),
      receiptOutcome: latestReceiptOutcomeFor(runLog, r.target.issueId),
      // A Run started by an EARLIER drain generation is a leftover phantom
      // (issue 132): a `claude` Pane still lingering alive from yesterday's
      // drain that never flipped `done` or wrote a Receipt, so run-state reads
      // it `running` forever. It must not occupy a slot in — nor halt — this
      // fresh drain (its issue is still guarded against re-start). A manual Run
      // (drainGeneration null) or one this drain started counts as before.
      leftover: r.drainGeneration !== null && r.drainGeneration < drainSeq.current,
    }));
    // A dependency's frontmatter can read `done` while its `afk/` branch hasn't
    // landed on main yet (issue 147, ADR-0021) — `finishedUnmergedIds` is the
    // on-disk fact that makes the coordinator hold such a dependent as
    // "waiting on merge of NN" instead of starting it off a main still missing
    // its own prerequisite.
    const plan = planDrain({
      issues: plannable,
      maxConcurrent: cap,
      activeRuns,
      midMerge,
      finishedUnmergedIds,
      // The overlap-scheduling god-file list (issue 171): any two eligible
      // issues both predicted to touch one of these (or sharing a declared
      // `touches:` footprint) serialize instead of co-scheduling into a
      // guaranteed merge collision.
      hotFiles: backlog.hotFiles,
      // The in-scope issue selection this drain was started with (issue 192),
      // or undefined for "every eligible issue" — set once at `proceedDrain`
      // and stable for the drain's whole lifetime.
      selectedIds: drainScopeRef.current,
    });

    // Overlap-forced serialization is never silent (issue 171): note each
    // deferred pairing once, keyed on the pair + path so a live re-plan that
    // reports the same overlap round after round doesn't spam the history.
    for (const notice of plan.overlapNotices) {
      const [lo, hi] = [notice.issueId, notice.blockingIssueId].sort((a, b) => a - b);
      logNote(
        `overlap:${lo}-${hi}:${notice.path}`,
        'relay',
        overlapSerializationNote(notice.issueId, notice.blockingIssueId, notice.path),
      );
    }

    if (plan.drain.stop) {
      setDraining(false);
      setDrainMessage(plan.drain.message);
      logNote(`drain-halted:${drainSeq.current}`, 'relay', plan.drain.message);
      // The drain ended (issue 73): one journal entry into the workbench
      // memory, whatever the stop reason.
      writeDrainJournalFor(plan.drain.message);
      return;
    }

    const have = new Set(runs.map((r) => r.target.issueId));
    const startableIssues = plan.startable
      .filter((id) => !have.has(id))
      .map((id) => backlog.issues.find((i) => i.id === id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i));

    if (startableIssues.length === 0) return;

    // The set of Runs that need isolation = the tracked Runs that still need a
    // worktree — live, or finished-unmerged — plus the ones about to start, each
    // carrying its own target repo (issue 72): isolation keys on concurrency PER
    // REPO, so two startable issues in different repos each stay solo in their
    // own repo while 2+ in one repo get worktrees. Solo-chaining is retired
    // (issue 147, ADR-0021): every startable issue isolates purely by
    // concurrency, in a worktree like any other — a dependent's dependency
    // reaches main via the auto-merge lane, never a shared solo commit.
    // Terminal SOLO Runs (finished/blocked/parked/stopped on `main`) lingering
    // on screen are scoped OUT via `needsIsolation` (issue 134): feeding them in
    // used to inflate concurrency and hand a spurious worktree cut that kept
    // `.afk-parallel` stuck on across drain rounds. This is the same set the
    // manual "▶ Run" path uses.
    const isolationRuns: IsolationRun[] = [
      ...runs.filter(needsIsolation).map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
        repoPath: repoForIssueId(r.target.issueId),
      })),
      ...startableIssues.map((i) => ({
        issueId: i.id,
        slug: slugOf(i.fileName),
        repoPath: repoForIssueId(i.id),
      })),
    ];

    let cancelled = false;

    const addRuns = (
      cwdOf: (issueId: number) => string,
      issuesToStart: typeof startableIssues = startableIssues,
    ): void => {
      const additions = issuesToStart.map((issue) => {
        // The declared drain-worker tier (issue 154): the issue's `model:`
        // override, else the project CONFIG `worker_model` default, else sonnet
        // — so unattended draining runs cheap instead of inheriting the
        // expensive interactive default.
        const tier = resolveWorkerModel({
          configDefault: backlog.workerModel,
          issueModel: issue.model,
        });
        const effort = resolveWorkerEffort({
          tier,
          configDefault: backlog.workerEffort,
          issueEffort: issue.effort,
        });
        return newRun(
          {
            issueId: issue.id,
            issueFileName: issue.fileName,
            issueTitle: issue.title,
            projectPath: cwdOf(issue.id),
            // Workbench Runs carry the explicit workbench paths in the spawn
            // prompt (issue 72); null for a legacy Project.
            workbench: workbenchPathsForRun,
            // From this slice on, drain Runs execute HEADLESS (issue 139,
            // ADR-0001 amendment): spawned as `claude -p --output-format
            // stream-json` and watched via a read-only Feed, never a Pane. A
            // manual "▶ Run" (startRun) leaves this unset → its interactive Pane.
            headless: true,
            // Set ONLY here (the drain path); the manual "▶ Run" and Quick-fix
            // paths never set model/effort, so they stay on the interactive
            // defaults.
            model: tier,
            // The declared drain-worker effort (issue 155): the issue's
            // `effort:` override, else the CONFIG `worker_effort` override, else
            // DERIVED from the resolved tier (haiku→low, sonnet→medium,
            // opus/fable→high). A second cost lever beside the model, so a
            // mechanical issue doesn't burn deliberate reasoning tokens.
            effort,
            // The `run_timeout` kill timeout, from CONFIG (default 30 min):
            // armed by the Headless Session Manager so a hung drain Run is
            // killed rather than watched forever. Drain-only — a manual "▶
            // Run" leaves this unset. Blunt-kill mitigation (issue 170): the
            // issue's own `run_timeout` override wins outright when set;
            // otherwise the CONFIG default scales with this Run's resolved
            // effort tier, so a `high`/`xhigh`/`max` Worker doing deliberately
            // harder work (a big refactor) gets more runway before a kill is
            // blunt rather than protective (the 2026-07-19 incident: issue 161
            // finished correctly at ~30m and was killed before it could commit).
            runTimeoutMs:
              resolveRunTimeoutMinutesFrom(
                backlog.runTimeoutMinutes,
                issue.runTimeoutMinutes,
                effort,
              ) * 60_000,
          },
          // Stamp the Run with THIS drain's generation (issue 132) so a later
          // drain can tell it apart from a leftover Pane it should not count.
          drainSeq.current,
        );
      });
      setRuns((prev) => {
        const present = new Set(prev.map((r) => r.target.issueId));
        const fresh = additions.filter((a) => !present.has(a.target.issueId));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      setFocusedId((cur) => cur ?? additions[0]?.target.issueId ?? cur);
    };

    void window.mc
      .applyIsolation({ projectPath, runs: isolationRuns })
      .then((result) => {
        if (cancelled) return;
        // (`Map` the identifier is the Map view component here, so use a record.)
        const cwdById: Record<number, string> = {};
        for (const p of result.placements) cwdById[p.issueId] = p.cwd;
        // A non-isolatable target's concurrency clamp (issue 157, ADR-0017):
        // 2+ Runs contending for one un-worktree-able tree get only ONE live
        // placement back; the rest come back in `queuedIssueIds` with no cwd
        // at all — they must NOT get a Pane this round. Leaving them out of
        // `runs` keeps them eligible, so the next re-plan (the live Run
        // finishing frees the slot) picks them up naturally, one at a time.
        const queued = new Set(result.queuedIssueIds);
        const toStart = startableIssues.filter((issue) => !queued.has(issue.id));
        // Surface the "not a git repository" attention item once per path
        // (issue 157) instead of silently serializing the queue unexplained.
        for (const path of result.nonGitRoots) {
          logNote(`non-git-root:${path}`, 'relay', nonGitRootNote(path));
        }
        // Newly-started Runs spawn in their resolved cwd (a worktree in parallel
        // mode; the issue's own target repo when solo). Already-live Panes keep
        // the cwd they spawned in — a running PTY can't be re-parented; that
        // live solo→parallel re-parent is left to the batch QA walkthrough /
        // Merge slice.
        addRuns((id) => cwdById[id] ?? repoForIssueId(id), toStart);
      })
      .catch(() => {
        if (cancelled) return;
        // Isolation failed (a git worktree error, a disk error, a partial
        // reconcile that threw mid-apply). Falling back to the checkout is safe
        // ONLY for a lone Run per repo; spawning startable Runs on a shared
        // checkout while others are live in the SAME repo is the concurrent-main
        // collision isolation exists to prevent (issue 28). Count, per repo, the
        // Runs that would end up live on that checkout: the startable ones
        // (all fall back to their repo checkout) plus any Run already running
        // solo there (an isolated Run keeps its worktree, so it doesn't count).
        // If ANY repo would hold 2+, STOP the drain and surface the error.
        const liveOnCheckout = new globalThis.Map<string, number>();
        for (const r of runs) {
          if (runStatusOf(r) !== 'running' || isIsolated(r)) continue;
          const repo = repoForIssueId(r.target.issueId);
          liveOnCheckout.set(repo, (liveOnCheckout.get(repo) ?? 0) + 1);
        }
        for (const issue of startableIssues) {
          const repo = repoForIssueId(issue.id);
          liveOnCheckout.set(repo, (liveOnCheckout.get(repo) ?? 0) + 1);
        }
        const safe = [...liveOnCheckout.values()].every((count) => canFallBackToMain(count));
        if (safe) {
          addRuns((id) => repoForIssueId(id));
        } else {
          setDraining(false);
          const message =
            'Isolation failed while starting parallel Runs — stopped to avoid ' +
            'running multiple agents on main. Resolve the worktree/git error, ' +
            'then start the drain again.';
          setDrainMessage(message);
          logNote(`drain-halted:isolation:${drainSeq.current}`, 'relay', message);
        }
      });

    return () => {
      cancelled = true;
    };
    // `runLog` is a dependency so a Receipt that lands a beat after its session
    // exits re-plans the drain with the park now visible (issue 64).
  }, [
    draining,
    backlog,
    runs,
    cap,
    projectPath,
    midMerge,
    runStatusOf,
    isIsolated,
    needsIsolation,
    runLog,
    writeDrainJournalFor,
    issueRepoResolutions,
    repoForIssueId,
    workbenchPathsForRun,
    activeProject,
    logNote,
    finishedUnmergedIds,
    setRuns,
    setFocusedId,
  ]);

  return {
    draining,
    drainMessage,
    debriefAvailable,
    cap,
    setCap,
    startDrain,
    guardedStartDrain,
    proceedDrain,
    scheduledFire,
    stopDrain,
    dismissDebrief,
    reset,
  };
}
