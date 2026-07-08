import { useEffect, useRef, useState } from 'react';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import { deleteRefusal } from '../../shared/issue-file-ops';
import type { RunLogRecord, RunTarget } from '../../shared/ipc-contract';
import { runnableNow, type InFlightRuns } from '../../shared/run-eligibility';
import { drainAvailability } from '../../shared/run-coordinator';
import {
  deriveIssueState,
  dependents,
  type IssueMapState,
  type UnmetDependency,
} from '../../shared/issue-graph';
import {
  summarizeRunGuidance,
  describeRunGuidance,
  type RunGuidance,
} from '../../shared/run-guidance';
import type { MergeDisplay } from '../../shared/merge-display';
import {
  previewBadge,
  type BranchPreview,
  type MergePreviewVerdict,
} from '../../shared/merge-preview';

interface MapProps {
  /**
   * The active Project's repo path, driven by the Project Registry (issue 09).
   * When provided (controlled), the Map loads this repo and re-loads whenever it
   * changes, and hides its own path input — the ProjectBar owns Project choice.
   * When `undefined` (uncontrolled), the Map keeps its original self-driven
   * behavior of loading the backend's own repo on mount.
   */
  projectPath?: string | null;
  /** Start a Run on an eligible issue (opens a Pane scoped to it). */
  onRun?: (target: RunTarget) => void;
  /** Bump to force a reload from disk (used to reflect a Run reaching done). */
  reloadKey?: number;
  /** Fired after each load so the parent can track live issue statuses. */
  onBacklogLoaded?: (backlog: Backlog | null, projectPath: string) => void;
  /** The issue ids currently being Run (highlighted, Run action suppressed). */
  activeRunIssueIds?: number[];
  /**
   * Issue ids with a LIVE isolated Run in its worktree (issue 16, from the
   * on-disk `afk/` scan) — shown as `running` (in-worktree) even though the main
   * checkout still reads `open`.
   */
  worktreeRunningIds?: number[];
  /**
   * Issue ids whose isolated Run is committed on its `afk/` branch but not yet
   * merged (issue 16) — shown as `finished (unmerged)`, distinct from plain
   * `open` and merged-`done`. Derived from disk, so it survives closing Panes.
   */
  finishedUnmergedIds?: number[];
  /**
   * Issue ids whose isolated Run ended without a `done` commit and no live
   * session drives it (issue 22) — shown as `stranded`, with a Discard action so
   * it stops blocking the batch. Derived from disk, so it survives closing Panes.
   */
  strandedIds?: number[];
  /**
   * Issue ids whose isolated Run finished in its worktree but the auto-commit
   * never landed on the branch (issue 22) — shown as `commit failed`, also with a
   * Discard action.
   */
  commitFailedIds?: number[];
  /**
   * Discard a stranded / commit-failed Run: force-remove its worktree and delete
   * its `afk/NN-slug` branch (issue 22). Given the slug and issue id.
   */
  onDiscard?: (slug: string, issueId: number) => void;
  /** Start draining the backlog with the given max-concurrent cap (issue 06). */
  onDrain?: (cap: number) => void;
  /** Stop an in-progress drain (start no further Runs). */
  onStopDrain?: () => void;
  /** True while a drain is actively starting/queueing Runs. */
  draining?: boolean;
  /** The reason the last drain stopped, shown when not draining. */
  drainMessage?: string;
  /** The user-configurable max-concurrent cap. */
  cap?: number;
  /** Change the cap. */
  onCapChange?: (cap: number) => void;
  /** True once parallel Runs have finished and a Merge is offered (issue 08). */
  mergeReady?: boolean;
  /** How many finished branches the Merge would integrate. */
  mergeCount?: number;
  /** Trigger the human-initiated Merge (never automatic — ADR-0002). */
  onMerge?: () => void;
  /** True while a Merge is running. */
  merging?: boolean;
  /**
   * What to show for the last (or in-flight) Merge: a headline plus, on a
   * failure/conflict, the script's verbatim `output` in a details panel (issue
   * 17). Null when no Merge has been triggered yet.
   */
  mergeDisplay?: MergeDisplay | null;
  /**
   * True when `main` is left mid-merge by a partial merge conflict (issue 24):
   * some slugs merged then a later one conflicted, leaving a conflicted index.
   * While true the Map blocks new Runs/Drain and shows an Abort affordance.
   */
  midMerge?: boolean;
  /** Abort the in-progress merge, returning `main` to a clean state (issue 24). */
  onAbortMerge?: () => void;
  /** True while an Abort is running. */
  aborting?: boolean;
  /**
   * Per-branch merge-preview verdicts (issue 104, ADR-0018): computed in the
   * background and kept fresh as `main` moves. In this tracer slice only the
   * first mergeable branch carries a verdict (`clean`/`conflicts`/
   * `recalculating`); later branches have `verdict: null` (no badge — issue 105).
   * Purely advisory — the Merge/Abort affordances are untouched.
   */
  previews?: BranchPreview[];
  /**
   * The single passive note shown when merge previews are unavailable because
   * git is below the 2.38 floor (ADR-0018 degradation), else null. Never shown
   * alongside badges.
   */
  previewNote?: string | null;
  /**
   * The active Project's captured Completion blocks, newest first (issue 34).
   * Rendered as the Run-log feed — one card per Run — which survives closing the
   * Run's Pane (it is App state loaded from disk, not tied to any live Pane).
   */
  runLog?: RunLogRecord[];
  /**
   * An Inbox click-through's focus request (issue 80): select this issue so
   * its detail opens — the parked/blocked issue the item referenced. Null when
   * nothing was requested.
   */
  focusIssueId?: number | null;
  /**
   * Bumped per click-through so re-focusing the SAME issue still re-selects it
   * (the user may have clicked elsewhere in the Map since).
   */
  focusSeq?: number;
  /**
   * Issue ids whose `repo:` targets a PLANNED (declared-but-absent) repo (issue
   * 96, ADR-0017): rendered grayed and un-runnable — they can't start until
   * their repo is created. An id leaves this set once its repo appears, so the
   * row ungrays automatically.
   */
  plannedIssueIds?: number[];
  /**
   * The Project's declared-but-absent repos (issue 96): shown grayed so the
   * intended codebase shape is visible before any code exists. Each becomes
   * real (leaves this list) once its directory appears and is registered.
   */
  plannedRepos?: { key: string; path: string }[];
}

