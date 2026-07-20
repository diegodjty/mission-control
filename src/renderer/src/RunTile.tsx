import { Pane } from './Pane';
import { RunFeed } from './RunFeed';
import { dotTone, MaximizeIcon, slugOf } from './app/appHelpers';
import type { TrackedRun } from './app/appTypes';
import { takeoverKindFor } from '../../shared/run-takeover';
import type { RunStatus } from '../../shared/run-state';

export interface RunTileProps {
  run: TrackedRun;
  status: RunStatus;
  focusedId: number | null;
  /** The issue id of the currently-maximized tile, or null when the grid is tiled. */
  maximizedIssueId: number | null;
  isIsolated: boolean;
  strandedIds: number[];
  commitFailedIds: number[];
  finishedUnmergedIds: number[];
  worktreeCommitErrors: Record<number, string | null>;
  onToggleMaximize: (issueId: number) => void;
  onTakeOver: (issueId: number) => void;
  onStop: (issueId: number) => void;
  onDismiss: (issueId: number) => void;
  onDiscard: (issueId: number, slug: string) => void;
  onSetPaneStatus: (status: string) => void;
  onRunSession: (issueId: number, sessionId: string) => void;
  onClaudeSession: (issueId: number, claudeSessionId: string) => void;
  onRunExit: (issueId: number, endCause?: 'timeout' | 'crashed') => void;
}

/**
 * Renders one Run's tile — a compact Feed card (headless) or a terminal
 * Pane — shared by the Feed board and the Pane grid so take-over (issue 144)
 * is just a re-render of the same tile with a different body underneath the
 * unchanged header/controls.
 */
export function RunTile({
  run: r,
  status,
  focusedId,
  maximizedIssueId,
  isIsolated,
  strandedIds,
  commitFailedIds,
  finishedUnmergedIds,
  worktreeCommitErrors,
  onToggleMaximize,
  onTakeOver,
  onStop,
  onDismiss,
  onDiscard,
  onSetPaneStatus,
  onRunSession,
  onClaudeSession,
  onRunExit,
}: RunTileProps): JSX.Element {
  const id = r.target.issueId;
  const slug = slugOf(r.target.issueFileName);
  // Take-over affordance (issue 144): a live headless Run offers
  // "Take over" (grab it mid-flight as a Pane); a finished one offers
  // "Resume" (reopen the session post-mortem to interrogate it). Both
  // need a captured claude session id — null until the init event
  // lands — and only apply to a headless (Feed) Run.
  const takeover = takeoverKindFor(status, r.target.headless, r.claudeSessionId);
  // The header shows the issue slug WITHOUT its numeric prefix (the
  // number is already the "Run NN" / issue-id cue); `slug` itself
  // keeps the prefix because it names the afk/<slug> branch below.
  const descriptor = slug.replace(/^\d+-/, '');
  const isStranded = strandedIds.includes(id);
  const isCommitFailed = commitFailedIds.includes(id);
  const isFinishedUnmerged =
    (status === 'finished' && isIsolated) || finishedUnmergedIds.includes(id);
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
    onDismiss(id);
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
      onDiscard(id, slug);
    }
  };
  const isMax = maximizedIssueId === r.target.issueId;
  const hidden = maximizedIssueId !== null && !isMax;
  return (
    <div
      key={r.target.issueId}
      className={`app__tile${isMax ? ' app__tile--max' : ''}${
        r.target.headless ? ' app__tile--feed' : ''
      }`}
      style={{ display: hidden ? 'none' : 'flex' }}
    >
      <div
        className="app__tile-head"
        onClick={() => onToggleMaximize(r.target.issueId)}
        title={r.target.issueTitle}
      >
        <span
          className={`app__tile-dot app__tile-dot--${dotTone(status)}`}
          title={status}
          aria-label={`Run status: ${status}`}
        />
        <span className="app__tile-run">Run {id}</span>
        <span className="app__tile-id">{id}</span>
        <span className="app__tile-sep">·</span>
        <span className="app__tile-slug">{descriptor}</span>
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
        <span className="app__tile-controls">
          {status === 'running' ? (
            <>
              {takeover === 'live' && (
                <button
                  className="run-takeover run-takeover--tile"
                  title="Kill this headless Run and take over its session in an interactive Pane (same working directory)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTakeOver(r.target.issueId);
                  }}
                >
                  Take over
                </button>
              )}
              <button
                className="run-stop run-stop--tile"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop(r.target.issueId);
                }}
              >
                Stop
              </button>
            </>
          ) : (
            <>
              {takeover === 'post-mortem' && (
                <button
                  className="run-takeover run-takeover--tile"
                  title="Reopen this finished Run's session in an interactive Pane to interrogate it (no new Run)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTakeOver(r.target.issueId);
                  }}
                >
                  Resume
                </button>
              )}
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
          <button
            className="app__tile-max"
            title={isMax ? 'Restore the grid' : 'Maximize this tile'}
            aria-label={isMax ? 'Restore the grid' : 'Maximize this tile'}
            aria-pressed={isMax}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize(r.target.issueId);
            }}
          >
            <MaximizeIcon maximized={isMax} />
          </button>
        </span>
      </div>
      {r.target.headless ? (
        // A drain Run is headless (issue 139): a read-only Feed strip
        // (status + elapsed), not a terminal — there is no input to
        // type into. The claude session id it captures is persisted
        // on the Run for resume/take-over.
        <RunFeed
          run={r.target}
          status={status}
          stopSignal={r.stopSignal}
          onSession={(sid) => onRunSession(r.target.issueId, sid)}
          onClaudeSession={(sid) => onClaudeSession(r.target.issueId, sid)}
          onStatusChange={r.target.issueId === focusedId ? onSetPaneStatus : undefined}
          onExit={(_exitCode, cause) => onRunExit(r.target.issueId, cause)}
        />
      ) : (
        <Pane
          run={r.target}
          stopSignal={r.stopSignal}
          onStatusChange={r.target.issueId === focusedId ? onSetPaneStatus : undefined}
          onExit={() => onRunExit(r.target.issueId)}
        />
      )}
    </div>
  );
}
