import { useCallback, useEffect, useRef, useState } from 'react';
import { Pane } from './Pane';
import { Map } from './Map';
import { ProjectBar } from './ProjectBar';
import type { Backlog, IssueStatus } from '../../shared/backlog-model';
import type { ProjectView, RunTarget } from '../../shared/ipc-contract';
import {
  deriveRunStatus,
  observedIssueStatus,
  type RunStatus,
} from '../../shared/run-state';
import { planDrain, type ActiveRun } from '../../shared/run-coordinator';
import type { IsolationRun } from '../../shared/isolation-policy';
import {
  deriveWorktreeRunStates,
  mergeReadinessOnDisk,
  type AfkBranchFacts,
} from '../../shared/worktree-scan';
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
  useEffect(() => {
    const off = window.mc.onProjectRegistryChanged(() => {
      void window.mc.listProjects().then((list) => {
        setProjects(list.projects);
        setActiveRepoPath((cur) => list.activeRepoPath ?? cur);
      });
    });
    return off;
  }, []);

  const openProjectHere = useCallback(async (repoPath: string): Promise<void> => {
    // Only open on an explicit path; an empty path is a no-op, never a claim on
    // the backend cwd (issue 14).
    if (!repoPath.trim()) return;
    const res = await window.mc.openProject({ repoPath });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      setActiveRepoPath(res.activeRepoPath);
      setNewRepoPath('');
    }
  }, []);

  const switchProject = useCallback(async (repoPath: string): Promise<void> => {
    const res = await window.mc.switchProject({ repoPath });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) setActiveRepoPath(res.activeRepoPath);
  }, []);

  const openInNewWindow = useCallback((): void => {
    const repoPath = newRepoPath.trim();
    if (!repoPath) return;
    void window.mc.openWindow({ repoPath });
    setNewRepoPath('');
  }, [newRepoPath]);

  // --- Run state -----------------------------------------------------------
  const [runs, setRuns] = useState<TrackedRun[]>([]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  // Which tile (if any) is maximized to fill the Pane area; null = tiled grid.
  const [maximizedId, setMaximizedId] = useState<number | null>(null);

  // --- Drain state ---------------------------------------------------------
  const [draining, setDraining] = useState(false);
  const [cap, setCap] = useState(2);
  const [drainMessage, setDrainMessage] = useState('');

  // --- Merge state (issue 08; issue 17) ------------------------------------
  // `mergeDisplay` is the pure selector's decision of what the Merge UI shows
  // (headline + whether/what to put in the details panel). Surfacing the
  // adapter's `output` here is what gives "see details below" an actual below.
  const [merging, setMerging] = useState(false);
  const [mergeDisplay, setMergeDisplay] = useState<MergeDisplay | null>(null);

  // --- Isolated-Run completion (issue 13) ----------------------------------
  // An isolated Run works in its own worktree on an `afk/NN-slug` branch and
  // flips its issue to `done` there — a change the main-checkout backlog
  // watcher never sees. We observe each isolated Run's issue status from its
  // worktree/branch and key it by issue id; the pure `observedIssueStatus`
  // selector then chooses this source for isolated Runs and the main backlog
  // for solo Runs. Null = not observed yet (treated as not-done).
  const [worktreeStatuses, setWorktreeStatuses] = useState<
    Record<number, IssueStatus | null>
  >({});

  // --- On-disk afk/ scan (issue 16) ----------------------------------------
  // The ground truth for which issues have an in-flight or finished-but-unmerged
  // isolated Run lives in the Project's `afk/NN-slug` worktrees + committed
  // branches, NOT in `runs` above — so the Map's progress indicators and the
  // Merge affordance keep working after every Pane is closed (which drops the
  // in-memory Runs). Polled from disk whenever a Project is open; the pure
  // `worktree-scan` selectors turn these facts into what the UI shows.
  const [afkScan, setAfkScan] = useState<AfkBranchFacts[]>([]);

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

  const runStatusOf = useCallback(
    (run: TrackedRun): RunStatus =>
      deriveRunStatus({
        sessionAlive: run.sessionAlive,
        stoppedByUser: run.stoppedByUser,
        issueStatus: observedIssueStatus({
          isolated: isIsolated(run),
          mainStatus: issueStatusOf(run.target.issueId),
          worktreeStatus: worktreeStatuses[run.target.issueId] ?? null,
        }),
      }),
    [issueStatusOf, isIsolated, worktreeStatuses],
  );

  // Poll each isolated Run's worktree/branch for its issue status. The
  // main-checkout backlog watcher drives the Map's bird's-eye view and every
  // solo Run's status, but it can't see a `done` flip that lands on an `afk/`
  // branch — so isolated Runs get their completion from here (issue 13). Solo
  // runs are skipped entirely; the interval clears once no isolated Run remains.
  useEffect(() => {
    if (projectPath === null) return;
    const isolatedRuns = runs
      .filter((r) => r.target.projectPath !== projectPath)
      .map((r) => ({ issueId: r.target.issueId, slug: slugOf(r.target.issueFileName) }));
    if (isolatedRuns.length === 0) return;

    let cancelled = false;
    const observe = (): void => {
      for (const { issueId, slug } of isolatedRuns) {
        void window.mc
          .observeIssueStatus({ projectPath, slug })
          .then((res) => {
            if (cancelled) return;
            setWorktreeStatuses((prev) =>
              prev[issueId] === res.status ? prev : { ...prev, [issueId]: res.status },
            );
          })
          .catch(() => {
            // A transient read/git error just means "not observed this tick";
            // the next poll retries. Never crash the drain over it.
          });
      }
    };
    observe();
    const timer = setInterval(observe, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runs, projectPath]);

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
          if (!cancelled) setAfkScan(res.branches);
        })
        .catch(() => {
          // Transient read/git error: keep the last scan; the next tick retries.
        });
    };
    scan();
    const timer = setInterval(scan, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath]);

  // Pure derivations from the on-disk scan: which issues show `running` /
  // `finished (unmerged)` on the Map, and whether the Merge is offered (from
  // disk, so it survives closing Panes).
  const worktreeRunStates = deriveWorktreeRunStates(afkScan);
  const worktreeRunningIds = worktreeRunStates
    .filter((s) => s.kind === 'running')
    .map((s) => s.issueId);
  const finishedUnmergedIds = worktreeRunStates
    .filter((s) => s.kind === 'finished-unmerged')
    .map((s) => s.issueId);

  const activeRunIssueIds = runs.map((r) => r.target.issueId);

  // Start (or focus) a single Run — the manual "▶ Run" path from the Map.
  const startRun = useCallback((target: RunTarget): void => {
    setRuns((prev) =>
      prev.some((r) => r.target.issueId === target.issueId)
        ? prev
        : [...prev, newRun(target)],
    );
    setFocusedId(target.issueId);
    setView('pane');
  }, []);

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
  }, []);

  const handleRunExit = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId ? { ...r, sessionAlive: false } : r,
      ),
    );
  }, []);

  const startDrain = useCallback((chosenCap: number): void => {
    setCap(Math.max(1, Math.floor(chosenCap) || 1));
    setDrainMessage('');
    setDraining(true);
    setView('pane');
  }, []);

  const stopDrain = useCallback((): void => {
    setDraining(false);
    setDrainMessage('Drain stopped by you — in-flight Runs keep going.');
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
  useEffect(() => {
    if (!draining || !backlog || projectPath === null) return;

    const activeRuns: ActiveRun[] = runs.map((r) => ({
      issueId: r.target.issueId,
      status: runStatusOf(r),
    }));
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: cap, activeRuns });

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
        // Isolation failed (e.g. git worktree error): don't stall the drain —
        // fall back to running on main so the Pane still opens.
        if (!cancelled) addRuns(() => projectPath);
      });

    return () => {
      cancelled = true;
    };
  }, [draining, backlog, runs, cap, projectPath, runStatusOf]);

  // --- Merge readiness (issue 08, ADR-0002; issue 16) ---------------------
  // Whether a human-triggered Merge is offered — and which branches it targets —
  // is derived from the ON-DISK `afk/` state, not the in-memory tracked Runs, so
  // the affordance survives closing every Pane (issue 16). It appears once every
  // isolated Run's branch is committed-done (issue 15) and none is still in
  // flight, and never triggers on its own (ADR-0002).
  const mergePlan = mergeReadinessOnDisk(afkScan);

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
          // The merged Runs' worktrees are gone; drop them from tracking so the
          // Merge action clears. Unmerged (blocked/stopped) Runs stay put.
          setRuns((prev) => prev.filter((r) => !mergedIds.has(r.target.issueId)));
        }
      })
      .catch((err: unknown) => {
        setMergeDisplay(
          mergeThrewDisplay(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setMerging(false));
  }, [projectPath, merging, mergePlan]);

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
          <Map
            projectPath={activeRepoPath}
            onRun={startRun}
            onBacklogLoaded={handleBacklogLoaded}
            activeRunIssueIds={activeRunIssueIds}
            worktreeRunningIds={worktreeRunningIds}
            finishedUnmergedIds={finishedUnmergedIds}
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
          />
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
              // A finished isolated Run whose branch is committed but not yet
              // merged (issue 15/16): dismissing it hides mergeable work, so warn
              // first. Cross-check the on-disk scan as well as the in-memory
              // status so a Run committed off-screen still triggers the warning.
              const unmergedWork =
                (status === 'finished' && isIsolated(r)) ||
                finishedUnmergedIds.includes(r.target.issueId);
              const requestDismiss = (): void => {
                if (
                  unmergedWork &&
                  !window.confirm(
                    `Issue ${String(r.target.issueId).padStart(2, '0')} has finished work on ` +
                      `branch afk/${slugOf(r.target.issueFileName)} that hasn't been merged into ` +
                      `main yet.\n\nDismiss it anyway? The branch stays on disk and you can still ` +
                      `Merge it from the Map.`,
                  )
                ) {
                  return;
                }
                dismissRun(r.target.issueId);
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
                        <button
                          className="app__tile-dismiss"
                          title={
                            unmergedWork
                              ? 'Dismiss this Run (its branch has unmerged work)'
                              : 'Dismiss this finished Run'
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            requestDismiss();
                          }}
                        >
                          ✕
                        </button>
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
