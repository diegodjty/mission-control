import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pane } from './Pane';
import { Map } from './Map';
import { ProjectBar } from './ProjectBar';
import { DispatcherPanel } from './DispatcherPanel';
import type { Backlog, IssueStatus } from '../../shared/backlog-model';
import type {
  DispatcherTarget,
  ProjectView,
  RunLogRecord,
  RunTarget,
} from '../../shared/ipc-contract';
import {
  renderCompletionEvent,
  toCompletionEvent,
} from '../../shared/dispatcher-input-contract';
import { buildSubmitSequence } from '../../shared/dispatcher-feed';
import {
  recordActivity,
  resolveActivity,
  type DispatcherActivity,
} from '../../shared/dispatcher-proposal';
import {
  channelForAction,
  canFlushChat,
  reduceTyping,
  isStatusInjectionTrigger,
  INITIAL_TYPING_STATE,
  type TypingState,
} from '../../shared/dispatcher-channel';
import {
  actionForLifecycle,
  lifecycleKindForOutcome,
  reactToLifecycleEvent,
  type LifecycleEvent,
} from '../../shared/dispatcher-lifecycle';
import type { DispatcherAction } from '../../shared/dispatcher-authority';
import { shouldAutoMerge, decideDispatcherMerge } from '../../shared/dispatcher-merge';
import {
  describeDocDrift,
  detectCrossRunOverlap,
  extractDocDrift,
} from '../../shared/dispatcher-synthesis';
import { isRealCapture, isStrongOverlap } from '../../shared/dispatcher-noise-floor';
import {
  reconcileStatusModel,
  renderStatusModel,
  debounceStatusModel,
  initialStatusDebounceState,
  buildStatusSnapshotMessage,
  type DispatcherStatusModel,
  type StatusDebounceState,
} from '../../shared/dispatcher-status-model';
import {
  deriveRunStatus,
  observedIssueStatus,
  runningIssueIds,
  decideSoloCommitStep,
  type RunStatus,
  type SoloCommitPhase,
} from '../../shared/run-state';
import {
  auditMissingReceipts,
  detectReceiptStateMismatches,
  describeReceiptMismatch,
  hasReceiptFor,
  mismatchKey,
} from '../../shared/receipt-audit';
import { planDrain, type ActiveRun } from '../../shared/run-coordinator';
import { hasInFlightRun } from '../../shared/run-eligibility';
import {
  canFallBackToMain,
  isolationRunSetWith,
  type IsolationRun,
} from '../../shared/isolation-policy';
import {
  afkScanUnchanged,
  deriveWorktreeRunStates,
  dropMergedBranches,
  markBranchCommitted,
  mergeReadinessOnDisk,
  needsWorktreeCommit,
} from '../../shared/worktree-scan';
import {
  isProjectSwitch,
  scanForProject,
  type ScopedScan,
} from '../../shared/project-switch';
import { gridShape } from '../../shared/pane-grid';
import { decideWindowBootstrap } from '../../shared/window-bootstrap';
import {
  mergeResultDisplay,
  pendingMergeDisplay,
  emptyMergeDisplay,
  mergeThrewDisplay,
  type MergeDisplay,
} from '../../shared/merge-display';
import {
  clampDispatcherWidth,
  dispatcherWidthFromPointer,
  DEFAULT_DISPATCHER_WIDTH,
} from '../../shared/dispatcher-width';

/** localStorage key for the app-wide persisted Dispatcher rail width (issue 44). */
const DISPATCHER_WIDTH_KEY = 'mc.dispatcherWidth';

/**
 * How often the submit-queue re-checks the defer-while-typing gate while it is
 * holding for the user to stop typing (issue 48). Short enough that a blocking
 * prompt lands promptly once the line goes idle, long enough not to busy-spin.
 */
const DISPATCHER_TYPING_RECHECK_MS = 250;

/**
 * Grace window before the Receipt audits conclude anything (issue 57,
 * ADR-0012's debounce discipline). A Worker's Receipt can land a beat after
 * its issue's `done` flip is observed (write → watch debounce → stability
 * reads), and a `done` flip can land a beat after its Receipt — so both the
 * finished-without-receipt note and the Receipt/state-mismatch note re-check
 * the live facts after this window and stay silent when reality caught up.
 */
const RECEIPT_AUDIT_GRACE_MS = 5000;

/**
 * Collapse a (possibly multi-line) fact into one quiet ambient-log line (issue
 * 48): the activity log renders `label` as a single row, so newlines become ` · `
 * separators the way the chat feed flattens its messages.
 */
function oneLineNote(text: string): string {
  return text.trim().replace(/\s*[\r\n]+\s*/g, ' · ');
}

/** Read the persisted rail width, clamped; falls back to the default when unset. */
function loadDispatcherWidth(): number {
  try {
    const raw = window.localStorage.getItem(DISPATCHER_WIDTH_KEY);
    return raw === null ? DEFAULT_DISPATCHER_WIDTH : clampDispatcherWidth(Number.parseFloat(raw));
  } catch {
    return DEFAULT_DISPATCHER_WIDTH;
  }
}

/** The `NN-slug` for a Run, from its issue file name (`NN-slug.md`). */
function slugOf(fileName: string): string {
  return fileName.replace(/\.md$/, '');
}

type View = 'map' | 'pane';

/**
 * One Run the UI is tracking: its target plus the observable facts
 * (`deriveRunStatus` in run-state turns these into running/finished/blocked/
 * stopped). `stopSignal` is bumped to kill its session on demand.
 */
interface TrackedRun {
  target: RunTarget;
  sessionAlive: boolean;
  stoppedByUser: boolean;
  stopSignal: number;
}

function newRun(target: RunTarget): TrackedRun {
  return { target, sessionAlive: true, stoppedByUser: false, stopSignal: 0 };
}

