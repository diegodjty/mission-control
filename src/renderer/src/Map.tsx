import { useEffect, useRef, useState } from 'react';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import type { RunTarget } from '../../shared/ipc-contract';
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
}: MapProps = {}): JSX.Element {
  const activeRunSet = new Set(activeRunIssueIds ?? []);
  const worktreeRunningSet = new Set(worktreeRunningIds ?? []);
  const finishedUnmergedSet = new Set(finishedUnmergedIds ?? []);
  // The on-disk worktree scan (issue 16) that gates "can I Run this?" on truth
  // the main checkout can't see (issue 21): an issue live in a worktree or
  // finished-but-unmerged on its `afk/` branch is not runnable even while `main`
  // still reads it `open`. Fed to the guidance banner and the detail Run button
  // so both agree with the per-row indicators.
  const inFlight: InFlightRuns = { worktreeRunningIds, finishedUnmergedIds };
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
            <button className="map__drain" onClick={() => onDrain(cap ?? 2)}>
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
                  : worktreeRunningSet.has(issue.id)
                    ? 'running'
                    : null
              }
              state={deriveIssueState(issue, backlog!.issues)}
              onSelect={() => setSelectedId(issue.id)}
              onRun={
                onRun && resolvedPath !== null
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
                ) : (
                  backlog &&
                  onRun &&
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
   * The issue's isolated-Run state derived from the on-disk `afk/` scan (issue
   * 16): `running` (live in its worktree) or `finished-unmerged` (committed but
   * not merged). Null when it has no active/finished worktree Run. Takes
   * precedence over the main-checkout status/eligibility for the row indicator,
   * so a Run in flight or awaiting merge never looks like plain `open`.
   */
  worktreeRun: 'running' | 'finished-unmerged' | null;
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
