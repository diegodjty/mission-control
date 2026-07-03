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
  deriveRunStatus,
  isTerminal,
  observedIssueStatus,
  runningIssueIds,
  type RunStatus,
} from '../../shared/run-state';
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
  /** The PTY session id, set once the Pane spawns (issue 34, for capture). */
  sessionId: string | null;
}

function newRun(target: RunTarget): TrackedRun {
  return { target, sessionAlive: true, stoppedByUser: false, stopSignal: 0, sessionId: null };
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
  // Solo Runs whose finished work MC has already asked to commit onto `main`
  // (issue 25), so a finished solo Run is auto-committed once — not on every
  // re-render. Cleared for an id when a genuinely fresh Run of it starts, so a
  // later Run of the same issue commits its own work. A rejected commit clears
  // the id so a later observation retries; the adapter commit is idempotent.
  const committedSoloIds = useRef<Set<number>>(new Set<number>());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  // Which tile (if any) is maximized to fill the Pane area; null = tiled grid.
  const [maximizedId, setMaximizedId] = useState<number | null>(null);

  // --- Run log (issue 34) --------------------------------------------------
  // The captured Completion blocks for the active Project, newest first. Loaded
  // from disk when a Project opens (so the feed survives closing Panes / the app
  // / restarts) and upserted as Runs finish. `capturedSessions` tracks which
  // sessions we've already begun capturing so the terminal-status effect fires
  // capture once per Run, not on every re-render.
  const [runLog, setRunLog] = useState<RunLogRecord[]>([]);
  const capturedSessions = useRef<Set<string>>(new Set<string>());
  // Live mirror of `projectPath` so a capture that resolves after a Project
  // switch can tell it belongs to the previous Project and skip the feed upsert
  // (it is still persisted to that Project's on-disk log, correctly).
  const projectPathRef = useRef<string | null>(null);

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
  // Serialized submit queue for the Dispatcher feed (issue 41). Each Completion
  // block is TYPED then SUBMITTED with a separate Enter write; the queue drains
  // one block fully (type → settle → submit → settle) before starting the next,
  // so blocks arriving close together in a parallel drain are submitted as
  // DISTINCT messages, never concatenated into one input line.
  const dispatcherQueue = useRef<string[]>([]);
  const dispatcherPumping = useRef<boolean>(false);
  // The Dispatcher's hybrid-authority activity log (issue 36, ADR-0007):
  // autonomous actions it took (auto — shown as quiet notes) and scope-changing
  // actions it's proposing (needs-approval — shown with one-click approve/reject
  // that don't execute until approved). `mergeProposalSig` guards the derived
  // Merge proposal so a rejected one isn't re-added every poll while the same
  // branches stay mergeable (see the merge-proposal effect).
  const [dispatcherActivities, setDispatcherActivities] = useState<DispatcherActivity[]>([]);
  const mergeProposalSig = useRef<string | null>(null);

  // --- Merge state (issue 08; issue 17) ------------------------------------
  // `mergeDisplay` is the pure selector's decision of what the Merge UI shows
  // (headline + whether/what to put in the details panel). Surfacing the
  // adapter's `output` here is what gives "see details below" an actual below.
  const [merging, setMerging] = useState(false);
  const [mergeDisplay, setMergeDisplay] = useState<MergeDisplay | null>(null);

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
    setDispatcherActivities([]);
    mergeProposalSig.current = null;
    setMerging(false);
    setAborting(false);
    setMergeDisplay(null);
    setAfkScan(null);
    setWorktreeCommitErrors({});
    committedSoloIds.current.clear();
    committedWorktreeIds.current.clear();
    // The Run-log feed is per-Project (issue 34): clear it and the capture
    // bookkeeping so the new Project starts blank and loads its own log.
    setRunLog([]);
    capturedSessions.current.clear();
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

  // Auto-commit a finished SOLO Run's work on `main` (issue 25). A solo Run's
  // agent flips its issue to `done` and leaves its files + the flip UNCOMMITTED
  // on `main`; nothing else commits them, so `main` stays dirty and the next
  // parallel Merge fails its clean-tree preflight. The moment a solo Run's
  // derived status is `finished` (its `done` flip seen by the main-checkout
  // watcher), MC commits it — once per Run, idempotently — so "finished"
  // uniformly means "committed" and `main` stays mergeable. Isolated Runs commit
  // on their own `afk/` branch (the worktree-commit effect below), so they are
  // skipped here.
  useEffect(() => {
    if (projectPath === null) return;
    for (const run of runs) {
      if (isIsolated(run) || runStatusOf(run) !== 'finished') continue;
      const id = run.target.issueId;
      if (committedSoloIds.current.has(id)) continue;
      committedSoloIds.current.add(id);
      void window.mc
        .commitFinishedMain({ projectPath, slug: slugOf(run.target.issueFileName) })
        .catch(() => {
          // Transient/failed commit: allow a later observation to retry.
          committedSoloIds.current.delete(id);
        });
    }
  }, [runs, projectPath, isIsolated, runStatusOf]);

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
      // solo (issue 25) and isolated (issue 30) once-committed markers so it isn't
      // treated as already-committed by a prior Run of the same id.
      committedSoloIds.current.delete(target.issueId);
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

  // Record a Run's PTY session id once its Pane spawns (issue 34), so the
  // capture effect can pull that session's buffered output when the Run ends.
  const handleRunSession = useCallback((issueId: number, sessionId: string): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId ? { ...r, sessionId } : r,
      ),
    );
  }, []);

  // Upsert a captured record into the feed, keyed by its Run (session) id, so a
  // re-capture as a streaming block finishes replaces the earlier version rather
  // than adding a duplicate card. Newest first.
  const upsertRunLog = useCallback((record: RunLogRecord): void => {
    setRunLog((prev) => {
      const others = prev.filter((r) => r.id !== record.id);
      return [record, ...others].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
      );
    });
  }, []);

  // --- Completion-block capture (issue 34) ---------------------------------
  // When a Run reaches a terminal status, capture its Completion block into the
  // per-Project Run log. The block is the Worker's FINAL output, emitted just
  // after it flips the issue `done`, so we capture shortly AFTER the terminal
  // transition (a short debounce) and — because the block may still be streaming
  // — retry a few times while the parse comes back `unknown`. Main de-dupes by
  // session id, so the retries and the optimistic feed upsert can't create
  // duplicate cards. Fires once per session (guarded by `capturedSessions`).
  useEffect(() => {
    if (projectPath === null) return;

    for (const run of runs) {
      const sessionId = run.sessionId;
      if (sessionId === null) continue;
      if (capturedSessions.current.has(sessionId)) continue;
      if (!isTerminal(runStatusOf(run))) continue;

      // Claim this session so a re-render doesn't schedule a second capture chain.
      // The chain isn't cancelled on re-render (unlike the scan poll): captures
      // are de-duped by session id and idempotent, so letting the retries run to
      // completion is safe and avoids truncating them when a sibling Run's event
      // re-fires this effect mid-capture.
      capturedSessions.current.add(sessionId);
      const capturePath = projectPath;
      const { issueId, issueFileName, issueTitle } = run.target;
      const MAX_ATTEMPTS = 4;

      const attempt = (n: number): void => {
        setTimeout(
          () => {
            void window.mc
              .captureRunLog({ projectPath: capturePath, sessionId, issueId, issueFileName, issueTitle })
              .then((res) => {
                // Skip the feed upsert if the Project changed while we captured —
                // the record still belongs to (and was persisted for) capturePath.
                if (res.record && projectPathRef.current === capturePath) {
                  upsertRunLog(res.record);
                }
                // A still-streaming block parses as `unknown`; retry so the final
                // block is what sticks. Persisted every attempt, but de-duped by
                // session id, so the last (best) capture wins.
                if ((!res.record || res.record.outcome === 'unknown') && n + 1 < MAX_ATTEMPTS) {
                  attempt(n + 1);
                }
              })
              .catch(() => {
                // Transient IPC error: allow a later attempt within the budget.
                if (n + 1 < MAX_ATTEMPTS) attempt(n + 1);
              });
          },
          n === 0 ? 1800 : 1500,
        );
      };
      attempt(0);
    }
  }, [runs, projectPath, runStatusOf, upsertRunLog]);

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
        if (!cancelled) setRunLog(res.records);
      })
      .catch(() => {
        // A transient read error just leaves the feed as-is; a later capture or
        // Project reopen reloads it.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

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

  useEffect(() => {
    const sessionId = dispatcher?.sessionId ?? null;
    if (sessionId === null) return;
    for (const rec of runLog) {
      if (rec.outcome === 'unknown') continue;
      if (dispatcherFed.current.has(rec.id)) continue;
      dispatcherFed.current.add(rec.id);
      const text = renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec }));
      dispatcherQueue.current.push(text);
      // Synthesizing/relaying a finished Run's block is an autonomous (auto)
      // action per ADR-0007 — log it so the panel shows what the Dispatcher did
      // on its own, distinct from the scope-changing actions it must propose.
      setDispatcherActivities((prev) =>
        prev.some((a) => a.id === `synthesize:${rec.id}`)
          ? prev
          : [...prev, recordActivity(`synthesize:${rec.id}`, 'synthesize')],
      );
    }
    pumpDispatcherQueue(sessionId);
  }, [runLog, dispatcher, pumpDispatcherQueue]);

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
    setDispatcherActivities([]);
    mergeProposalSig.current = null;
  }, []);

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

  const runMerge = useCallback((): void => {
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

    setMerging(true);
    setMergeDisplay(pendingMergeDisplay(slugs.length));
    void window.mc
      .mergeRuns({ projectPath, slugs })
      .then((result) => {
        setMergeDisplay(mergeResultDisplay(result));
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
  }, [projectPath, merging, mergePlan]);

  // --- Dispatcher hybrid-authority gate (issue 36, ADR-0007) --------------
  // A Merge is always human-approved (ADR-0002): rather than only living as a
  // Map button, surface it in the Dispatcher panel as a one-click approve/reject
  // PROPOSAL whenever the Dispatcher is driving and branches are mergeable. The
  // signature (the sorted mergeable slugs) guards it so a rejected proposal isn't
  // re-added on every ~1.5s scan while the same branches stay ready; readiness
  // clearing (a merge succeeding, branches vanishing) resets the guard so a later
  // set of finished Runs proposes afresh.
  useEffect(() => {
    if (!dispatcher) return;
    const sig = mergePlan.ready
      ? mergePlan.mergeable.map((m) => m.slug).sort().join(',')
      : null;
    if (sig === null) {
      mergeProposalSig.current = null;
      return;
    }
    if (sig === mergeProposalSig.current) return;
    mergeProposalSig.current = sig;
    const id = `merge:${sig}`;
    setDispatcherActivities((prev) =>
      prev.some((a) => a.id === id) ? prev : [...prev, recordActivity(id, 'merge')],
    );
  }, [dispatcher, mergePlan.ready, mergePlan.mergeable]);

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
    },
    [runMerge, stopDrain],
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
            <DispatcherPanel
              target={dispatcher.target}
              onSession={handleDispatcherSession}
              onDismiss={dismissDispatcher}
              ingestedCount={runLog.filter((r) => r.outcome !== 'unknown').length}
              activities={dispatcherActivities}
              onApprove={approveProposal}
              onReject={rejectProposal}
            />
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
                    onSession={(sid) => handleRunSession(r.target.issueId, sid)}
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
