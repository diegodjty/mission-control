import { useEffect, useRef, useState } from 'react';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import type { RunLogRecord, RunTarget } from '../../shared/ipc-contract';
import { runnableNow, type InFlightRuns } from '../../shared/run-eligibility';
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
   * The active Project's captured Completion blocks, newest first (issue 34).
   * Rendered as the Run-log feed — one card per Run — which survives closing the
   * Run's Pane (it is App state loaded from disk, not tied to any live Pane).
   */
  runLog?: RunLogRecord[];
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
  runLog,
}: MapProps = {}): JSX.Element {
  const activeRunSet = new Set(activeRunIssueIds ?? []);
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
              disabled={midMerge}
              title={
                midMerge
                  ? 'Blocked: main is mid-merge — resolve or abort the merge first'
                  : 'Drain the backlog, starting eligible Runs up to the cap'
              }
            >
              ▶▶ Drain backlog
            </button>
          )}
          {draining && <span className="map__drain-state">draining… starting eligible Runs up to {cap ?? 2}</span>}
          {!draining && drainMessage && (
            <span className="map__drain-state map__drain-state--stopped">{drainMessage}</span>
          )}
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
          {backlog?.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              selected={issue.id === selectedId}
              running={activeRunSet.has(issue.id)}
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
              <pre className="issue__body">{selected.body}</pre>
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
  running,
  worktreeRun,
  state,
  onSelect,
  onRun,
}: {
  issue: BacklogIssue;
  selected: boolean;
  running: boolean;
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
  const worked = worktreeRun !== null || running;
  return (
    <li className={`issue${selected ? ' issue--selected' : ''}`} onClick={onSelect}>
      <StatusBadge status={issue.status} />
      <span className="issue__id">{String(issue.id).padStart(2, '0')}</span>
      <span className="issue__title">{stripId(issue.title)}</span>
      <span className="issue__tags">
        {issue.hitl && <span className="badge badge--hitl">HITL</span>}
        <span className={`badge badge--${classKind(issue)}`}>{kindLabel(issue)}</span>
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
          <span
            className="run-badge run-badge--finished-unmerged"
            title="This Run's work is committed on its afk/ branch but not yet merged into main"
          >
            finished (unmerged)
          </span>
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