/**
 * The Map view: point at a Project's repo path and see its backlog — every
 * issue with its status, in-batch/standalone classification and HITL flag.
 * Clicking an issue shows its full body; eligible issues have a Run action.
 * The Map reads from disk (via the main-process Backlog Reader adapter over
 * IPC).
 */
export function Map({
  projectPath: controlledPath,
  onRun,
  reloadKey,
  onBacklogLoaded,
  activeRunIssueIds,
  worktreeRunningIds,
  finishedUnmergedIds,
  strandedIds,
  commitFailedIds,
  onDiscard,
  onDrain,
  onStopDrain,
  draining,
  drainMessage,
  cap,
  onCapChange,
  mergeReady,
  mergeCount,
  onMerge,
  merging,
  mergeDisplay,
  midMerge,
  onAbortMerge,
  aborting,
  previews,
  previewNote,
  runLog,
  focusIssueId,
  focusSeq,
  plannedIssueIds,
  plannedRepos,
}: MapProps = {}): JSX.Element {
  const activeRunSet = new Set(activeRunIssueIds ?? []);
  // Merge-preview verdicts keyed by issue id (issue 104): the finished-unmerged
  // row shows this branch's badge. Only branches with a non-null verdict appear —
  // later branches in the tracer slice (issue 105) carry none. A plain record,
  // not a Map, since this component IS named `Map` and shadows the constructor.
  const previewByIssueId: Record<number, MergePreviewVerdict> = {};
  for (const p of previews ?? []) {
    if (p.verdict) previewByIssueId[p.issueId] = p.verdict;
  }
  const plannedIssueSet = new Set(plannedIssueIds ?? []);
  const worktreeRunningSet = new Set(worktreeRunningIds ?? []);
  const finishedUnmergedSet = new Set(finishedUnmergedIds ?? []);
  const strandedSet = new Set(strandedIds ?? []);
  const commitFailedSet = new Set(commitFailedIds ?? []);
  // The on-disk worktree scan (issue 16) that gates "can I Run this?" on truth
  // the main checkout can't see (issue 21): an issue live in a worktree or
  // finished-but-unmerged on its `afk/` branch is not runnable even while `main`
  // still reads it `open`. Fed to the guidance banner and the detail Run button
  // so both agree with the per-row indicators.
  const inFlight: InFlightRuns = {
    worktreeRunningIds,
    finishedUnmergedIds,
    strandedIds,
    commitFailedIds,
  };
  const [path, setPath] = useState('');
  const [lastRequest, setLastRequest] = useState('');
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Issue-file Edit / Delete (issue 89): the Map's one write exception. The
  // editor seeds from a FRESH disk read (never a possibly-stale push), saves
  // are parser-validated in main (a refusal shows here with its reason), and
  // the delete sits behind an inline confirm naming the file. All of it
  // resets whenever the selection changes.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [issueOpBusy, setIssueOpBusy] = useState(false);
  const [issueOpError, setIssueOpError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft('');
    setIssueOpBusy(false);
    setIssueOpError(null);
    setConfirmingDelete(false);
  }, [selectedId]);

  // An Inbox click-through focuses its referenced issue (issue 80): select it
  // so the detail panel opens on it. Keyed on the bump too, so clicking the
  // same item again re-focuses even after the user selected something else.
  useEffect(() => {
    if (focusIssueId !== null && focusIssueId !== undefined) setSelectedId(focusIssueId);
  }, [focusIssueId, focusSeq]);

  // The currently-shown Project path, read inside the live-change listener
  // without re-subscribing on every load.
  const resolvedPathRef = useRef<string | null>(null);
  resolvedPathRef.current = resolvedPath;

  async function load(projectPath: string): Promise<void> {
    setLoading(true);
    setError(null);
    setLastRequest(projectPath);
    try {
      const res = await window.mc.loadBacklog({ projectPath });
      setResolvedPath(res.projectPath);
      setBacklog(res.backlog);
      setError(res.error);
      onBacklogLoaded?.(res.backlog, res.projectPath);
      // Point the live file-watch at whatever Project we just loaded, so the
      // Map updates itself on disk changes (Run flips, hand-edits, add/remove).
      window.mc.watchBacklog({ projectPath: res.projectPath });
    } catch (err) {
      setBacklog(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const controlled = controlledPath !== undefined;

  // Uncontrolled (no Project Registry): on mount, load the backend's own repo so
  // the Map is populated without the user typing a path first.
  useEffect(() => {
    if (!controlled) void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled by the Project Registry: load the active Project whenever it
  // changes (a switch, or the initial claim resolving). Null means "no Project
  // open yet" — wait for one.
  useEffect(() => {
    if (!controlled || controlledPath === null || controlledPath === undefined) return;
    void load(controlledPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledPath]);

  // Live updates: the main process pushes a fresh backlog whenever the watched
  // `issues/` directory changes on disk (issue 05). This is the general
  // mechanism that replaces the Run slice's targeted poll — a Run reaching
  // `done`, a hand-edit, or an added/removed issue all arrive here. We apply a
  // push only when it matches the Project we're currently showing.
  useEffect(() => {
    const off = window.mc.onBacklogChanged((msg) => {
      if (msg.projectPath !== resolvedPathRef.current) return;
      setBacklog(msg.backlog);
      setError(msg.error);
      onBacklogLoaded?.(msg.backlog, msg.projectPath);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explicit one-shot reload when the parent bumps reloadKey (e.g. right as a
  // Run starts, to capture the issue's status immediately). Ongoing changes are
  // handled by the live watch above — this is not a poll.
  useEffect(() => {
    if (reloadKey === undefined || reloadKey === 0) return;
    void load(lastRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const selected = backlog?.issues.find((i) => i.id === selectedId) ?? null;

  // Map list order (issue 102): show the latest issues at the top. The shared
  // Backlog Model sorts ascending by id (and eligibility / the lowest-numbered
  // pick logic depend on that order), so we reverse ONLY here at the display
  // layer — a descending-by-id copy — without touching the model.
  const displayIssues = backlog ? [...backlog.issues].sort((a, b) => b.id - a.id) : [];

  // Drain honesty (issue 90): the control is enabled only when the coordinator
  // would actually have work — an issue startable now, or unblockable by the
  // drain (a live Run counts toward unblocking; a parked wip does not). The
  // backlog arrives via the live watch push, so adding an eligible issue
  // enables the button within a watch beat with no extra plumbing. Live Runs =
  // in-memory running Panes plus in-worktree Runs from the on-disk scan.
  const drainGate = drainAvailability(backlog?.issues ?? [], [
    ...activeRunSet,
    ...worktreeRunningSet,
  ]);

  // Open the editor on a fresh disk read of the full file (frontmatter +
  // body) — the backlog push only carries the body, and could be stale.
  async function startEdit(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    setConfirmingDelete(false);
    try {
      const res = await window.mc.readIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
      });
      if (res.content === null) {
        setIssueOpError(res.error ?? 'Could not read the issue file.');
        return;
      }
      setDraft(res.content);
      setEditing(true);
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueOpBusy(false);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    try {
      const res = await window.mc.editIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
        content: draft,
      });
      if (!res.ok) {
        // A refused save (parse-breaking text) keeps the editor open with the
        // draft intact, so the user fixes the text instead of losing it.
        setIssueOpError(res.error ?? 'Save failed.');
        return;
      }
      setEditing(false);
      setDraft('');
      // The reparsed backlog arrives via the live watch push — nothing to do.
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueOpBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    try {
      const res = await window.mc.deleteIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
      });
      if (!res.ok) {
        setIssueOpError(res.error ?? 'Delete failed.');
        setConfirmingDelete(false);
        return;
      }
      // The file is gone; clear the selection (the watch push drops the row).
      setConfirmingDelete(false);
      setSelectedId(null);
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
      setConfirmingDelete(false);
    } finally {
      setIssueOpBusy(false);
    }
  }

  return (
    <div className="map">
      {/* When the Project Registry drives the active repo (issue 09), the
          ProjectBar owns Project choice, so the Map's own path input is hidden;
          we still show the resolved path + PRD meta line for context. */}
      {controlled ? (
        resolvedPath && (
          <div className="map__bar">
            <span className="map__meta">
              {resolvedPath}
              {backlog?.activePrd ? ` · PRD: ${backlog.activePrd}` : ' · no active PRD'}
            </span>
          </div>
        )
      ) : (
        <div className="map__bar">
          <input
            className="map__input"
            type="text"
            placeholder="Project repo path (blank = this repo)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(path);
            }}
          />
          <button className="map__load" onClick={() => void load(path)} disabled={loading}>
            {loading ? 'Loading…' : 'Load'}
          </button>
          {resolvedPath && (
            <span className="map__meta">
              {resolvedPath}
              {backlog?.activePrd ? ` · PRD: ${backlog.activePrd}` : ' · no active PRD'}
            </span>
          )}
        </div>
      )}

      {/* Merge-preview degradation note (issue 104, ADR-0018): when git is below
          the 2.38 floor there are no badges anywhere, just this one passive
          line naming the version floor. No fallback merge machinery. */}
      {previewNote && resolvedPath !== null && (
        <div className="map__preview-note" title={previewNote}>
          {previewNote}
        </div>
      )}

      {/* Mid-merge banner (issue 24): a partial afk-merge.sh conflict left `main`
          with earlier slugs merged and a later one conflicted, so `main` is
          mid-merge. New Runs/Drain are blocked until this clears; Abort runs
          `git merge --abort` to return `main` to a clean state (no manual git),
          keeping the already-merged slugs. */}
      {midMerge && resolvedPath !== null && (
        <div className="map__midmerge">
          <span className="map__midmerge-text">
            main is mid-merge — a merge stopped on a conflict with some branches
            already integrated. Resolve the conflict and commit, or abort to return
            main to a clean state. New Runs and Drain are paused until then.
          </span>
          {onAbortMerge && (
            <button
              className="map__midmerge-abort"
              onClick={() => onAbortMerge()}
              disabled={aborting}
              title="Run git merge --abort to return main to a clean state (already-merged branches stay merged)"
            >
              {aborting ? 'Aborting…' : 'Abort merge'}
            </button>
          )}
        </div>
      )}

      {onDrain && resolvedPath !== null && (
        <div className="map__drainbar">
          <label className="map__cap">
            max concurrent
            <input
              className="map__cap-input"
              type="number"
              min={1}
              step={1}
              value={cap ?? 2}
              disabled={draining}
              onChange={(e) => onCapChange?.(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </label>
          {draining ? (
            <button className="map__drain map__drain--stop" onClick={() => onStopDrain?.()}>
              ■ Stop drain
            </button>
          ) : (
            <button
              className="map__drain"
              onClick={() => onDrain(cap ?? 2)}
              disabled={midMerge || !drainGate.available}
              title={
                midMerge
                  ? 'Blocked: main is mid-merge — resolve or abort the merge first'
                  : (drainGate.reason ??
                    'Drain the backlog, starting eligible Runs up to the cap')
              }
            >
              ▶▶ Drain backlog
            </button>
          )}
          {draining && <span className="map__drain-state">draining… starting eligible Runs up to {cap ?? 2}</span>}
          {/* The truthful reason the Drain control is disabled (issue 90):
              empty backlog / nothing the drain could start or unblock. Shown
              inline so it's never a dead click. */}
          {!draining && !midMerge && drainGate.reason && (
            <span className="map__drain-state map__drain-state--stopped">{drainGate.reason}</span>
          )}
          {!draining && drainMessage && drainMessage !== drainGate.reason && (
            <span className="map__drain-state map__drain-state--stopped">{drainMessage}</span>
          )}
        </div>
      )}

      {/* Planned repos (issue 96, ADR-0017): repos declared in the CONFIG whose
          directory doesn't exist yet (planning-first). Shown grayed so the
          intended codebase shape is visible before any code exists; each turns
          real (leaves this bar, ungrays its issues) once its directory appears
          and is registered (issue 95). */}
      {resolvedPath !== null && plannedRepos && plannedRepos.length > 0 && (
        <div className="map__plannedbar">
          <span className="map__planned-label">
            Planned repos — declared, not yet created:
          </span>
          {plannedRepos.map((r) => (
            <span
              key={r.key}
              className="map__planned-repo"
              title={`${r.path || r.key} does not exist yet — a scaffold Run (or issue 95 registration) will create it`}
            >
              <code>{r.key}</code>
              {r.path ? <span className="map__planned-repo-path"> · {r.path}</span> : null}
            </span>
          ))}
        </div>
      )}

      {/* Merge (issue 08, ADR-0002): appears once the parallel Runs have
          finished, integrates their branches into main, and is ALWAYS
          human-triggered — clicking it is the only thing that starts a merge. */}
      {onMerge && resolvedPath !== null && (mergeReady || merging || mergeDisplay) && (
        <div className="map__mergebar">
          <div className="map__mergebar-row">
            {(mergeReady || merging) && (
              <button
                className="map__merge"
                onClick={() => onMerge()}
                disabled={merging || !mergeReady}
                title="Merge finished parallel Runs into main"
              >
                {merging
                  ? 'Merging…'
                  : `⤵ Merge ${mergeCount ?? 0} finished Run${mergeCount === 1 ? '' : 's'} into main`}
              </button>
            )}
            {mergeDisplay && (
              <span className={`map__merge-state map__merge-state--${mergeDisplay.tone}`}>
                {mergeDisplay.headline}
              </span>
            )}
          </div>
          {/* The "see details below" below (issue 17): the script's verbatim
              output on a failure/conflict, in a scrollable, collapsible panel.
              Open by default so the detail is visible without a click; the user
              can fold it away once read. */}
          {mergeDisplay?.showOutput && mergeDisplay.output && (
            <details className="map__merge-details" open>
              <summary className="map__merge-details-summary">Merge output</summary>
              <pre className="map__merge-output">{mergeDisplay.output}</pre>
            </details>
          )}
        </div>
      )}

      {/* Stranded / commit-failed Runs (issue 22): a blocked/stopped/commit-failed
          isolated Run can never merge as-is and, before this, its worktree read
          `running` forever and suppressed the batch Merge. This bar is derived
          from the on-disk scan (so it survives closing every Pane) and offers a
          Discard — force-remove the worktree + delete the branch — so the batch
          can proceed. */}
      {onDiscard &&
        resolvedPath !== null &&
        backlog &&
        (strandedSet.size > 0 || commitFailedSet.size > 0) && (
          <div className="map__strandedbar">
            <span className="map__stranded-label">
              Stranded Runs — these can’t merge; discard to unblock the batch:
            </span>
            {backlog.issues
              .filter((i) => strandedSet.has(i.id) || commitFailedSet.has(i.id))
              .map((i) => {
                const failed = commitFailedSet.has(i.id);
                return (
                  <span key={i.id} className="map__stranded-item">
                    <span
                      className={`run-badge run-badge--${failed ? 'commit-failed' : 'stranded'}`}
                    >
                      {String(i.id).padStart(2, '0')} {failed ? 'commit failed' : 'stranded'}
                    </span>
                    <button
                      className="map__discard"
                      title="Force-remove this Run's worktree and afk/ branch"
                      onClick={() => onDiscard(i.fileName.replace(/\.md$/, ''), i.id)}
                    >
                      Discard
                    </button>
                  </span>
                );
              })}
          </div>
        )}

      {/* Empty state (issue 14): a Window driven by the Project Registry with no
          active Project opens NOTHING — it does not silently claim the backend
          cwd. Prompt the user to open or choose a Project via the ProjectBar. */}
      {controlled && controlledPath == null && (
        <div className="map__no-project">
          No Project open. Enter a repo path in the bar above and click{' '}
          <strong>Open here</strong>, choose one from the Project switcher, or
          open a repo in a new Window.
        </div>
      )}

      {error && <div className="map__error">Could not read backlog: {error}</div>}

      {/* Live "what can I Run right now" guidance (issue 11): derived every
          render from the current backlog via the same eligibility source of
          truth the rows use, so it never points at a stale issue number. When
          nothing is eligible it states why (blocked-on / all done-wip) instead
          of implying a Run action that isn't there. */}
      {backlog && (
        <RunGuidanceBanner
          issues={backlog.issues}
          inFlight={inFlight}
          onSelect={(id) => setSelectedId(id)}
        />
      )}

      {/* Run-log feed (issue 34): a scannable card per finished Run, parsed from
          its Completion block and loaded from the per-Project on-disk Run log —
          so it survives closing the Run's Pane, and persists across restarts. */}
      {resolvedPath !== null && runLog && runLog.length > 0 && (
        <RunLogFeed records={runLog} onSelect={(id) => id !== null && setSelectedId(id)} />
      )}

      <div className="map__split">
        <ul className="map__list">
          {displayIssues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              selected={issue.id === selectedId}
              planned={plannedIssueSet.has(issue.id)}
              running={activeRunSet.has(issue.id)}
              previewVerdict={previewByIssueId[issue.id] ?? null}
              worktreeRun={
                finishedUnmergedSet.has(issue.id)
                  ? 'finished-unmerged'
                  : commitFailedSet.has(issue.id)
                    ? 'commit-failed'
                    : strandedSet.has(issue.id)
                      ? 'stranded'
                      : worktreeRunningSet.has(issue.id)
                        ? 'running'
                        : null
              }
              state={deriveIssueState(issue, backlog!.issues)}
              onSelect={() => setSelectedId(issue.id)}
              onRun={
                onRun && resolvedPath !== null && !midMerge
                  ? () =>
                      onRun({
                        issueId: issue.id,
                        issueFileName: issue.fileName,
                        issueTitle: issue.title,
                        projectPath: resolvedPath,
                      })
                  : undefined
              }
            />
          ))}
          {backlog && backlog.issues.length === 0 && (
            <li className="map__empty">No issues found in this backlog.</li>
          )}
        </ul>

        <div className="map__detail">
          {selected ? (
            <>
              <div className="map__detail-head">
                <StatusBadge status={selected.status} />
                <span className="issue__title">{selected.title}</span>
                {selected.hitl && <span className="badge badge--hitl">HITL</span>}
                <span className={`badge badge--${classKind(selected)}`}>
                  {kindLabel(selected)}
                </span>
                {activeRunSet.has(selected.id) ? (
                  <span className="run-badge run-badge--active">Run in progress</span>
                ) : worktreeRunningSet.has(selected.id) ? (
                  <span className="run-badge run-badge--active">Run in progress</span>
                ) : finishedUnmergedSet.has(selected.id) ? (
                  <span className="run-badge run-badge--finished-unmerged">
                    finished (unmerged)
                  </span>
                ) : commitFailedSet.has(selected.id) ? (
                  <span className="run-badge run-badge--commit-failed">commit failed</span>
                ) : strandedSet.has(selected.id) ? (
                  <span className="run-badge run-badge--stranded">stranded</span>
                ) : plannedIssueSet.has(selected.id) ? (
                  <span
                    className="run-badge run-badge--planned"
                    title="Targets a planned repo — declared but not yet created; can't run until it exists"
                  >
                    planned
                  </span>
                ) : (
                  backlog &&
                  onRun &&
                  !midMerge &&
                  runnableNow(selected, backlog.issues, inFlight) && (
                    <button
                      className="run-btn"
                      onClick={() =>
                        onRun({
                          issueId: selected.id,
                          issueFileName: selected.fileName,
                          issueTitle: selected.title,
                          projectPath: resolvedPath ?? '',
                        })
                      }
                    >
                      ▶ Run
                    </button>
                  )
                )}
                {(strandedSet.has(selected.id) || commitFailedSet.has(selected.id)) &&
                  onDiscard && (
                    <button
                      className="map__discard map__discard--detail"
                      title="Force-remove this Run's worktree and afk/ branch"
                      onClick={() => onDiscard(selected.fileName.replace(/\.md$/, ''), selected.id)}
                    >
                      Discard
                    </button>
                  )}
              </div>
              {backlog && (
                <DependencySection issue={selected} issues={backlog.issues} />
              )}

              {/* Edit / Delete (issue 89): the Map's one write exception —
                  issue FILES only. Edit is a raw editor over the whole file
                  (frontmatter + body), saved back verbatim after the real
                  backlog parser accepts it; Delete is refused for wip (the
                  flip is a claim — someone owns it) and puts done behind an
                  explicit "delete anyway". */}
              {resolvedPath !== null && !editing && (
                <div className="map__issue-ops">
                  <button
                    className="map__issue-op"
                    onClick={() => void startEdit()}
                    disabled={issueOpBusy}
                    title="Edit this issue file (raw text: frontmatter + body)"
                  >
                    ✎ Edit
                  </button>
                  {(() => {
                    const refusal = deleteRefusal(selected.status);
                    return (
                      <button
                        className="map__issue-op map__issue-op--delete"
                        onClick={() => {
                          setIssueOpError(null);
                          setConfirmingDelete(true);
                        }}
                        disabled={issueOpBusy || confirmingDelete || refusal !== null}
                        title={refusal ?? `Delete ${selected.fileName}`}
                      >
                        🗑 Delete
                      </button>
                    );
                  })()}
                </div>
              )}

              {confirmingDelete && !editing && (
                <div className="map__delete-confirm">
                  <span className="map__delete-confirm-text">
                    Delete <code>{selected.fileName}</code>?
                    {selected.status === 'done'
                      ? ' This issue is done — its Receipt and history survive in git, but the file goes.'
                      : ' This removes the issue from the backlog.'}
                  </span>
                  <button
                    className="map__issue-op map__issue-op--delete"
                    onClick={() => void confirmDelete()}
                    disabled={issueOpBusy}
                  >
                    {selected.status === 'done' ? 'Delete anyway' : 'Delete file'}
                  </button>
                  <button
                    className="map__issue-op"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={issueOpBusy}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {issueOpError && <div className="map__issue-op-error">{issueOpError}</div>}

              {editing ? (
                <div className="issue-editor">
                  <textarea
                    className="issue-editor__textarea"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="issue-editor__row">
                    <button
                      className="map__issue-op map__issue-op--save"
                      onClick={() => void saveEdit()}
                      disabled={issueOpBusy}
                    >
                      {issueOpBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className="map__issue-op"
                      onClick={() => {
                        setEditing(false);
                        setDraft('');
                        setIssueOpError(null);
                      }}
                      disabled={issueOpBusy}
                    >
                      Cancel
                    </button>
                    <span className="issue-editor__hint">
                      Saved verbatim once it parses (status: open | wip | done).
                    </span>
                  </div>
                </div>
              ) : (
                <pre className="issue__body">{selected.body}</pre>
              )}
            </>
          ) : (
            <div className="map__detail-empty">Select an issue to see its full body.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Run-log feed (issue 34): the durable, per-Project history of finished
 * Runs, one card each, parsed from their Completion blocks. Collapsible so it
 * doesn't crowd the backlog; open by default when there are records to show.
 */
function RunLogFeed({
  records,
  onSelect,
}: {
  records: RunLogRecord[];
  onSelect: (issueId: number | null) => void;
}): JSX.Element {
  return (
    <details className="map__runlog" open>
      <summary className="map__runlog-summary">
        Run log — {records.length} Run{records.length === 1 ? '' : 's'} captured
      </summary>
      <ul className="map__runlog-list">
        {records.map((r) => (
          <RunLogCard key={r.id} record={r} onSelect={() => onSelect(r.issueId)} />
        ))}
      </ul>
    </details>
  );
}

/** A short, human label for a Run outcome (drives the badge text + colour). */
function outcomeLabel(outcome: RunLogRecord['outcome']): string {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'needs-verification':
      return 'needs verification';
    case 'blocked':
      return 'blocked';
    default:
      return 'unparsed';
  }
}

/** One captured Completion block as a card, showing only its present fields. */
function RunLogCard({
  record,
  onSelect,
}: {
  record: RunLogRecord;
  onSelect: () => void;
}): JSX.Element {
  const idLabel = record.issueId !== null ? String(record.issueId).padStart(2, '0') : '—';
  const heading = record.title ? stripId(record.title) : (record.issue ?? record.slug ?? 'Run');
  const fields: [string, string | null][] = [
    ['What changed', record.whatChanged],
    ['Try it yourself', record.tryIt],
    ['Verified', record.verified],
    ['Bookkeeping', record.bookkeeping],
    ['Doc drift', record.docDrift],
  ];
  // The free-form report body (blocked reason / verification steps / unparsed
  // text) only carries substance when there are no named sections — show it as
  // a "Report" field then, so a blocked Run's card isn't left empty.
  const sectionsPresent = fields.some(([, v]) => v !== null && v !== '');
  if (!sectionsPresent && record.detail !== null && record.detail !== '') {
    fields.push(['Report', record.detail]);
  }
  const shown = fields.filter(([, v]) => v !== null && v !== '');
  return (
    <li className="runlog-card" onClick={onSelect} title="Show this issue in the backlog">
      <div className="runlog-card__head">
        <span className={`runlog-badge runlog-badge--${record.outcome}`}>
          {outcomeLabel(record.outcome)}
        </span>
        <span className="runlog-card__id">{idLabel}</span>
        <span className="runlog-card__title">{heading}</span>
        <span className="runlog-card__time">
          {new Date(record.capturedAt).toLocaleString()}
        </span>
      </div>
      {shown.length > 0 ? (
        <dl className="runlog-card__fields">
          {shown.map(([label, value]) => (
            <div key={label} className="runlog-card__field">
              <dt className="runlog-card__label">{label}</dt>
              <dd className="runlog-card__value">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="runlog-card__empty">
          No Completion block was captured for this Run (it may have ended without
          emitting one).
        </div>
      )}
    </li>
  );
}

/**
 * Live Run guidance (issue 11). Recomputes on every render from the current
 * issues, so a status change elsewhere in the batch is reflected immediately.
 * Eligible → lists the runnable issues as clickable chips (click selects the
 * row, where the existing Run button lives). Otherwise → an explicit
 * empty-state naming what's blocking, or that everything is done/wip.
 */
function RunGuidanceBanner({
  issues,
  inFlight,
  onSelect,
}: {
  issues: BacklogIssue[];
  inFlight: InFlightRuns;
  onSelect: (id: number) => void;
}): JSX.Element {
  const guidance: RunGuidance = summarizeRunGuidance(issues, inFlight);
  const eligible = guidance.kind === 'eligible';
  return (
    <div className={`map__guidance map__guidance--${eligible ? 'eligible' : 'none'}`}>
      <span className="map__guidance-text">{describeRunGuidance(guidance)}</span>
      {guidance.kind === 'eligible' && (
        <span className="map__guidance-chips">
          {guidance.runnable.map((r) => (
            <button
              key={r.id}
              className="map__guidance-chip"
              title={`Show ${stripId(r.title)}`}
              onClick={() => onSelect(r.id)}
            >
              {String(r.id).padStart(2, '0')}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  selected,
  planned,
  running,
  previewVerdict,
  worktreeRun,
  state,
  onSelect,
  onRun,
}: {
  issue: BacklogIssue;
  selected: boolean;
  /**
   * The issue's `repo:` targets a PLANNED (declared-but-absent) repo (issue 96,
   * ADR-0017): the row grays and offers no Run — it can't start until its repo
   * is created. Ungrays automatically once the repo appears.
   */
  planned: boolean;
  running: boolean;
  /**
   * This branch's merge-preview verdict (issue 104): shown as an advisory badge
   * beside `finished (unmerged)`. Null when there is no verdict (not a
   * finished-unmerged row, a later branch in the tracer slice, or git < 2.38).
   */
  previewVerdict: MergePreviewVerdict | null;
  /**
   * The issue's isolated-Run state derived from the on-disk `afk/` scan: `running`
   * (live in its worktree), `stranded` (Run ended without a done commit, issue
   * 22), `commit-failed` (finished but the commit never landed, issue 22), or
   * `finished-unmerged` (committed but not merged, issue 16). Null when it has no
   * worktree Run. Takes precedence over the main-checkout status/eligibility for
   * the row indicator, so a Run in flight, stranded, or awaiting merge never
   * looks like plain `open`.
   */
  worktreeRun: 'running' | 'stranded' | 'commit-failed' | 'finished-unmerged' | null;
  state: IssueMapState;
  onSelect: () => void;
  onRun?: () => void;
}): JSX.Element {
  // A worktree Run (in flight or finished-unmerged) is being worked/awaiting
  // merge — so it is neither "eligible" to start nor offered a Run button, even
  // though the main checkout still reads `open`.
  // A planned-repo issue can never start until its repo is created — treat it
  // like a worked row for Run-affordance purposes so no Run button shows.
  const worked = worktreeRun !== null || running || planned;
  return (
    <li
      className={`issue${selected ? ' issue--selected' : ''}${planned ? ' issue--planned' : ''}`}
      onClick={onSelect}
    >
      <StatusBadge status={issue.status} />
      <span className="issue__id">{String(issue.id).padStart(2, '0')}</span>
      <span className="issue__title">{stripId(issue.title)}</span>
      <span className="issue__tags">
        {issue.hitl && <span className="badge badge--hitl">HITL</span>}
        <span className={`badge badge--${classKind(issue)}`}>{kindLabel(issue)}</span>
        {planned && (
          <span
            className="badge badge--planned"
            title="Targets a planned repo — declared but not yet created; can't run until it exists"
          >
            planned
          </span>
        )}
        {state.kind === 'blocked' && (
          <span
            className="badge badge--blocked"
            title={`Blocked: waiting on ${state.unmet.map((d) => depLabel(d)).join(', ')}`}
          >
            blocked
          </span>
        )}
        {state.kind === 'eligible' && !worked && (
          <span className="badge badge--eligible">eligible</span>
        )}
        {worktreeRun === 'finished-unmerged' ? (
          <>
            <span
              className="run-badge run-badge--finished-unmerged"
              title="This Run's work is committed on its afk/ branch but not yet merged into main"
            >
              finished (unmerged)
            </span>
            {/* Merge preview (issue 104): advisory — whether pressing Merge would
                land clean or conflict, without pressing it. */}
            {previewVerdict && <MergePreviewBadge verdict={previewVerdict} />}
          </>
        ) : worktreeRun === 'commit-failed' ? (
          <span
            className="run-badge run-badge--commit-failed"
            title="This Run finished but its work could not be committed to the afk/ branch — discard it from the bar above"
          >
            commit failed
          </span>
        ) : worktreeRun === 'stranded' ? (
          <span
            className="run-badge run-badge--stranded"
            title="This Run ended without committing done; its worktree is stranded — discard it from the bar above"
          >
            stranded
          </span>
        ) : worktreeRun === 'running' || running ? (
          <span
            className="run-badge run-badge--active"
            title={
              worktreeRun === 'running'
                ? 'A Run is live in this issue’s worktree'
                : 'A Run is in progress'
            }
          >
            running{worktreeRun === 'running' ? ' (in-worktree)' : ''}
          </span>
        ) : (
          state.kind === 'eligible' &&
          !planned &&
          onRun && (
            <button
              className="run-btn run-btn--row"
              title="Start a Run on this issue"
              onClick={(e) => {
                e.stopPropagation();
                onRun();
              }}
            >
              ▶ Run
            </button>
          )
        )}
      </span>
    </li>
  );
}

/** Upstream/downstream dependency edges plus the blocked reason for one issue. */
function DependencySection({
  issue,
  issues,
}: {
  issue: BacklogIssue;
  issues: BacklogIssue[];
}): JSX.Element | null {
  const state = deriveIssueState(issue, issues);
  const downstream = dependents(issue, issues);

  if (issue.dependsOn.length === 0 && downstream.length === 0) return null;

  return (
    <div className="map__detail-deps">
      {state.kind === 'blocked' && (
        <div className="map__blocked">
          Blocked — waiting on {state.unmet.map((d) => depLabel(d)).join(', ')}
        </div>
      )}
      {state.kind === 'eligible' && (
        <div className="map__eligible">Eligible — all dependencies are done.</div>
      )}
      {issue.dependsOn.length > 0 && (
        <div className="map__edges">
          <span className="map__edges-label">depends on</span>
          {issue.dependsOn.map((depId) => {
            const dep = issues.find((i) => i.id === depId);
            const met = dep?.status === 'done';
            return (
              <span
                key={depId}
                className={`dep-chip ${met ? 'dep-chip--met' : 'dep-chip--unmet'}`}
                title={dep ? dep.title : 'missing from backlog'}
              >
                {met ? '✓' : '○'} {String(depId).padStart(2, '0')}
                {dep ? ` (${dep.status})` : ' (missing)'}
              </span>
            );
          })}
        </div>
      )}
      {downstream.length > 0 && (
        <div className="map__edges">
          <span className="map__edges-label">blocks</span>
          {downstream.map((id) => (
            <span key={id} className="dep-chip dep-chip--down">
              {String(id).padStart(2, '0')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** "03 — Run one issue … (wip)" for a blocked reason. */
function depLabel(dep: UnmetDependency): string {
  const id = String(dep.id).padStart(2, '0');
  const title = dep.title ? ` ${stripId(dep.title)}` : '';
  return `${id}${title} (${dep.status})`;
}

function StatusBadge({ status }: { status: BacklogIssue['status'] }): JSX.Element {
  return <span className={`status status--${status}`}>{status}</span>;
}

/**
 * The advisory merge-preview badge (issue 104, ADR-0018): `merges clean`,
 * `conflicts (files…)`, or `recalculating…`, driven by the pure `previewBadge`
 * display selector. The conflict file list is in both the label and the tooltip
 * so the blast radius is visible without pressing Merge.
 */
function MergePreviewBadge({ verdict }: { verdict: MergePreviewVerdict }): JSX.Element {
  const badge = previewBadge(verdict);
  return (
    <span className={`run-badge run-badge--preview-${badge.tone}`} title={badge.title}>
      {badge.label}
    </span>
  );
}

/** in-batch | standalone | out-of-batch — for the tag class + label. */
function classKind(issue: BacklogIssue): 'inbatch' | 'standalone' | 'other' {
  if (issue.inBatch) return 'inbatch';
  if (issue.standalone) return 'standalone';
  return 'other';
}

function kindLabel(issue: BacklogIssue): string {
  if (issue.inBatch) return 'in-batch';
  if (issue.standalone) return 'standalone';
  return 'out-of-batch';
}

/** Titles usually start with "NN — "; drop that since the row shows the id. */
function stripId(title: string): string {
  return title.replace(/^\d+\s*[—-]\s*/, '');
}