/**
 * The Project Window: a header with a Map/Pane switch. The Map (issue 02) is
 * the birds-eye backlog view; the Pane (issue 01) is the live interactive
 * terminal. Issue 03 wires a single Run; issue 05 makes the Map self-update
 * from disk. Issue 06 adds **draining with a concurrency cap**: the pure Run
 * Coordinator (run-coordinator) decides, from the live backlog + the cap + the
 * Runs already in flight, which eligible issues start now, which queue, and
 * when to stop — and this component opens a fresh Pane per started Run and
 * re-plans on every backlog/Run-status change so queued Runs auto-start as
 * slots free.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<View>('map');
  const [paneStatus, setPaneStatus] = useState('starting…');

  // The live backlog + resolved Project path, lifted from the Map so the
  // Coordinator can plan against them.
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  // --- Project Registry state (issue 09, ADR-0004) -------------------------
  // This Window shows one Project; the single backend arbitrates ownership so
  // no two Windows manage the same repo. `activeRepoPath` (from the registry)
  // is what the Map loads.
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [newRepoPath, setNewRepoPath] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  // Mirrors `activeRepoPath` for the callbacks/effects that need the CURRENT
  // active repo without re-subscribing (issue 26): they compare it against an
  // incoming path via `isProjectSwitch` to decide whether to reset per-Project
  // state, and a live ref keeps that decision correct without widening deps.
  const activeRepoPathRef = useRef<string | null>(null);
  useEffect(() => {
    activeRepoPathRef.current = activeRepoPath;
  }, [activeRepoPath]);

  // Bootstrap this Window exactly once: pick up any repo the opener queued, else
  // re-attach to whatever this Window already owns, else open NO Project (empty
  // state). The pure `decideWindowBootstrap` makes that choice — and never
  // resolves to the backend cwd, so a plain new Window can't phantom-claim the
  // app's own repo (issue 14).
  //
  // The ref guard makes this a true one-shot: React StrictMode double-invokes
  // effects in dev (setup → cleanup → setup), which previously let a duplicate
  // `listProjects` read consume the queued target and drop into the cwd
  // fallback. The queued target is now peeked (not consumed) on the main side,
  // and this guard ensures we act on it exactly once regardless.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void window.mc.listProjects().then((list) => {
      setProjects(list.projects);
      const decision = decideWindowBootstrap({
        pendingOpen: list.pendingOpen,
        activeRepoPath: list.activeRepoPath,
      });
      if (decision.kind === 'open') {
        void openProjectHere(decision.repoPath);
      } else if (decision.kind === 'reattach') {
        setActiveRepoPath(decision.repoPath);
      }
      // 'empty' → leave activeRepoPath null; the empty "open a Project" state
      // renders. We never open the backend cwd here.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any Window opening/closing/switching a repo changes ownership everywhere —
  // refresh this Window's switcher so a repo freed elsewhere becomes openable.
  // If THIS Window's active repo is handed a different one out from under it
  // (another Window switched the shared active Project), reset the per-Project
  // run/merge state too, so the new Project never inherits the old one's Runs
  // or indicators (issue 26).
  useEffect(() => {
    const off = window.mc.onProjectRegistryChanged(() => {
      void window.mc.listProjects().then((list) => {
        setProjects(list.projects);
        const next = list.activeRepoPath;
        if (next !== null && isProjectSwitch(activeRepoPathRef.current, next)) {
          resetForProjectSwitch();
        }
        setActiveRepoPath((cur) => next ?? cur);
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Run state -----------------------------------------------------------
  const [runs, setRuns] = useState<TrackedRun[]>([]);
  // Each solo Run's Receipt-aware auto-commit lifecycle (issues 25 + 59), keyed
  // by issue id. "Finished" for the solo commit means *done flip AND Receipt
  // present*: the skill writes the Receipt LAST, so committing on the flip
  // observation alone raced it and left the Receipt untracked on `main`,
  // failing every later Merge preflight. The pure `decideSoloCommitStep` drives
  // each observation: wait for the Receipt within a grace window (timers below),
  // commit once with everything, and pick up a late straggler Receipt with an
  // idempotent follow-up. Cleared for an id when a genuinely fresh Run of it
  // starts; a rejected commit reverts the phase so a later observation retries.
  // (Plain records, not Maps — the `Map` identifier here is the backlog-Map
  // React component imported above.)
  const soloCommitPhases = useRef<Record<number, SoloCommitPhase>>({});
  // The per-issue Receipt grace timers, and which ids' windows have elapsed.
  const soloGraceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const soloGraceElapsed = useRef<Set<number>>(new Set<number>());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  // Which tile (if any) is maximized to fill the Pane area; null = tiled grid.
  const [maximizedId, setMaximizedId] = useState<number | null>(null);

  // --- Run log (issue 34, ADR-0013) ----------------------------------------
  // The Completion-block records for the active Project, newest first — read
  // from Receipts (the sole capture input, issue 57). Loaded from disk when a
  // Project opens (so the feed survives closing Panes / the app / restarts)
  // and upserted as the Receipt edge ingests each Run's Receipt.
  const [runLog, setRunLog] = useState<RunLogRecord[]>([]);
  // Live mirror of `projectPath` so an async result that resolves after a
  // Project switch can tell it belongs to the previous Project and skip the
  // feed upsert.
  const projectPathRef = useRef<string | null>(null);
  // Live mirror of `runLog` for the Receipt audits' grace-window re-checks
  // (issue 57): a timer that fires after the window must judge the CURRENT
  // log, not the render it was scheduled in.
  const runLogRef = useRef<RunLogRecord[]>([]);
  useEffect(() => {
    runLogRef.current = runLog;
  }, [runLog]);
  // Which issues' ended Runs the finished-without-receipt audit has already
  // scheduled/noted, and which Receipt/state mismatches have been surfaced —
  // so each yields at most ONE passive note (issue 57), never a per-render or
  // per-tick repeat.
  const receiptAudited = useRef<Set<number>>(new Set<number>());
  const mismatchSurfaced = useRef<Set<string>>(new Set<string>());

  // --- Drain state ---------------------------------------------------------
  const [draining, setDraining] = useState(false);
  const [cap, setCap] = useState(2);
  const [drainMessage, setDrainMessage] = useState('');

  // --- Dispatcher state (issue 35, ADR-0010) -------------------------------
  // The conversational orchestrator for a drain: spun up WHEN A DRAIN STARTS
  // (a single manual Run stays a bare Pane), one per Project, dismissable. Null
  // when no drain has started this Project session. `sessionId` is set once its
  // chat Pane spawns, so we can feed it each Run's Completion block (structured
  // summary — never raw Pane scroll). `dispatcherFed` tracks which Runs' blocks
  // we've already fed, so a re-capture/re-render doesn't double-feed.
  const [dispatcher, setDispatcher] = useState<{
    target: DispatcherTarget;
    sessionId: string | null;
  } | null>(null);
  const dispatcherFed = useRef<Set<string>>(new Set<string>());
  // The Dispatcher rail's width (issue 44): user-adjustable by dragging the
  // divider between the Map and the panel, within a sensible min/max, persisted
  // app-wide so it survives closing/reopening the panel and the app. Changing it
  // resizes the chat Pane, whose ResizeObserver (issue 12) reflows the terminal.
  const [dispatcherWidth, setDispatcherWidth] = useState<number>(loadDispatcherWidth);
  // Serialized submit queue for the Dispatcher feed (issue 41). Each Completion
  // block is TYPED then SUBMITTED with a separate Enter write; the queue drains
  // one block fully (type → settle → submit → settle) before starting the next,
  // so blocks arriving close together in a parallel drain are submitted as
  // DISTINCT messages, never concatenated into one input line.
  const dispatcherQueue = useRef<string[]>([]);
  const dispatcherPumping = useRef<boolean>(false);
  // The user's compose state on the Dispatcher chat's input line (issue 48,
  // ADR-0012). Folded from the chat Pane's keystrokes, it is the defer-while-
  // typing gate the pump consults before flushing: a programmatic write is held
  // while the user is mid-compose and only lands once the input line is idle, so
  // the app never interleaves with the user's typing ("prompt over prompt").
  const dispatcherTyping = useRef<TypingState>(INITIAL_TYPING_STATE);
  // The Dispatcher's authority activity log (issue 36, ADR-0011): non-blocking
  // actions it took on its own (silent/passive — shown as quiet notes) and the
  // three-item blocking list it must propose (merge-conflict, abort-drain, HITL
  // sign-off — shown with one-click approve/reject that don't execute until
  // approved).
  const [dispatcherActivities, setDispatcherActivities] = useState<DispatcherActivity[]>([]);
  // Lifecycle-event reactions (issue 37): which lifecycle events (keyed
  // `<kind>:<runId>`) the Dispatcher has already reacted to, so a re-render /
  // re-scan doesn't re-notify or re-propose. `discardTargets` maps a
  // discard-and-continue proposal's id to the worktree it would discard, so
  // approving it executes the real issue-22 discard (when there is a worktree).
  const lifecycleReacted = useRef<Set<string>>(new Set<string>());
  // Keyed by proposal id (`Map` the component name shadows the global, so a plain
  // record avoids the collision).
  const discardTargets = useRef<Record<string, { issueId: number; slug: string }>>({});
  // Cross-Run synthesis (issue 38): which shared seams the Dispatcher has already
  // surfaced as a cross-Run pattern, so a re-scan doesn't re-narrate the same
  // "these Runs all hit X" line each poll.
  const overlapSurfaced = useRef<Set<string>>(new Set<string>());
  // Ground-truth status re-grounding (issue 43): the last status-model text fed
  // to the Dispatcher, so it is re-fed only when the reconciled done/wip/open/
  // finished-unmerged picture actually changes — not on every render/poll.
  const statusRefreshSig = useRef<string | null>(null);
  // Debounce backward status moves (issue 49, ADR-0012): the state carried
  // between reconcile checkpoints so a transient mid-reconcile regression (the
  // false "05/06/07 regressed to open — merge is failing" blip) is held until it
  // persists across a further checkpoint before being surfaced. `seenReconciled`
  // makes the advance idempotent under StrictMode's double-invoke: the debounce
  // advances exactly once per DISTINCT reconciled model, never twice for one.
  const statusDebounce = useRef<StatusDebounceState>(initialStatusDebounceState());
  const seenReconciled = useRef<DispatcherStatusModel | null>(null);
  const debouncedStatusModelRef = useRef<DispatcherStatusModel | null>(null);

  // --- Merge state (issue 08; issue 17) ------------------------------------
  // `mergeDisplay` is the pure selector's decision of what the Merge UI shows
  // (headline + whether/what to put in the details panel). Surfacing the
  // adapter's `output` here is what gives "see details below" an actual below.
  const [merging, setMerging] = useState(false);
  const [mergeDisplay, setMergeDisplay] = useState<MergeDisplay | null>(null);
  // The mergeable-set signature the Dispatcher has already AUTO-attempted this
  // drain (issue 46). A clean auto-merge drops the branches and a conflict sets
  // `midMerge` — both self-guard against a re-fire — but a preflight failure
  // leaves the branch set unchanged, so this stops the auto-merge effect from
  // looping on it. Reset on Project switch / dispatcher dismissal.
  const autoMergeSig = useRef<string | null>(null);

  // --- Mid-merge state (issue 24) ------------------------------------------
  // `main` is left mid-merge when a partial `afk-merge.sh` run committed some
  // slugs then hit a conflict (a conflicted index / MERGE_HEAD). It is polled
  // from disk as part of the afk/ scan and DERIVED from that scan below (scoped
  // to the active Project — issue 26), never held as its own state that could
  // outlive a Project switch. While true, a new drain/Run is refused and an
  // Abort affordance is offered so a non-git user can return `main` to a clean
  // state.
  const [aborting, setAborting] = useState(false);

  // --- Isolated-Run completion (issue 13/30) -------------------------------
  // An isolated Run works in its own worktree on an `afk/NN-slug` branch and
  // flips its issue to `done` there — a change the main-checkout backlog watcher
  // never sees. Its completion is now read from the SAME on-disk `afk/` scan that
  // drives the Map (issue 30): the branch's committed status is the authoritative
  // "finished" source (issue 15), so there is one source of truth for both the
  // Pane tile and the Map — no separate per-Run status poll racing the scan, and
  // no running↔finished flicker. See `committedStatusById` below.

  // Isolated Runs whose finished worktree MC has already asked to commit onto its
  // `afk/` branch (issue 30). The commit is now EVENT-driven — fired once on the
  // finished transition the scan reports (worktree `done`, branch tip not) —
  // instead of on every status-read tick (the old poll committed a git write per
  // tick). Cleared for an id when a fresh Run of it starts / it is dismissed /
  // discarded / merged, so a later Run of the same id commits its own work.
  const committedWorktreeIds = useRef<Set<number>>(new Set<number>());

  // The auto-commit failure (if any) observed for each isolated Run, keyed by
  // issue id (issue 22, corr-5). A finished Run whose commit failed shows a
  // distinct "commit failed" state carrying this message — the failure is
  // surfaced, not swallowed. Null/absent means no failure seen.
  const [worktreeCommitErrors, setWorktreeCommitErrors] = useState<
    Record<number, string | null>
  >({});

  // --- On-disk afk/ scan (issue 16) ----------------------------------------
  // The ground truth for which issues have an in-flight or finished-but-unmerged
  // isolated Run lives in the Project's `afk/NN-slug` worktrees + committed
  // branches, NOT in `runs` above — so the Map's progress indicators and the
  // Merge affordance keep working after every Pane is closed (which drops the
  // in-memory Runs). Polled from disk whenever a Project is open; the pure
  // `worktree-scan` selectors turn these facts into what the UI shows.
  //
  // Tagged with the Project it was scanned for (issue 26): the scan is only ever
  // read through `scanForProject` against the active Project, so a scan taken
  // for the previous Project — whether still in state right after a switch or
  // kept after a transient scan error — can never mark the new Project's issues
  // (its id-keyed indicators would otherwise bleed: A's "05 finished-unmerged"
  // lighting up B's issue 05 and offering a bogus Merge). Null = not scanned yet.
  const [afkScan, setAfkScan] = useState<ScopedScan | null>(null);

  // Reset ALL per-Project run/scan/merge state (issue 26). Switching the active
  // Project used to change only `activeRepoPath`, leaving the previous Project's
  // Runs (and their Panes), on-disk scan, observed worktree statuses, and merge
  // message in place — which bled indicators across Projects and offered a bogus
  // Merge against branches that don't exist in the new Project. Called on every
  // real switch (see `isProjectSwitch`), BEFORE the Map reloads, so the new
  // Project starts from a blank slate and shows no indicator until its own fresh
  // scan lands. `backlog`/`projectPath` are cleared too so the Coordinator never
  // plans the new Project against the old one's backlog in the transition.
  const resetForProjectSwitch = useCallback((): void => {
    setRuns([]);
    setFocusedId(null);
    setMaximizedId(null);
    setDraining(false);
    setDrainMessage('');
    // The Dispatcher is per-Project (ADR-0010): drop it on a switch so the new
    // Project never inherits the previous one's orchestrator. Unmounting its
    // panel kills the session.
    setDispatcher(null);
    dispatcherFed.current.clear();
    dispatcherQueue.current = [];
    dispatcherPumping.current = false;
    dispatcherTyping.current = INITIAL_TYPING_STATE;
    setDispatcherActivities([]);
    lifecycleReacted.current.clear();
    discardTargets.current = {};
    overlapSurfaced.current.clear();
    statusRefreshSig.current = null;
    statusDebounce.current = initialStatusDebounceState();
    seenReconciled.current = null;
    debouncedStatusModelRef.current = null;
    setMerging(false);
    setAborting(false);
    setMergeDisplay(null);
    autoMergeSig.current = null;
    setAfkScan(null);
    setWorktreeCommitErrors({});
    soloCommitPhases.current = {};
    for (const timer of Object.values(soloGraceTimers.current)) clearTimeout(timer);
    soloGraceTimers.current = {};
    soloGraceElapsed.current.clear();
    committedWorktreeIds.current.clear();
    // The Run-log feed is per-Project (issue 34): clear it and the Receipt
    // audit bookkeeping so the new Project starts blank and loads its own log.
    setRunLog([]);
    receiptAudited.current.clear();
    mismatchSurfaced.current.clear();
    setBacklog(null);
    setProjectPath(null);
  }, []);

  const openProjectHere = useCallback(async (repoPath: string): Promise<void> => {
    // Only open on an explicit path; an empty path is a no-op, never a claim on
    // the backend cwd (issue 14).
    if (!repoPath.trim()) return;
    const res = await window.mc.openProject({ repoPath });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      // Opening a different Project than the one active resets its state (issue 26).
      if (isProjectSwitch(activeRepoPathRef.current, res.activeRepoPath)) {
        resetForProjectSwitch();
      }
      setActiveRepoPath(res.activeRepoPath);
      setNewRepoPath('');
    }
  }, [resetForProjectSwitch]);

  const switchProject = useCallback(async (repoPath: string): Promise<void> => {
    const res = await window.mc.switchProject({ repoPath });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      // Clear the previous Project's Runs/scan/merge state before the Map loads
      // the new one, so nothing bleeds across the switch (issue 26).
      if (isProjectSwitch(activeRepoPathRef.current, res.activeRepoPath)) {
        resetForProjectSwitch();
      }
      setActiveRepoPath(res.activeRepoPath);
    }
  }, [resetForProjectSwitch]);

  const openInNewWindow = useCallback((): void => {
    const repoPath = newRepoPath.trim();
    if (!repoPath) return;
    void window.mc.openWindow({ repoPath });
    setNewRepoPath('');
  }, [newRepoPath]);

  // Browse… for a Project folder with the native OS chooser (issue 19). The
  // chosen path just populates the repo-path field, so the existing Open here /
  // Open in new Window buttons then act on it exactly as a pasted path would —
  // one picker serving both flows. Cancelling the dialog resolves to a null
  // path and is a clean no-op (the field keeps whatever was there).
  const browseForFolder = useCallback(async (): Promise<void> => {
    const { path } = await window.mc.pickProjectFolder();
    if (path) setNewRepoPath(path);
  }, []);

  /** True when a Run works in a worktree on an `afk/` branch (not `main`). */
  const isIsolated = useCallback(
    (run: TrackedRun): boolean =>
      projectPath !== null && run.target.projectPath !== projectPath,
    [projectPath],
  );

  /** The issue's current status on disk, or null if not observed yet. */
  const issueStatusOf = useCallback(
    (issueId: number): IssueStatus | null =>
      backlog?.issues.find((i) => i.id === issueId)?.status ?? null,
    [backlog],
  );

  // The on-disk `afk/` scan, scoped to the ACTIVE Project (issue 26). Every
  // worktree/merge indicator — AND every isolated Run's completion (issue 30) —
  // derives from `activeScan.branches`, never the raw `afkScan`, so a scan taken
  // for the previous Project contributes nothing the instant a new Project is
  // active. `midMerge` is likewise derived here, so it can't outlive a switch.
  const activeScan = useMemo(() => scanForProject(afkScan, projectPath), [afkScan, projectPath]);
  const midMerge = activeScan.midMerge;

  // Each isolated Run's COMMITTED issue status, keyed by issue id, read from the
  // single on-disk scan (issue 30). This replaces the old separate per-Run status
  // poll: a Run is "finished" once its work is committed on its `afk/` branch
  // (issue 15), which the scan already reads — so the Pane tile and the Map share
  // ONE source and can't disagree tick-to-tick (no running↔finished flicker). Its
  // identity only changes when the scan's facts actually change (the scan setState
  // is value-guarded below), so `runStatusOf` and the drain re-plan stay stable
  // across the ~1.5s no-change ticks.
  const committedStatusById = useMemo(() => {
    const map: Record<number, IssueStatus | null> = {};
    for (const b of activeScan.branches) map[b.issueId] = b.committedStatus;
    return map;
  }, [activeScan]);

  const runStatusOf = useCallback(
    (run: TrackedRun): RunStatus =>
      deriveRunStatus({
        sessionAlive: run.sessionAlive,
        stoppedByUser: run.stoppedByUser,
        issueStatus: observedIssueStatus({
          isolated: isIsolated(run),
          mainStatus: issueStatusOf(run.target.issueId),
          worktreeStatus: committedStatusById[run.target.issueId] ?? null,
        }),
      }),
    [issueStatusOf, isIsolated, committedStatusById],
  );

  // Commit a solo Run's finished work on `main` via the adapter, moving its
  // phase (issues 25 + 59). A rejected commit reverts the phase so a later
  // observation retries; the adapter commit itself is idempotent on a clean tree.
  const commitSoloRun = useCallback(
    (run: TrackedRun, nextPhase: SoloCommitPhase): void => {
      if (projectPath === null) return;
      const id = run.target.issueId;
      const prior = soloCommitPhases.current[id] ?? 'unstarted';
      soloCommitPhases.current[id] = nextPhase;
      void window.mc
        .commitFinishedMain({ projectPath, slug: slugOf(run.target.issueFileName) })
        .catch(() => {
          // Transient/failed commit: allow a later observation to retry.
          soloCommitPhases.current[id] = prior;
        });
    },
    [projectPath],
  );

  // Auto-commit a finished SOLO Run's work on `main` (issue 25), Receipt-aware
  // (issue 59). A solo Run's agent flips its issue to `done`, emits its block,
  // and writes its Receipt (`issues/completions/NN-slug.md`) LAST — so a commit
  // fired on the `done`-flip observation raced the Receipt, which then sat
  // untracked on `main` and failed every later Merge's clean-tree preflight.
  // "Finished" for this commit therefore means *done flip AND Receipt present*:
  // the pure `decideSoloCommitStep` waits for the Receipt within the same grace
  // window as the finished-without-receipt audit (no stall — after the window
  // the work commits without it and the audit's note is the signal), and a late
  // straggler Receipt is committed by a follow-up observation. Isolated Runs
  // commit on their own `afk/` branch (the worktree-commit effect below), so
  // they are skipped here. Re-runs on every Receipt ingest (`runLog`), so a
  // Receipt landing mid-wait commits at once instead of at the window's end.
  useEffect(() => {
    if (projectPath === null) return;
    for (const run of runs) {
      if (isIsolated(run)) continue;
      const id = run.target.issueId;
      const step = decideSoloCommitStep({
        runStatus: runStatusOf(run),
        isolated: false,
        phase: soloCommitPhases.current[id] ?? 'unstarted',
        receiptPresent: hasReceiptFor(runLog, id),
        graceElapsed: soloGraceElapsed.current.has(id),
      });
      if (step.act === 'commit') {
        // A pending grace timer is superseded by this commit (e.g. the Receipt
        // landed mid-wait) — cancel it so it can't fire a second decision.
        const pending = soloGraceTimers.current[id];
        if (pending !== undefined) {
          clearTimeout(pending);
          delete soloGraceTimers.current[id];
        }
        commitSoloRun(run, step.nextPhase);
      } else if (step.act === 'schedule-grace') {
        soloCommitPhases.current[id] = 'waiting';
        const timer = setTimeout(() => {
          delete soloGraceTimers.current[id];
          soloGraceElapsed.current.add(id);
          // The window passed: judge the CURRENT facts — a Receipt that landed
          // meanwhile is included either way (`git add -A`), and a Project
          // switch means this Run's commit is no longer ours to make.
          if (projectPathRef.current !== projectPath) return;
          const followUp = decideSoloCommitStep({
            // It was `finished` when the wait began; a `done` flip does not
            // regress (and the adapter re-checks the status before committing).
            runStatus: 'finished',
            isolated: false,
            phase: soloCommitPhases.current[id] ?? 'unstarted',
            receiptPresent: hasReceiptFor(runLogRef.current, id),
            graceElapsed: true,
          });
          if (followUp.act === 'commit') commitSoloRun(run, followUp.nextPhase);
        }, RECEIPT_AUDIT_GRACE_MS);
        soloGraceTimers.current[id] = timer;
      }
    }
  }, [runs, runLog, projectPath, isIsolated, runStatusOf, commitSoloRun]);

  // Auto-commit a finished ISOLATED Run's worktree onto its `afk/` branch (issue
  // 15), now EVENT-driven off the on-disk scan (issue 30). The old status-read
  // poll performed this git write on EVERY ~1.5s tick — a "read" that mutated —
  // and, racing the separate scan poll, made rows flicker running↔finished. Here
  // MC commits ONCE, exactly when the scan first reports the finished transition
  // (`needsWorktreeCommit`: worktree `done`, branch tip not `done`), keyed by
  // issue id so a re-scan never re-fires it. On success the scan is optimistically
  // advanced to committed-`done` (mirrors the merge optimistic drop, issue 29) so
  // the branch doesn't read `commit-failed` for the ~1.5s until the next scan; a
  // genuine failure is recorded and surfaced (a "commit failed" state) and NOT
  // auto-retried every tick — the user discards it (issue 22).
  useEffect(() => {
    if (projectPath === null) return;
    for (const b of activeScan.branches) {
      if (!needsWorktreeCommit(b)) continue;
      const id = b.issueId;
      if (committedWorktreeIds.current.has(id)) continue;
      committedWorktreeIds.current.add(id);
      const slug = b.slug;
      void window.mc
        .commitFinishedWorktree({ projectPath, slug })
        .then((res) => {
          if (res.committed) {
            // Reflect the committed `done` at once so there is no commit-failed
            // flash before the next scan confirms it (a safe optimistic prefix).
            setAfkScan((prev) =>
              prev && prev.projectPath === projectPath
                ? { ...prev, branches: markBranchCommitted(prev.branches, slug) }
                : prev,
            );
          } else if (res.error) {
            // The commit was attempted and genuinely failed: surface it (distinct
            // "commit failed" state) and leave the id marked so it isn't retried
            // every tick — the user resolves/discards it.
            setWorktreeCommitErrors((prev) =>
              prev[id] === res.error ? prev : { ...prev, [id]: res.error },
            );
          }
          // committed=false, error=null ⇒ nothing to commit (already clean); the
          // id stays marked so we don't re-probe every tick.
        })
        .catch(() => {
          // Transient IPC/git error: allow a later scan tick to retry this Run.
          committedWorktreeIds.current.delete(id);
        });
    }
  }, [activeScan, projectPath]);

  // Poll the Project's on-disk `afk/` state on an interval, independent of the
  // tracked Runs (issue 16). This is what lets the Map still show a finished-
  // unmerged Run — and still offer its Merge — after its Pane has been closed
  // and its in-memory Run dropped. Runs whenever a Project is open; clears when
  // none is. A transient git error just skips that tick.
  useEffect(() => {
    if (projectPath === null) return;
    let cancelled = false;
    const scan = (): void => {
      void window.mc
        .scanAfkRuns({ projectPath })
        .then((res) => {
          if (cancelled) return;
          // Tag the scan with the Project it was taken for so it is only ever
          // surfaced while that Project is active (issue 26). Keep the SAME state
          // object when the facts are unchanged (issue 30): most ~1.5s ticks
          // observe no change, and a fresh object each tick would give every
          // derived Run status / Map indicator / drain plan a new identity and
          // re-run `applyIsolation` needlessly. The value-guard keeps the scan
          // stable across no-change ticks, cutting the churn and the flicker.
          setAfkScan((prev) =>
            prev &&
            prev.projectPath === projectPath &&
            prev.midMerge === res.midMerge &&
            afkScanUnchanged(prev.branches, res.branches)
              ? prev
              : { projectPath, branches: res.branches, midMerge: res.midMerge },
          );
        })
        .catch(() => {
          // Transient read/git error: keep the last scan; the next tick retries.
          // If a switch happened first, the kept scan is tagged with the OLD
          // Project, so `scanForProject` hides it rather than showing the
          // previous Project's branches (issue 26).
        });
    };
    scan();
    const timer = setInterval(scan, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath]);

  // The issue ids whose Run session is currently LIVE (still `running`) in this
  // Window. This is the fact the on-disk scan can't supply on its own and the
  // reason a blocked/stopped Run used to read `running` forever (issue 22): a
  // worktree with no `done` commit is only `running` while a live session drives
  // it — otherwise it is `stranded`. Fed to the pure scan derivations below.
  const liveRunIssueIds = useMemo(
    () => runningIssueIds(runs, runStatusOf, (r) => r.target.issueId),
    [runs, runStatusOf],
  );

  // Pure derivations from the on-disk scan + the live-Run set: which issues show
  // `running` / `stranded` / `commit failed` / `finished (unmerged)` on the Map,
  // and whether the Merge is offered (from disk, so it survives closing Panes).
  // Memoized so their identity only changes when the scan or live set does — this
  // keeps `startRun` (which consults them to refuse a duplicate) from being
  // rebuilt on every unrelated render.
  const worktreeRunStates = useMemo(
    () => deriveWorktreeRunStates(activeScan.branches, liveRunIssueIds),
    [activeScan, liveRunIssueIds],
  );
  const worktreeRunningIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'running').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const finishedUnmergedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'finished-unmerged').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const strandedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'stranded').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const commitFailedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'commit-failed').map((s) => s.issueId),
    [worktreeRunStates],
  );

  // The issue ids that drive the Map row "running" indicator (`Map.tsx`) and the
  // detail-panel "Run in progress" label. This MUST be the status-filtered live
  // set (issue 33) — a Run that has reached `finished`/`stopped`/`blocked` but
  // whose Pane is still on screen must not keep its issue reading as "running".
  // `liveRunIssueIds` above is exactly that set (`runStatusOf` === `running`).
  const activeRunIssueIds = liveRunIssueIds;

  // Which tracked Runs are part of the isolation set once a new Run joins: every
  // Run still `running`, plus any already working in a worktree (an isolated
  // Run keeps its worktree until merged, per the Isolation Policy). A finished/
  // stopped SOLO Run on `main` is done competing for the working tree, so it is
  // NOT counted — it must never inflate the concurrency and pull the lone new
  // Run into a needless worktree.
  const needsIsolation = useCallback(
    (r: TrackedRun): boolean => runStatusOf(r) === 'running' || isIsolated(r),
    [runStatusOf, isIsolated],
  );

  // Start (or focus) a single Run — the manual "▶ Run" path from the Map.
  //
  // This routes through the SAME concurrency-keyed isolation reconcile the drain
  // uses (issue 20): starting a second Run while one is active isolates BOTH into
  // worktrees (neither stays on the shared `main` checkout); a lone Run stays
  // solo on `main`. Isolation is a function of concurrency, not of which button
  // started the Run.
  const startRun = useCallback(
    (target: RunTarget): void => {
      const tracked = runs.some((r) => r.target.issueId === target.issueId);

      // main is mid-merge (a partial afk-merge conflict, issue 24): refuse to
      // start a fresh Run on top of a conflicted index — the user resolves or
      // aborts the merge first. A Run already tracked is still surfaced below.
      if (!tracked && midMerge) return;

      // On-disk truth wins over in-memory tracking (issue 21): an issue already
      // live in a worktree, or finished-but-unmerged on its `afk/` branch, must
      // not get a second Run — even after its Pane was closed and its in-memory
      // Run dropped (which is why the in-memory `runs` check alone isn't enough).
      // Re-attaching a worktree to the committed branch clobbers finished work
      // and can push commits onto a branch a pending Merge is about to integrate.
      // The Map already hides the Run affordance for these; this is the backstop
      // for any other caller. (A still-tracked Run just gets surfaced below.)
      if (
        !tracked &&
        hasInFlightRun(target.issueId, {
          worktreeRunningIds,
          finishedUnmergedIds,
          strandedIds,
          commitFailedIds,
        })
      ) {
        return;
      }

      setView('pane');
      setFocusedId(target.issueId);

      // Already tracked → just surface it, exactly as before (no re-spawn).
      if (tracked) return;

      // A genuinely fresh Run for this id: drop any stale commit-failure left by a
      // previous Run of the same id (the isolated Run's `finished` now derives
      // from the on-disk scan, so a fresh worktree's uncommitted state can't read
      // `finished` — issue 21/30).
      setWorktreeCommitErrors((prev) => {
        if (!(target.issueId in prev)) return prev;
        const next = { ...prev };
        delete next[target.issueId];
        return next;
      });
      // ...and let a fresh Run of this id auto-commit its OWN work — clear both the
      // solo (issues 25/59) and isolated (issue 30) commit bookkeeping so it isn't
      // treated as already-committed (or already grace-elapsed) by a prior Run of
      // the same id.
      delete soloCommitPhases.current[target.issueId];
      const staleTimer = soloGraceTimers.current[target.issueId];
      if (staleTimer !== undefined) {
        clearTimeout(staleTimer);
        delete soloGraceTimers.current[target.issueId];
      }
      soloGraceElapsed.current.delete(target.issueId);
      committedWorktreeIds.current.delete(target.issueId);

      // No resolved Project path yet: can't reconcile isolation, so fall back to
      // spawning on the target's given path (a lone Run). Never blocks the Pane.
      if (projectPath === null) {
        setRuns((prev) =>
          prev.some((r) => r.target.issueId === target.issueId)
            ? prev
            : [...prev, newRun(target)],
        );
        return;
      }

      // The Runs that need isolation once this one joins = the ones still live
      // (running or in a worktree) plus the new target, deduped by issueId.
      const active: IsolationRun[] = runs.filter(needsIsolation).map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
      }));
      const isolationRuns = isolationRunSetWith(active, {
        issueId: target.issueId,
        slug: slugOf(target.issueFileName),
      });

      // Apply the resolved placements: re-point every tracked Run to its cwd —
      // a Run that was solo on `main` re-parents into its worktree when this
      // second Run turns on parallel mode (its Pane respawns there, keyed on the
      // changed cwd) — and add the new Run in its own resolved cwd.
      const place = (cwdOf: (issueId: number) => string): void => {
        setRuns((prev) => {
          const repointed = prev.map((r) => {
            const cwd = cwdOf(r.target.issueId);
            return cwd === r.target.projectPath
              ? r
              : { ...r, target: { ...r.target, projectPath: cwd } };
          });
          if (repointed.some((r) => r.target.issueId === target.issueId)) {
            return repointed;
          }
          return [...repointed, newRun({ ...target, projectPath: cwdOf(target.issueId) })];
        });
      };

      void window.mc
        .applyIsolation({ projectPath, runs: isolationRuns })
        .then((result) => {
          const cwdById: Record<number, string> = {};
          for (const p of result.placements) cwdById[p.issueId] = p.cwd;
          // A Run not in the placement set keeps its current cwd (fall back to
          // `main`); every isolated/new Run gets its resolved worktree/main cwd.
          place((id) => cwdById[id] ?? projectPath);
        })
        .catch(() => {
          // Isolation failed (a git worktree error, a partial reconcile). Falling
          // back to `main` is safe only when this would be the LONE Run; if other
          // Runs are already live (the set is 2+), opening this one on `main` is
          // the concurrent-main collision isolation exists to prevent (issue 28).
          // Surface the error and leave the live Runs untouched — don't spawn.
          if (!canFallBackToMain(isolationRuns.length)) {
            setFocusedId((cur) => (cur === target.issueId ? null : cur));
            window.alert(
              'Could not isolate this Run into its own worktree, and other Runs ' +
                'are already live — refusing to start it on main (that would run ' +
                'multiple agents on the shared checkout). Resolve the worktree/git ' +
                'error and try again.',
            );
            return;
          }
          // A lone Run: safe to open the new Pane on `main` so it still starts.
          setRuns((prev) =>
            prev.some((r) => r.target.issueId === target.issueId)
              ? prev
              : [...prev, newRun({ ...target, projectPath })],
          );
        });
    },
    [
      runs,
      projectPath,
      needsIsolation,
      midMerge,
      worktreeRunningIds,
      finishedUnmergedIds,
      strandedIds,
      commitFailedIds,
    ],
  );

  const stopRun = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId
          ? { ...r, stoppedByUser: true, stopSignal: r.stopSignal + 1 }
          : r,
      ),
    );
  }, []);

  // Maximize a tile to fill the Pane area (click its header again to restore
  // the grid). All Panes stay mounted either way, so sessions never drop.
  const toggleMaximize = useCallback((issueId: number): void => {
    setMaximizedId((cur) => (cur === issueId ? null : issueId));
    setFocusedId(issueId);
  }, []);

  // Drop a terminated Run from the grid once you've read what happened. Only
  // offered for finished/blocked/stopped Runs (a running Run is stopped first).
  const dismissRun = useCallback((issueId: number): void => {
    setRuns((prev) => prev.filter((r) => r.target.issueId !== issueId));
    setMaximizedId((cur) => (cur === issueId ? null : cur));
    setFocusedId((cur) => (cur === issueId ? null : cur));
    // Drop this Run's commit error + once-committed marker so a later Run of the
    // same id doesn't inherit a stale `commit failed` and can commit afresh
    // (issue 21/22/30).
    setWorktreeCommitErrors((prev) => {
      if (!(issueId in prev)) return prev;
      const next = { ...prev };
      delete next[issueId];
      return next;
    });
    committedWorktreeIds.current.delete(issueId);
  }, []);

  // Discard a STRANDED / commit-failed isolated Run (issue 22): force-remove its
  // worktree and delete its `afk/` branch so it stops blocking the batch. Drops
  // it from tracking and refreshes the on-disk scan so the Map/Merge update at
  // once (rather than waiting for the next poll tick). Human-triggered only.
  const discardRun = useCallback(
    (issueId: number, slug: string): void => {
      if (projectPath === null) return;
      const label = String(issueId).padStart(2, '0');
      void window.mc
        .discardAfkRun({ projectPath, slug })
        .then((res) => {
          if (!res.ok) {
            window.alert(
              `Could not discard the worktree for issue ${label}: ${res.error ?? 'unknown error'}`,
            );
            return;
          }
          setRuns((prev) => prev.filter((r) => r.target.issueId !== issueId));
          setMaximizedId((cur) => (cur === issueId ? null : cur));
          setFocusedId((cur) => (cur === issueId ? null : cur));
          setWorktreeCommitErrors((prev) => {
            if (!(issueId in prev)) return prev;
            const next = { ...prev };
            delete next[issueId];
            return next;
          });
          committedWorktreeIds.current.delete(issueId);
          // Refresh the scan immediately so the discarded Run's row/Merge clears.
          void window.mc
            .scanAfkRuns({ projectPath })
            .then((r) => setAfkScan({ projectPath, branches: r.branches, midMerge: r.midMerge }))
            .catch(() => {
              // The 1.5s poll will pick it up regardless.
            });
        })
        .catch((err: unknown) => {
          window.alert(
            `Could not discard the worktree for issue ${label}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    },
    [projectPath],
  );

  const handleRunExit = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId ? { ...r, sessionAlive: false } : r,
      ),
    );
  }, []);

  // Upsert an ingested record into the feed, keyed by its Receipt id, so a
  // superseding ingest (same issue + `finished`, changed body) replaces the
  // earlier version rather than adding a duplicate card. Newest first.
  const upsertRunLog = useCallback((record: RunLogRecord): void => {
    setRunLog((prev) => {
      const others = prev.filter((r) => r.id !== record.id);
      return [record, ...others].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
      );
    });
  }, []);

  // NOTE (issue 57, ADR-0013): there is deliberately NO scroll-capture effect
  // here. Receipts (`issues/completions/`, watched below) are the SOLE capture
  // input; the PTY tail buffer is a human peek/debug surface and never reaches
  // a parser, the status model, or the feed. A Run that ends without a Receipt
  // is surfaced honestly by the finished-without-receipt audit further down.

  // Load the active Project's persisted Run log when it opens/changes (issue 34),
  // so the feed is populated from disk and survives closing Panes, the app, and
  // restarts. Cleared when no Project is open.
  useEffect(() => {
    projectPathRef.current = projectPath;
    if (projectPath === null) {
      setRunLog([]);
      return;
    }
    let cancelled = false;
    void window.mc
      .loadRunLog({ projectPath })
      .then((res) => {
        // Apply the same noise floor on reload (issue 47): a boot-screen/empty
        // `unknown` persisted on disk must not resurface as a Run when the Project
        // reopens.
        if (!cancelled) setRunLog(res.records.filter(isRealCapture));
      })
      .catch(() => {
        // A transient read error just leaves the feed as-is; a later capture or
        // Project reopen reloads it.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // --- Receipt capture edge (issue 56, ADR-0013) ----------------------------
  // Point main's Receipt watch at the active Project: its checkout
  // `issues/completions/` plus each LIVE worktree's copy (a parallel Run's
  // Receipt lands in its own worktree and must surface live, before any Merge).
  // The worktree set comes from the same on-disk scan the Map trusts; the key
  // string keeps the effect from re-sending on every scan tick — it re-points
  // only when the set actually changes (main reconciles roots incrementally, so
  // a re-point never re-feeds: the edge dedupes by issue + `finished`).
  const receiptWorktreeKey = useMemo(
    () =>
      activeScan.branches
        .filter((b) => b.hasWorktree)
        .map((b) => b.slug)
        .sort()
        .join(','),
    [activeScan],
  );
  useEffect(() => {
    if (projectPath === null) return;
    const worktreeSlugs = receiptWorktreeKey === '' ? [] : receiptWorktreeKey.split(',');
    window.mc.watchReceipts({ projectPath, worktreeSlugs });
  }, [projectPath, receiptWorktreeKey]);

  // Ingested Receipts enter the feed EXACTLY where scroll-captured records do
  // (issue 56 acceptance: no parallel bespoke path): one upsert into `runLog`,
  // from which the Run-log card, the Dispatcher block feed, the lifecycle
  // reactions, and the status model all already derive. The edge has parsed,
  // debounced, deduped, and persisted the record; here we apply the same noise
  // floor as every other capture (ADR-0012) and scope it to the active Project
  // (the record is already persisted for ITS project either way).
  useEffect(
    () =>
      window.mc.onReceiptCaptured((msg) => {
        if (projectPathRef.current !== msg.projectPath) return;
        if (!isRealCapture(msg.record)) return;
        upsertRunLog(msg.record);
      }),
    [upsertRunLog],
  );

  // --- Feed Completion blocks to the Dispatcher (issue 35, issue 41) --------
  // As each Run finishes and its Completion block is captured into the Run log,
  // hand that STRUCTURED block to the Dispatcher session — this is the input
  // contract's stream (ADR-0009). It is built from the parsed record via the
  // pure assembler, so it can NEVER carry raw Pane scroll. Fed once per Run
  // (guarded by `dispatcherFed`), and only once the block parsed to something
  // real (outcome !== 'unknown'), so a still-streaming capture isn't fed as
  // noise.
  //
  // Submission (issue 41): a block must be SUBMITTED, not just typed. Typing the
  // text and its `\r` in one PTY write lets the claude TUI's bracketed-paste
  // handling swallow the `\r` as literal text, so the block sat unsent. Instead
  // we enqueue the block and pump the queue: for each block we TYPE the text,
  // let it settle, then SUBMIT with a SEPARATE `\r` write (`buildSubmitSequence`
  // is the pure step builder). The queue drains one block fully before the next,
  // so parallel-arriving blocks are submitted as distinct messages.
  const pumpDispatcherQueue = useCallback((sessionId: string): void => {
    if (dispatcherPumping.current) return;
    dispatcherPumping.current = true;
    const nextBlock = (): void => {
      if (dispatcherQueue.current.length === 0) {
        dispatcherPumping.current = false;
        return;
      }
      // Defer-while-typing gate (issue 48, ADR-0012): never inject while the user
      // is mid-compose. The pure `canFlushChat` reads the compose state folded
      // from the chat's keystrokes; while it says hold, we re-check shortly rather
      // than consume the message — so a queued write waits for the input line to
      // go idle instead of racing the user's typing.
      if (!canFlushChat(dispatcherTyping.current, Date.now())) {
        setTimeout(nextBlock, DISPATCHER_TYPING_RECHECK_MS);
        return;
      }
      const message = dispatcherQueue.current.shift();
      if (message === undefined) {
        dispatcherPumping.current = false;
        return;
      }
      const steps = buildSubmitSequence(message);
      let i = 0;
      const runStep = (): void => {
        if (i >= steps.length) {
          nextBlock();
          return;
        }
        const step = steps[i++];
        window.mc.writePty({ sessionId, data: step.data });
        setTimeout(runStep, step.settleMs);
      };
      runStep();
    };
    nextBlock();
  }, []);

  // Report the user's keystrokes on the Dispatcher chat so the defer gate above
  // knows when the input line is idle (issue 48). Fires only for real user input
  // into the chat terminal — the Dispatcher's own queued writes go out via
  // `writePty` and never reach this, so they can't be mistaken for typing.
  //
  // On-demand ground-truth injection (issue 52): the same input stream is where
  // we detect the user SENDING a message, and enqueue the CURRENT reconciled +
  // debounced status snapshot as quiet context. After issue 48/ADR-0012 routed
  // the `status-refresh` to the ambient log, the chat session heard nothing after
  // its seed, so "what's left?" answered from the drain-start seed (the issue-51
  // bug). Injecting the snapshot at query time re-grounds the session in reality
  // WITHOUT reintroducing per-fact chat streaming (ADR-0012) — the chat stays
  // quiet the rest of the time. The pure `isStatusInjectionTrigger` reads the
  // PRE-fold compose state (so a bare Enter on an empty prompt does not fire), and
  // `buildStatusSnapshotMessage` renders the snapshot (or null when the backlog
  // has not loaded). The snapshot rides the SAME serialized submit queue as the
  // feed, so it honours the defer-while-typing gate and never interleaves with the
  // user's own line.
  const handleDispatcherInput = useCallback(
    (data: string): void => {
      const prev = dispatcherTyping.current;
      if (isStatusInjectionTrigger(prev, data)) {
        const sessionId = dispatcher?.sessionId ?? null;
        const snapshot = buildStatusSnapshotMessage(debouncedStatusModelRef.current);
        if (sessionId !== null && snapshot !== null) {
          dispatcherQueue.current.push(snapshot);
          pumpDispatcherQueue(sessionId);
        }
      }
      dispatcherTyping.current = reduceTyping(prev, data, Date.now());
    },
    [dispatcher, pumpDispatcherQueue],
  );

  // Record a routine passive FACT as a quiet ambient-log note (issue 48,
  // ADR-0012): it appears in the activity log beside the chat rather than being
  // typed into the chat session. Deduped by id so a re-render / re-scan can't
  // double-log it. `label` carries the fact's own plain-language text.
  const logNote = useCallback(
    (id: string, action: DispatcherAction, label: string): void => {
      setDispatcherActivities((prev) =>
        prev.some((a) => a.id === id)
          ? prev
          : [...prev, recordActivity(id, action, oneLineNote(label))],
      );
    },
    [],
  );

  // Route one Dispatcher event to its channel (issue 48, ADR-0012). The pure,
  // tested `channelForAction` is the single decision: a `blocking`-tier action is
  // a conversational prompt typed into the chat PTY via the serialized queue;
  // every routine passive/silent fact becomes an ambient-log note instead — so
  // the chat carries ONLY blocking approvals + the user's own conversation.
  // Returns true when it enqueued a chat write, so the caller knows to pump.
  const surfaceEvent = useCallback(
    (id: string, action: DispatcherAction, text: string): boolean => {
      if (channelForAction(action) === 'chat') {
        dispatcherQueue.current.push(text);
        return true;
      }
      logNote(id, action, text);
      return false;
    },
    [logNote],
  );

  useEffect(() => {
    const sessionId = dispatcher?.sessionId ?? null;
    if (sessionId === null) return;
    let pumped = false;
    for (const rec of runLog) {
      // An `unknown` capture has no reliable qualitative content to synthesize,
      // so it does NOT enter the block feed here. Under the ADR-0012 noise floor
      // (issue 47) the empty/boot-screen unknowns never reach `runLog` at all —
      // `isRealCapture` drops them at capture/load. A `runLog` unknown is therefore
      // a REAL unknown with substance; it is still conveyed (with its `detail`) by
      // the ground-truth status refresh below as a "needs a look" item (issue 43,
      // narrowed by issue 47), so nothing substantive a Run emitted is lost. A
      // still-streaming capture stays unknown only until it resolves, at which
      // point it feeds here normally (the guard below is keyed by id and unknowns
      // are never marked fed).
      if (rec.outcome === 'unknown') continue;
      if (dispatcherFed.current.has(rec.id)) continue;
      dispatcherFed.current.add(rec.id);
      // A finished Run's synthesis is a ROUTINE PASSIVE fact (ADR-0012, issue 48):
      // it becomes a quiet line in the ambient activity log, NOT a message typed
      // into the chat session. `surfaceEvent` routes it there via the tested
      // `channelForAction` (synthesize is silent → log).
      const text = renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec }));
      if (surfaceEvent(`synthesize:${rec.id}`, 'synthesize', text)) pumped = true;
      // Cross-Run synthesis (issue 38, acceptance a): a block that reports doc-drift
      // (a PRD/reality contradiction) surfaces as a plain-language note. Under
      // ADR-0011 amending the plan is a passive (non-blocking) action, and under
      // ADR-0012 that passive note renders in the ambient log — not the chat.
      // Doc-drift free / "none" blocks add nothing.
      const [drift] = extractDocDrift([rec]);
      if (drift) {
        if (
          surfaceEvent(
            `doc-drift:${rec.id}`,
            'amend-plan',
            `${describeDocDrift(drift)} — the plan may need amending to reconcile it.`,
          )
        ) {
          pumped = true;
        }
      }
    }
    // Cross-Run patterns (issue 38, acceptance b/c): once ≥2 Runs touch the same
    // seam (a file, a named "… seam", a shared identifier), consolidate them into
    // ONE surfaced line instead of leaving the user to spot it across cards. The
    // detection is the pure `detectCrossRunOverlap` over the captured records.
    // Noise floor (issue 47, ADR-0012): consolidation is demoted to a RARE note —
    // `isStrongOverlap` gates it to a strong concrete overlap (a real shared
    // file/seam, not the PRD/config/skill boilerplate or a junk token), and
    // `overlapSurfaced` guards each seam so it is surfaced at most once, never the
    // per-tick "consolidate?" firehose. A weak/false overlap surfaces nothing.
    for (const group of detectCrossRunOverlap(runLog).filter(isStrongOverlap)) {
      if (overlapSurfaced.current.has(group.seam)) continue;
      overlapSurfaced.current.add(group.seam);
      const runs = group.runs
        .map((r) => (r.issueId !== null ? `issue ${String(r.issueId).padStart(2, '0')}` : r.runId))
        .join(', ');
      // A cross-Run consolidation is a passive note (ADR-0012, issue 48) → log.
      if (
        surfaceEvent(
          `overlap:${group.seam}`,
          'synthesize',
          `${group.runs.length} Runs touched ${group.seam} (${runs}) — consider a consolidated pass rather than treating each separately.`,
        )
      ) {
        pumped = true;
      }
    }
    if (pumped) pumpDispatcherQueue(sessionId);
  }, [runLog, dispatcher, pumpDispatcherQueue, surfaceEvent]);

  // --- Ground the Dispatcher's status picture in truth (issue 43) -----------
  // The Dispatcher's AUTHORITATIVE model of which issues are open/wip/done/
  // finished-unmerged is reconciled from the SAME live sources the Map uses — the
  // backlog (main-checkout truth), the on-disk `afk/` scan (incl. finished-
  // unmerged, which the backlog can't see because that `done` flip lives on the
  // `afk/` branch), and the Run log (for its unknown captures). It is NOT inferred
  // from the fed Completion-block stream, which could miss/misparse/drop a block
  // and drift the picture (the issue-35 bug: 03/04 reported "still to run" when
  // done). The blocks above remain the QUALITATIVE synthesis; status comes from
  // here. Recomputed as the backlog / scan / Run log change.
  const dispatcherStatusModel = useMemo(
    () => reconcileStatusModel({ backlog, worktreeStates: worktreeRunStates, runLog }),
    [backlog, worktreeRunStates, runLog],
  );

  // Debounce backward status moves before surfacing (issue 49, ADR-0012). Each
  // recompute of `dispatcherStatusModel` above is one reconcile CHECKPOINT: a
  // BACKWARD move (finished/finished-unmerged → open, done → not-done) is held at
  // its prior status until it persists across a further checkpoint, killing the
  // transient mid-reconcile blip; FORWARD moves surface immediately. The advance
  // is guarded so it runs once per distinct reconciled model even though
  // StrictMode double-invokes the memo (advancing twice would falsely "confirm" a
  // one-snapshot regression).
  const debouncedStatusModel = useMemo(() => {
    if (seenReconciled.current === dispatcherStatusModel && debouncedStatusModelRef.current) {
      return debouncedStatusModelRef.current;
    }
    const { model, state } = debounceStatusModel(dispatcherStatusModel, statusDebounce.current);
    statusDebounce.current = state;
    seenReconciled.current = dispatcherStatusModel;
    debouncedStatusModelRef.current = model;
    return model;
  }, [dispatcherStatusModel]);

  // Re-ground the status picture whenever it changes (a Run flipping done, a
  // branch becoming finished-unmerged, an unknown capture landing), guarded by the
  // rendered text so an unchanged model is never re-surfaced. The status refresh
  // is a ROUTINE PASSIVE fact (ADR-0012, issue 48): it renders as a quiet line in
  // the ambient log, NOT typed into the chat. It updates ONE `status-refresh` note
  // in place (rather than appending a new line each change) so the log shows the
  // current "what's left" without accreting a status entry per transition.
  useEffect(() => {
    if ((dispatcher?.sessionId ?? null) === null) return;
    const text = renderStatusModel(debouncedStatusModel);
    if (text === statusRefreshSig.current) return;
    statusRefreshSig.current = text;
    // `relay` is silent → the ambient log (channelForAction === 'log').
    const note = recordActivity('status-refresh', 'relay', oneLineNote(text));
    setDispatcherActivities((prev) => {
      const idx = prev.findIndex((a) => a.id === 'status-refresh');
      if (idx === -1) return [...prev, note];
      const next = [...prev];
      next[idx] = note;
      return next;
    });
  }, [debouncedStatusModel, dispatcher]);

  // --- React to lifecycle events mid-drain (issue 37, ADR-0007) -------------
  // Beyond the Completion-block stream above, the Dispatcher reacts to lightweight
  // terminal lifecycle events — blocked / stranded / needs-attention / hitl-
  // waiting — so it can act (or proactively alert) MID-drain rather than the drain
  // silently stalling. These are STRUCTURED signals derived from truth Mission
  // Control already holds — the captured Completion records (blocked / needs-
  // verification, with their `detail` body from issue 42) and the on-disk `afk/`
  // scan's stranded classification (issue 22) — never raw Pane scroll. The pure
  // `reactToLifecycleEvent` turns each into a plain-language notification (fed
  // through the same submit queue) plus, for blocked/stranded, an approval-gated
  // discard-and-continue proposal (issue 36's gate). CRUCIALLY, when the drain
  // reaches a HITL issue parked awaiting the human (a `hitl: true` / `(HITL)` issue
  // whose block is "Ready for manual verification"), it PROACTIVELY notifies the
  // user, names the issue, and relays its manual-verification steps — so the user
  // isn't left to notice the pause. Reacted-to once per event (guarded by
  // `lifecycleReacted`).
  useEffect(() => {
    const sessionId = dispatcher?.sessionId ?? null;
    if (sessionId === null) return;

    const isHitlIssue = (issueId: number | null): boolean =>
      issueId !== null && (backlog?.issues.find((i) => i.id === issueId)?.hitl ?? false);

    const events: LifecycleEvent[] = [];

    // Blocked / HITL-waiting / needs-attention, derived from the captured blocks.
    // `finished` is already relayed via the Completion-block feed above, so it is
    // skipped here to avoid a duplicate narration.
    for (const rec of runLog) {
      const kind = lifecycleKindForOutcome(rec.outcome, isHitlIssue(rec.issueId));
      if (kind === null || kind === 'finished') continue;
      events.push({
        kind,
        runId: rec.id,
        issueId: rec.issueId,
        slug: rec.slug,
        title: rec.title,
        detail: rec.detail,
      });
    }

    // Stranded isolated Runs (issue 22): a worktree whose Run ended without a
    // done commit. There is no Completion block for these — the on-disk scan is
    // the only signal — so surfacing them here is what keeps a stranded Run from
    // silently stalling the drain (and blocking its siblings' Merge).
    for (const s of worktreeRunStates) {
      if (s.kind !== 'stranded') continue;
      events.push({
        kind: 'stranded',
        runId: `stranded-${s.issueId}`,
        issueId: s.issueId,
        slug: s.slug,
        title: null,
        detail: null,
      });
    }

    let pumped = false;
    for (const event of events) {
      const key = `${event.kind}:${event.runId}`;
      if (lifecycleReacted.current.has(key)) continue;
      lifecycleReacted.current.add(key);
      const reaction = reactToLifecycleEvent(event);
      if (reaction.notification === null) continue;
      // ADR-0012 (issue 48): route by the event's authority. A HITL gate awaiting
      // sign-off is a blocking-approval prompt → the chat PTY; a blocked/stranded/
      // needs-attention alert is a routine passive fact → the ambient log. Either
      // way it is surfaced once, so a stuck or human-gated drain never stalls
      // silently — it just no longer races the user's typing in the chat.
      // ADR-0011: discard-and-continue is not a blocking gate; the user discards a
      // blocked/stranded Run from the Map's Discard control, so no proposal here.
      if (surfaceEvent(key, actionForLifecycle(event.kind), reaction.notification)) {
        pumped = true;
      }
    }
    if (pumped) pumpDispatcherQueue(sessionId);
  }, [runLog, worktreeRunStates, dispatcher, backlog, pumpDispatcherQueue, surfaceEvent]);

  // --- The honest signals that replaced the scroll scrape (issue 57) --------
  // (a) finished-without-receipt: ground truth (the issue's `done` flip / a
  // session ending unfinished) says a Run ended, but no Receipt exists for it.
  // Exactly ONE passive note per Run ("peek at the Pane") lands in the ambient
  // log — never a scrape of the tail buffer, never a guess (ADR-0013). The
  // audit waits a grace window and re-checks the LIVE Run log first, so a
  // Receipt that lands a beat after the flip surfaces as a normal card and no
  // note fires.
  useEffect(() => {
    if (projectPath === null) return;
    const audited = auditMissingReceipts(
      runs.map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
        title: r.target.issueTitle,
        status: runStatusOf(r),
      })),
      runLog,
    );
    for (const event of audited) {
      const issueId = event.issueId;
      if (issueId === null || receiptAudited.current.has(issueId)) continue;
      receiptAudited.current.add(issueId);
      const auditPath = projectPath;
      setTimeout(() => {
        // The grace window passed: judge the CURRENT log (and Project). A
        // Receipt that arrived meanwhile means honesty requires silence; the
        // id stays clearable so a later re-run gets its own audit.
        if (projectPathRef.current !== auditPath) return;
        if (hasReceiptFor(runLogRef.current, issueId)) {
          receiptAudited.current.delete(issueId);
          return;
        }
        const reaction = reactToLifecycleEvent(event);
        if (reaction.notification !== null) {
          // `finished-without-receipt` → relay → the ambient log, not the chat.
          surfaceEvent(
            `${event.kind}:${event.runId}`,
            actionForLifecycle(event.kind),
            reaction.notification,
          );
        }
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runs, runLog, projectPath, runStatusOf, surfaceEvent]);

  // (b) Receipt/state mismatch (ADR-0013 trust hierarchy): the latest Receipt's
  // declared narrative disagrees with git's ground truth (e.g. Receipt says
  // completed, the issue file says wip). State wins — the status model above
  // never reads outcomes — and the disagreement surfaces as ONE debounced
  // passive note per issue: checked against the already-debounced status model,
  // held for the grace window, and re-verified against the live facts before it
  // is noted, so a `done` flip that lands a beat after its Receipt stays silent.
  useEffect(() => {
    if (projectPath === null) return;
    for (const mismatch of detectReceiptStateMismatches(runLog, debouncedStatusModel.issues)) {
      const key = mismatchKey(mismatch);
      if (mismatchSurfaced.current.has(key)) continue;
      mismatchSurfaced.current.add(key);
      const auditPath = projectPath;
      setTimeout(() => {
        if (projectPathRef.current !== auditPath) return;
        const still = detectReceiptStateMismatches(
          runLogRef.current,
          debouncedStatusModelRef.current?.issues ?? [],
        ).find((m) => mismatchKey(m) === key);
        if (!still) {
          // Reality caught up during the window — a transient, not a mismatch.
          mismatchSurfaced.current.delete(key);
          return;
        }
        // `relay` is a routine passive fact → the ambient log (ADR-0012).
        surfaceEvent(key, 'relay', describeReceiptMismatch(still));
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runLog, debouncedStatusModel, projectPath, surfaceEvent]);

  const startDrain = useCallback(
    (chosenCap: number): void => {
      // Refuse to drain onto a mid-merge main (issue 24) — resolve/abort first.
      if (midMerge) {
        setDrainMessage(
          'Cannot drain: main is mid-merge — resolve the conflict or Abort the merge first.',
        );
        return;
      }
      setCap(Math.max(1, Math.floor(chosenCap) || 1));
      setDrainMessage('');
      setDraining(true);
      // Starting a drain spins up the Dispatcher for this Project (ADR-0010):
      // the conversational orchestrator that drives the drain and that you talk
      // to instead of watching every Pane. A single manual Run (startRun) does
      // NOT do this — it stays a bare Pane. Idempotent: one Dispatcher per
      // Project, so re-draining the same Project reuses the live one.
      if (projectPath !== null) {
        setDispatcher((cur) =>
          cur && cur.target.projectPath === projectPath
            ? cur
            : {
                target: { projectPath, activePrd: backlog?.activePrd ?? null },
                sessionId: null,
              },
        );
      }
      setView('pane');
    },
    [midMerge, projectPath, backlog],
  );

  const stopDrain = useCallback((): void => {
    setDraining(false);
    setDrainMessage('Drain stopped by you — in-flight Runs keep going.');
  }, []);

  // Record the Dispatcher session's PTY id once its chat Pane spawns (issue 35),
  // so the ingest effect below can feed each Run's Completion block into it.
  const handleDispatcherSession = useCallback((sessionId: string): void => {
    setDispatcher((cur) => (cur ? { ...cur, sessionId } : cur));
  }, []);

  // Dismiss the Dispatcher (ADR-0010): end the orchestrator session and close
  // its chat panel. Unmounting the panel kills the PTY; clearing the fed-set lets
  // a fresh Dispatcher for this Project start ingesting from scratch.
  const dismissDispatcher = useCallback((): void => {
    setDispatcher(null);
    dispatcherFed.current.clear();
    dispatcherQueue.current = [];
    dispatcherPumping.current = false;
    dispatcherTyping.current = INITIAL_TYPING_STATE;
    setDispatcherActivities([]);
    lifecycleReacted.current.clear();
    discardTargets.current = {};
    overlapSurfaced.current.clear();
    statusRefreshSig.current = null;
    statusDebounce.current = initialStatusDebounceState();
    seenReconciled.current = null;
    debouncedStatusModelRef.current = null;
    autoMergeSig.current = null;
  }, []);

  // Drag the divider between the Map and the Dispatcher rail to resize it (issue
  // 44). We capture the width and pointer x at drag start, then follow the
  // pointer via window listeners (so the drag keeps tracking even if the cursor
  // leaves the thin handle). The pure `dispatcherWidthFromPointer` does the math
  // and clamps to the min/max; the chosen width is persisted app-wide on release
  // so it survives closing/reopening the panel and restarts. The chat Pane
  // reflows automatically — its ResizeObserver (issue 12) refits the terminal as
  // the rail's width changes.
  const startDispatcherResize = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault();
      const startClientX = e.clientX;
      const startWidth = dispatcherWidth;
      const onMove = (ev: PointerEvent): void => {
        setDispatcherWidth(
          dispatcherWidthFromPointer({ startWidth, startClientX, clientX: ev.clientX }),
        );
      };
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('is-col-resizing');
        const finalWidth = dispatcherWidthFromPointer({
          startWidth,
          startClientX,
          clientX: ev.clientX,
        });
        try {
          window.localStorage.setItem(DISPATCHER_WIDTH_KEY, String(finalWidth));
        } catch {
          // Persistence is best-effort; the live width still applies this session.
        }
      };
      document.body.classList.add('is-col-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [dispatcherWidth],
  );

  // Keep the App's backlog copy fresh from every Map load/live-change so the
  // Coordinator plans against current disk truth.
  const handleBacklogLoaded = useCallback(
    (loaded: Backlog | null, loadedPath: string): void => {
      setBacklog(loaded);
      setProjectPath(loadedPath);
    },
    [],
  );

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

    const activeRuns: ActiveRun[] = runs.map((r) => ({
      issueId: r.target.issueId,
      status: runStatusOf(r),
    }));
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: cap, activeRuns, midMerge });

    if (plan.drain.stop) {
      setDraining(false);
      setDrainMessage(plan.drain.message);
      return;
    }

    const have = new Set(runs.map((r) => r.target.issueId));
    const startableIssues = plan.startable
      .filter((id) => !have.has(id))
      .map((id) => backlog.issues.find((i) => i.id === id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i));

    if (startableIssues.length === 0) return;

    // The set of Runs that need isolation = every tracked Run plus the ones
    // about to start. The adapter creates a worktree per Run when this set is
    // 2+, else keeps the lone Run on main. Idempotent, so re-planning is safe.
    const isolationRuns: IsolationRun[] = [
      ...runs.map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
      })),
      ...startableIssues.map((i) => ({ issueId: i.id, slug: slugOf(i.fileName) })),
    ];

    let cancelled = false;

    const addRuns = (cwdOf: (issueId: number) => string): void => {
      const additions = startableIssues.map((issue) =>
        newRun({
          issueId: issue.id,
          issueFileName: issue.fileName,
          issueTitle: issue.title,
          projectPath: cwdOf(issue.id),
        }),
      );
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
        // Newly-started Runs spawn in their resolved cwd (a worktree in parallel
        // mode). Already-live Panes keep the cwd they spawned in — a running PTY
        // can't be re-parented; that live solo→parallel re-parent is left to the
        // batch QA walkthrough / Merge slice.
        addRuns((id) => cwdById[id] ?? projectPath);
      })
      .catch(() => {
        if (cancelled) return;
        // Isolation failed (a git worktree error, a disk error, a partial
        // reconcile that threw mid-apply). Falling back to `main` is safe ONLY
        // for a lone Run; spawning every startable Run on the shared checkout
        // while others are live is the concurrent-main collision isolation
        // exists to prevent (issue 28). Count the Runs that would end up live on
        // `main`: the startable ones (all fall back to `main`) plus any Run
        // already running solo on `main` (an isolated Run keeps its worktree, so
        // it doesn't count). If that is 2+, STOP the drain and surface the error
        // for the user to retry/resolve rather than run multiple agents unsafely.
        const runningOnMain = runs.filter(
          (r) => runStatusOf(r) === 'running' && !isIsolated(r),
        ).length;
        if (canFallBackToMain(runningOnMain + startableIssues.length)) {
          addRuns(() => projectPath);
        } else {
          setDraining(false);
          setDrainMessage(
            'Isolation failed while starting parallel Runs — stopped to avoid ' +
              'running multiple agents on main. Resolve the worktree/git error, ' +
              'then start the drain again.',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [draining, backlog, runs, cap, projectPath, midMerge, runStatusOf, isIsolated]);

  // --- Merge readiness (issue 08, ADR-0002; issue 16) ---------------------
  // Whether a human-triggered Merge is offered — and which branches it targets —
  // is derived from the ON-DISK `afk/` state, not the in-memory tracked Runs, so
  // the affordance survives closing every Pane (issue 16). It appears once every
  // isolated Run's branch is committed-done (issue 15) and none is still in
  // flight, and never triggers on its own (ADR-0002).
  const mergePlan = mergeReadinessOnDisk(activeScan.branches, liveRunIssueIds);

  // The single merge invocation, shared by the manual Map button (`auto=false`)
  // and the Dispatcher's auto-proceed path (`auto=true`, issue 46). The git work,
  // the merge-status display, and the on-disk/tracking cleanup are IDENTICAL in
  // both modes — so the manual button behaves exactly as before. The only thing
  // `auto` adds is the Dispatcher posture on the RESULT: a clean merge records a
  // passive `merge` note and relays its summary; a conflict / preflight failure
  // records a blocking `merge-conflict` proposal and surfaces the reason (never
  // auto-resolved). The pure `decideDispatcherMerge` makes that auto-vs-gate call.
  const runMergeCore = useCallback((auto: boolean): void => {
    if (projectPath === null || merging) return;
    const candidates = mergePlan.mergeable;
    if (candidates.length === 0) {
      // Triggered with nothing mergeable on disk (e.g. stale in-memory
      // readiness after the branches were removed): say so plainly rather than
      // silently doing nothing or later showing "could not run".
      setMergeDisplay(emptyMergeDisplay());
      return;
    }
    const slugs = candidates.map((c) => c.slug);
    const mergedIds = new Set(candidates.map((c) => c.issueId));
    // Stable per-mergeable-set id so a re-render can't duplicate the note/gate.
    const sig = [...slugs].sort().join(',');

    setMerging(true);
    setMergeDisplay(pendingMergeDisplay(slugs.length));
    void window.mc
      .mergeRuns({ projectPath, slugs })
      .then((result) => {
        setMergeDisplay(mergeResultDisplay(result));
        if (auto) {
          // Dispatcher path only (ADR-0011): classify the completed merge into an
          // auto-proceed passive note vs a conflict/failure blocking gate.
          const decision = decideDispatcherMerge(result);
          const sessionId = dispatcher?.sessionId ?? null;
          if (decision.kind === 'auto') {
            // A CLEAN merge is a routine passive fact ("merged 05 clean") →
            // ambient log, carrying its own summary text; never typed into the
            // chat (ADR-0012, issue 48). `merge` is passive → channelForAction 'log'.
            logNote(`merge:${sig}`, 'merge', decision.note);
          } else if (decision.kind === 'gate') {
            // A REAL CONFLICT blocks: record the pending proposal (the panel's
            // approve/reject) and, because it is a blocking-approval prompt,
            // ALSO surface the reason in the chat via the serialized queue.
            setDispatcherActivities((prev) =>
              prev.some((a) => a.id === `merge-conflict:${sig}`)
                ? prev
                : [...prev, recordActivity(`merge-conflict:${sig}`, 'merge-conflict')],
            );
            if (sessionId !== null && surfaceEvent(`merge-conflict:${sig}`, 'merge-conflict', decision.reason)) {
              pumpDispatcherQueue(sessionId);
            }
          } else if (decision.kind === 'halt') {
            // A PREFLIGHT/tool failure is NOT a conflict and NOT approvable
            // (issue 59): an approval could only retry into the same dirty tree
            // and fail identically. Surface its truthful reason (the offending
            // paths) as its own passive note; once the tree is cleaned up (by
            // the user, or by MC committing a straggler Receipt), a retry — the
            // manual Merge button, or the next auto attempt — passes.
            logNote(`merge-preflight:${sig}`, 'merge-preflight', decision.reason);
          }
        }
        if (result.ok) {
          // Optimistically drop the merged slugs from the on-disk scan the
          // instant the merge succeeds, so `mergePlan` recomputes to not-ready
          // synchronously — before `merging` resets in `.finally` and re-enables
          // the button. Without this the scan keeps listing the now-deleted
          // branches until the next ~1.5s poll, so a rapid second click would
          // fire a merge at branches that no longer exist and surface an error
          // contradicting the success just shown (issue 29). The next real scan
          // confirms the same truth, so this is a safe optimistic prefix of it.
          setAfkScan((prev) =>
            prev && prev.projectPath === projectPath
              ? { ...prev, branches: dropMergedBranches(prev.branches, slugs) }
              : prev,
          );
          // The merged Runs' worktrees are gone; drop them from tracking so the
          // Merge action clears. Unmerged (blocked/stopped) Runs stay put.
          setRuns((prev) => prev.filter((r) => !mergedIds.has(r.target.issueId)));
          // Clear the merged ids' commit error + once-committed marker so re-using
          // any of those ids for a later Run starts clean (issue 21/30).
          setWorktreeCommitErrors((prev) => {
            if (![...mergedIds].some((id) => id in prev)) return prev;
            const next = { ...prev };
            for (const id of mergedIds) delete next[id];
            return next;
          });
          for (const id of mergedIds) committedWorktreeIds.current.delete(id);
        }
      })
      .catch((err: unknown) => {
        setMergeDisplay(
          mergeThrewDisplay(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setMerging(false));
  }, [projectPath, merging, mergePlan, dispatcher, pumpDispatcherQueue, logNote, surfaceEvent]);

  // The manual Map Merge button — the unchanged, human-triggered path (ADR-0002).
  const runMerge = useCallback((): void => runMergeCore(false), [runMergeCore]);

  // --- Dispatcher auto-merge (issue 46, ADR-0011 refining ADR-0002) --------
  // Under a Dispatcher-driven drain a CLEAN merge of finished parallel work
  // AUTO-PROCEEDS — the Dispatcher invokes it on its own and leaves a passive
  // note ("merged 05 clean") — while a CONFLICT or preflight failure BLOCKS for a
  // one-click approval (the `merge-conflict` item on issue 45's blocking list) and
  // surfaces the reason (issues 17/23/24), never auto-resolving. The pure
  // `shouldAutoMerge` decides WHEN to fire (a live Dispatcher session, mergeable
  // `afk/` branches on disk, `main` not mid-merge, no merge already in flight, and
  // this mergeable set not already auto-attempted); `decideDispatcherMerge` (in
  // the shared core's result handler) makes the auto-note-vs-conflict-gate call.
  // `autoMergeSig` records the attempted set so a persistent preflight failure —
  // which leaves the branch set unchanged — can't loop the effect (a clean merge
  // drops the branches and a conflict sets `midMerge`, so those self-guard).
  useEffect(() => {
    const sig = mergePlan.mergeable.map((c) => c.slug).sort().join(',');
    const go = shouldAutoMerge({
      dispatcherActive: (dispatcher?.sessionId ?? null) !== null,
      mergeableCount: mergePlan.mergeable.length,
      midMerge,
      merging,
      alreadyAttempted: autoMergeSig.current === sig,
    });
    if (!go) return;
    autoMergeSig.current = sig;
    runMergeCore(true);
  }, [mergePlan, dispatcher, midMerge, merging, runMergeCore]);

  // Approve a pending proposal: mark it approved, then EXECUTE the action (the
  // gate's whole point — nothing ran until this click). Execution is dispatched
  // by the action; a Merge runs the existing merge path, an abort stops the
  // drain. Non-executable proposals are simply recorded as approved.
  const approveProposal = useCallback(
    (id: string): void => {
      let action: DispatcherActivity['action'] | null = null;
      setDispatcherActivities((prev) =>
        prev.map((a) => {
          if (a.id !== id || a.status !== 'pending') return a;
          action = a.action;
          return resolveActivity(a, 'approved');
        }),
      );
      if (action === 'merge') runMerge();
      else if (action === 'abort-drain') stopDrain();
      else if (action === 'discard-and-continue') {
        // Execute issue 22's discard for the stranded/blocked Run's worktree, if
        // it has one; a blocked solo Run has no worktree, so approving simply
        // clears the gate and the drain continues.
        const target = discardTargets.current[id];
        if (target) discardRun(target.issueId, target.slug);
      }
    },
    [runMerge, stopDrain, discardRun],
  );

  // Reject a pending proposal: drop it (mark rejected) and DO NOT execute — the
  // Dispatcher continues without the scope change.
  const rejectProposal = useCallback((id: string): void => {
    setDispatcherActivities((prev) =>
      prev.map((a) => (a.id === id && a.status === 'pending' ? resolveActivity(a, 'rejected') : a)),
    );
  }, []);

  // Abort an in-progress merge left on `main` by a partial conflict (issue 24):
  // `git merge --abort` back to a clean `main` (already-merged slugs stay merged),
  // so a non-git user isn't stranded and a new drain/Run is unblocked. Refreshes
  // the scan immediately so `midMerge` clears without waiting for the next poll.
  const runAbortMerge = useCallback((): void => {
    if (projectPath === null || aborting) return;
    setAborting(true);
    void window.mc
      .abortMerge({ projectPath })
      .then((res) => {
        if (!res.ok) {
          window.alert(`Could not abort the merge: ${res.error ?? 'unknown error'}`);
          return;
        }
        // The conflicted merge is gone; drop the stale conflict panel and re-scan.
        setMergeDisplay(null);
        void window.mc
          .scanAfkRuns({ projectPath })
          .then((r) => setAfkScan({ projectPath, branches: r.branches, midMerge: r.midMerge }))
          .catch(() => {
            // The 1.5s poll will pick up the cleared mid-merge state regardless.
          });
      })
      .catch((err: unknown) => {
        window.alert(
          `Could not abort the merge: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setAborting(false));
  }, [projectPath, aborting]);

  // Adaptive tiled grid: the pure layout function decides the shape from the
  // live Run count (issue 12). A maximized tile overrides it with a single cell.
  const shape = gridShape(runs.length);
  const maximizedRun = runs.find((r) => r.target.issueId === maximizedId) ?? null;

  return (
    <div className="app">
      <header className="app__header">
        <strong>Mission Control</strong>
        <ProjectBar
          projects={projects}
          activeRepoPath={activeRepoPath}
          newRepoPath={newRepoPath}
          onNewRepoPathChange={setNewRepoPath}
          onSwitch={(repoPath) => void switchProject(repoPath)}
          onBrowse={() => void browseForFolder()}
          onOpenHere={() => void openProjectHere(newRepoPath.trim())}
          onOpenNewWindow={openInNewWindow}
          error={projectError}
        />
        <nav className="app__nav">
          <button
            className={`app__tab${view === 'map' ? ' app__tab--active' : ''}`}
            onClick={() => setView('map')}
          >
            Map
          </button>
          <button
            className={`app__tab${view === 'pane' ? ' app__tab--active' : ''}`}
            onClick={() => setView('pane')}
          >
            Pane{runs.length > 0 ? ` (${runs.length})` : ''}
          </button>
        </nav>

        {view === 'pane' && runs.length > 0 && (
          <span className="app__paneinfo">
            {maximizedRun ? (
              <>
                <span className="app__run-title">
                  {String(maximizedRun.target.issueId).padStart(2, '0')} ·{' '}
                  {maximizedRun.target.issueTitle}
                </span>
                <button className="run-restore" onClick={() => setMaximizedId(null)}>
                  Restore grid
                </button>
              </>
            ) : (
              <span className="app__status">
                {runs.length} Run{runs.length === 1 ? '' : 's'} tiled
              </span>
            )}
          </span>
        )}
        {view === 'pane' && runs.length === 0 && (
          <span className="app__status">Pane: {paneStatus}</span>
        )}
      </header>

      <div className="app__view">
        {/* Map stays mounted (hidden in Pane view) so its live watch keeps the
            backlog — and therefore every Run's status and the drain plan —
            current even while you watch a Pane. */}
        <div className="app__slot" style={{ display: view === 'map' ? 'flex' : 'none' }}>
          <div className="app__map-col">
          <Map
            projectPath={activeRepoPath}
            onRun={startRun}
            onBacklogLoaded={handleBacklogLoaded}
            runLog={runLog}
            activeRunIssueIds={activeRunIssueIds}
            worktreeRunningIds={worktreeRunningIds}
            finishedUnmergedIds={finishedUnmergedIds}
            strandedIds={strandedIds}
            commitFailedIds={commitFailedIds}
            onDiscard={(slug, issueId) => discardRun(issueId, slug)}
            onDrain={startDrain}
            onStopDrain={stopDrain}
            draining={draining}
            drainMessage={drainMessage}
            cap={cap}
            onCapChange={setCap}
            mergeReady={mergePlan.ready}
            mergeCount={mergePlan.mergeable.length}
            onMerge={runMerge}
            merging={merging}
            mergeDisplay={mergeDisplay}
            midMerge={midMerge}
            onAbortMerge={runAbortMerge}
            aborting={aborting}
          />
          </div>
          {/* The Dispatcher chat panel beside the Map (ADR-0010): present once a
              drain has started this Project. Talk to the orchestrator here
              instead of watching every worker Pane; ask "what's left?" and it
              answers from the Completion blocks / Run log. Dismissable. */}
          {dispatcher && (
            <>
              {/* Draggable divider between the Map and the Dispatcher rail
                  (issue 44): drag to resize; the chat Pane reflows to fit. */}
              <div
                className="dispatcher-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the Dispatcher panel"
                title="Drag to resize the Dispatcher panel"
                onPointerDown={startDispatcherResize}
              />
              <DispatcherPanel
                target={dispatcher.target}
                onSession={handleDispatcherSession}
                onInput={handleDispatcherInput}
                onDismiss={dismissDispatcher}
                ingestedCount={runLog.filter((r) => r.outcome !== 'unknown').length}
                activities={dispatcherActivities}
                onApprove={approveProposal}
                onReject={rejectProposal}
                width={dispatcherWidth}
              />
            </>
          )}
        </div>

        {/* Every tracked Run's Pane stays mounted so its session persists; the
            adaptive grid (issue 12) tiles them so all live Runs are visible at
            once instead of hidden behind tabs. Maximizing a tile collapses the
            grid to one cell and hides (but keeps mounted) the others. A plain
            shell Pane (issue 01) shows when no Run is tracked. */}
        {runs.length > 0 && (
          <div
            className={`app__grid${shape.scroll ? ' app__grid--scroll' : ''}`}
            style={{
              display: view === 'pane' ? 'grid' : 'none',
              gridTemplateColumns: maximizedRun
                ? '1fr'
                : `repeat(${shape.cols}, minmax(0, 1fr))`,
              gridTemplateRows:
                maximizedRun || shape.scroll
                  ? undefined
                  : `repeat(${shape.rows}, minmax(0, 1fr))`,
            }}
          >
            {runs.map((r) => {
              const status = runStatusOf(r);
              const id = r.target.issueId;
              const slug = slugOf(r.target.issueFileName);
              const isStranded = strandedIds.includes(id);
              const isCommitFailed = commitFailedIds.includes(id);
              const isFinishedUnmerged =
                (status === 'finished' && isIsolated(r)) || finishedUnmergedIds.includes(id);
              // Any isolated Run whose worktree/branch still holds work — finished-
              // but-unmerged (committed), stranded, or commit-failed (uncommitted) —
              // has work that dismissing would hide, so warn first (issue 22, corr).
              // Previously only `finished` warned. Cross-checks the on-disk scan so a
              // Run whose state landed off-screen still triggers it.
              const worktreeWork = isFinishedUnmerged || isStranded || isCommitFailed;
              // Stranded / commit-failed Runs can never merge as-is: offer to
              // discard (force-remove the worktree + delete the branch) so the
              // batch can proceed (issue 22).
              const discardable = isStranded || isCommitFailed;
              const commitError = worktreeCommitErrors[id] ?? null;
              const requestDismiss = (): void => {
                const message = isFinishedUnmerged
                  ? `Issue ${String(id).padStart(2, '0')} has finished work on branch afk/${slug} ` +
                    `that hasn't been merged into main yet.\n\nDismiss it anyway? The branch stays ` +
                    `on disk and you can still Merge it from the Map.`
                  : `Issue ${String(id).padStart(2, '0')} has unmerged work in its worktree on ` +
                    `branch afk/${slug}.\n\nDismiss it anyway? Dismissing only hides it here — the ` +
                    `worktree stays on disk. Use Discard to remove the worktree and branch.`;
                if (worktreeWork && !window.confirm(message)) return;
                dismissRun(id);
              };
              const requestDiscard = (): void => {
                if (
                  window.confirm(
                    `Discard issue ${String(id).padStart(2, '0')}'s worktree and branch afk/${slug}?` +
                      `\n\nThis force-removes the worktree (uncommitted work is lost) and deletes ` +
                      `the branch. Use this to clear a blocked/stopped/commit-failed Run so the ` +
                      `batch can proceed.`,
                  )
                ) {
                  discardRun(id, slug);
                }
              };
              const isMax = maximizedRun?.target.issueId === r.target.issueId;
              const hidden = maximizedRun !== null && !isMax;
              return (
                <div
                  key={r.target.issueId}
                  className={`app__tile${isMax ? ' app__tile--max' : ''}`}
                  style={{ display: hidden ? 'none' : 'flex' }}
                >
                  <div
                    className="app__tile-head"
                    onClick={() => toggleMaximize(r.target.issueId)}
                    title={isMax ? 'Click to restore the grid' : 'Click to maximize'}
                  >
                    <span className={`run-status run-status--${status}`}>{status}</span>
                    {isCommitFailed && (
                      <span
                        className="run-status run-status--commit-failed"
                        title={
                          commitError
                            ? `Auto-commit failed: ${commitError}`
                            : 'The Run finished but its work could not be committed to the afk/ branch'
                        }
                      >
                        commit failed
                      </span>
                    )}
                    {isStranded && (
                      <span
                        className="run-status run-status--stranded"
                        title="This Run ended without committing done; its worktree is stranded"
                      >
                        stranded
                      </span>
                    )}
                    <span className="app__tile-id">
                      {String(r.target.issueId).padStart(2, '0')}
                    </span>
                    <span className="app__tile-title">{r.target.issueTitle}</span>
                    <span className="app__tile-controls">
                      {status === 'running' ? (
                        <button
                          className="run-stop run-stop--tile"
                          onClick={(e) => {
                            e.stopPropagation();
                            stopRun(r.target.issueId);
                          }}
                        >
                          Stop
                        </button>
                      ) : (
                        <>
                          {discardable && (
                            <button
                              className="run-discard run-discard--tile"
                              title="Discard this Run's worktree and afk/ branch (force remove)"
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDiscard();
                              }}
                            >
                              Discard
                            </button>
                          )}
                          <button
                            className="app__tile-dismiss"
                            title={
                              worktreeWork
                                ? 'Dismiss this Run (its worktree/branch still has unmerged work)'
                                : 'Dismiss this finished Run'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              requestDismiss();
                            }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  <Pane
                    run={r.target}
                    stopSignal={r.stopSignal}
                    onStatusChange={r.target.issueId === focusedId ? setPaneStatus : undefined}
                    onExit={() => handleRunExit(r.target.issueId)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {runs.length === 0 && view === 'pane' && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <Pane onStatusChange={setPaneStatus} onExit={() => setPaneStatus('exited')} />
          </div>
        )}
      </div>
    </div>
  );
}
