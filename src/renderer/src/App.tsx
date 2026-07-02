import { useCallback, useEffect, useState } from 'react';
import { Pane } from './Pane';
import { Map } from './Map';
import { ProjectBar } from './ProjectBar';
import type { Backlog, IssueStatus } from '../../shared/backlog-model';
import type { ProjectView, RunTarget } from '../../shared/ipc-contract';
import { deriveRunStatus, type RunStatus } from '../../shared/run-state';
import { planDrain, type ActiveRun } from '../../shared/run-coordinator';
import type { IsolationRun } from '../../shared/isolation-policy';
import { mergeReadiness, type MergeRun } from '../../shared/merge-plan';

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

  // Bootstrap this Window: pick up any repo the opener queued, else re-attach to
  // whatever this Window already owns, else open this repo (the backend cwd).
  useEffect(() => {
    let cancelled = false;
    void window.mc.listProjects().then((list) => {
      if (cancelled) return;
      setProjects(list.projects);
      if (list.pendingOpen !== null) {
        void openProjectHere(list.pendingOpen);
      } else if (list.activeRepoPath !== null) {
        setActiveRepoPath(list.activeRepoPath);
      } else {
        void openProjectHere('');
      }
    });
    return () => {
      cancelled = true;
    };
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

  // --- Drain state ---------------------------------------------------------
  const [draining, setDraining] = useState(false);
  const [cap, setCap] = useState(2);
  const [drainMessage, setDrainMessage] = useState('');

  // --- Merge state (issue 08) ----------------------------------------------
  const [merging, setMerging] = useState(false);
  const [mergeMessage, setMergeMessage] = useState('');

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
        issueStatus: issueStatusOf(run.target.issueId),
      }),
    [issueStatusOf],
  );

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

  // --- Merge readiness (issue 08, ADR-0002) -------------------------------
  // A Run is "isolated" (worked on an afk/ branch in its own worktree) when its
  // Pane spawned somewhere other than the main checkout. The pure Merge Plan
  // then decides whether a human-triggered Merge should be offered and which
  // branches it would integrate — it appears once the parallel Runs have
  // finished, and never triggers on its own.
  const mergeRunsInput: MergeRun[] = runs.map((r) => ({
    issueId: r.target.issueId,
    slug: slugOf(r.target.issueFileName),
    status: runStatusOf(r),
    isolated: projectPath !== null && r.target.projectPath !== projectPath,
  }));
  const mergePlan = mergeReadiness(mergeRunsInput);

  const runMerge = useCallback((): void => {
    if (projectPath === null || merging) return;
    const candidates = mergePlan.mergeable;
    if (candidates.length === 0) return;
    const slugs = candidates.map((c) => c.slug);
    const mergedIds = new Set(candidates.map((c) => c.issueId));

    setMerging(true);
    setMergeMessage(`Merging ${slugs.length} finished Run(s) into main…`);
    void window.mc
      .mergeRuns({ projectPath, slugs })
      .then((result) => {
        setMergeMessage(result.message);
        if (result.ok) {
          // The merged Runs' worktrees are gone; drop them from tracking so the
          // Merge action clears. Unmerged (blocked/stopped) Runs stay put.
          setRuns((prev) => prev.filter((r) => !mergedIds.has(r.target.issueId)));
        }
      })
      .catch((err: unknown) => {
        setMergeMessage(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setMerging(false));
  }, [projectPath, merging, mergePlan]);

  const focusedRun = runs.find((r) => r.target.issueId === focusedId) ?? null;

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
          <span className="app__runtabs">
            {runs.map((r) => {
              const status = runStatusOf(r);
              return (
                <button
                  key={r.target.issueId}
                  className={`app__runtab${
                    r.target.issueId === focusedId ? ' app__runtab--active' : ''
                  }`}
                  onClick={() => setFocusedId(r.target.issueId)}
                  title={r.target.issueTitle}
                >
                  <span className={`run-status run-status--${status}`}>{status}</span>
                  <span className="app__runtab-id">
                    {String(r.target.issueId).padStart(2, '0')}
                  </span>
                </button>
              );
            })}
          </span>
        )}

        {view === 'pane' && focusedRun && (
          <span className="app__run">
            <span className="app__run-title">{focusedRun.target.issueTitle}</span>
            {runStatusOf(focusedRun) === 'running' && (
              <button className="run-stop" onClick={() => stopRun(focusedRun.target.issueId)}>
                Stop
              </button>
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
            mergeMessage={mergeMessage}
          />
        </div>

        {/* One Pane per tracked Run, all mounted so their sessions persist;
            only the focused one is shown. A plain shell Pane (issue 01) shows
            when no Run is tracked and the Pane view is selected. */}
        {runs.map((r) => (
          <div
            key={r.target.issueId}
            className="app__slot"
            style={{
              display: view === 'pane' && r.target.issueId === focusedId ? 'flex' : 'none',
            }}
          >
            <Pane
              run={r.target}
              stopSignal={r.stopSignal}
              onStatusChange={r.target.issueId === focusedId ? setPaneStatus : undefined}
              onExit={() => handleRunExit(r.target.issueId)}
            />
          </div>
        ))}
        {runs.length === 0 && view === 'pane' && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <Pane onStatusChange={setPaneStatus} onExit={() => setPaneStatus('exited')} />
          </div>
        )}
      </div>
    </div>
  );
}
