import { Pane } from './Pane';
import type { DispatcherTarget } from '../../shared/ipc-contract';
import type { DispatcherActivity } from '../../shared/dispatcher-proposal';

interface DispatcherPanelProps {
  /** The Project this Dispatcher orchestrates a drain for. */
  target: DispatcherTarget;
  /** Called with the Dispatcher session's PTY id once it spawns, so the parent
   *  can feed it Completion blocks (structured summaries — never raw Pane scroll). */
  onSession?: (sessionId: string) => void;
  /** Dismiss the Dispatcher — ends the session and closes the chat panel. */
  onDismiss?: () => void;
  /** How many Runs' Completion blocks have been captured so far (feed count). */
  ingestedCount?: number;
  /**
   * The Dispatcher's activity log (ADR-0007): autonomous actions it TOOK on its
   * own (auto) and scope-changing actions it's PROPOSING (needs-approval). The
   * panel renders the two distinctly and puts approve/reject on the proposals.
   */
  activities?: DispatcherActivity[];
  /** Approve a pending proposal — the parent then executes the action. */
  onApprove?: (id: string) => void;
  /** Reject a pending proposal — it's dropped and the Dispatcher continues. */
  onReject?: (id: string) => void;
}

/**
 * One activity row. The visual split is the whole point of ADR-0007's UX: an
 * autonomous action reads as a quiet "the Dispatcher did this" note, while a
 * proposal reads as an action item with the two one-click buttons — and never
 * executes here (the parent runs it only on Approve).
 */
function ActivityRow({
  activity,
  onApprove,
  onReject,
}: {
  activity: DispatcherActivity;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}): JSX.Element {
  const autonomous = activity.authority === 'auto';
  const pending = activity.status === 'pending';

  const kindClass = autonomous
    ? 'dispatcher__activity--auto'
    : 'dispatcher__activity--proposed';
  const stateClass =
    activity.status === 'approved'
      ? ' dispatcher__activity--approved'
      : activity.status === 'rejected'
        ? ' dispatcher__activity--rejected'
        : '';

  // The tag that labels which side of the authority line this row is on.
  const tag = autonomous
    ? 'Autonomous'
    : activity.status === 'approved'
      ? 'Approved'
      : activity.status === 'rejected'
        ? 'Rejected'
        : 'Needs approval';

  return (
    <li className={`dispatcher__activity ${kindClass}${stateClass}`}>
      <div className="dispatcher__activity-line">
        <span className="dispatcher__activity-tag" data-kind={autonomous ? 'auto' : 'proposed'}>
          {autonomous ? '● ' : '◆ '}
          {tag}
        </span>
        <span className="dispatcher__activity-label">{activity.label}</span>
      </div>
      {pending && (
        <div className="dispatcher__activity-actions">
          <button
            className="dispatcher__approve"
            title="Approve — the Dispatcher will run this action"
            onClick={() => onApprove?.(activity.id)}
          >
            Approve
          </button>
          <button
            className="dispatcher__reject"
            title="Reject — drop this action; the Dispatcher continues"
            onClick={() => onReject?.(activity.id)}
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The Dispatcher chat panel (issue 35, ADR-0010): the conversational
 * orchestrator's `claude` session, rendered as a chat beside the Map. You talk
 * to it the way you'd talk to Claude in a terminal — ask "what's left?" and it
 * answers from the Completion blocks / Run log, never raw Pane scroll. The
 * worker Panes stay one click away in the Pane view. Spun up when a drain starts
 * (a single manual Run stays a bare Pane), scoped to one Project, dismissable.
 *
 * On top of the chat, this panel is the Dispatcher's HYBRID-AUTHORITY surface
 * (issue 36, ADR-0007): actions it took on its own show as quiet autonomous
 * notes, while scope-changing actions it's proposing (a Merge, logging an issue,
 * aborting the drain, a course change) surface as a one-click approve/reject
 * that does NOT execute until you approve.
 *
 * The terminal itself is a `Pane` in `dispatcher` mode; this wrapper adds the
 * header, the ingest count, the activity/approval strip, and the Dismiss
 * control. Dismissing unmounts the Pane, whose cleanup kills the session.
 */
export function DispatcherPanel({
  target,
  onSession,
  onDismiss,
  ingestedCount,
  activities,
  onApprove,
  onReject,
}: DispatcherPanelProps): JSX.Element {
  const acts = activities ?? [];
  const pendingCount = acts.filter((a) => a.status === 'pending').length;

  return (
    <div className="dispatcher">
      <div className="dispatcher__head">
        <span className="dispatcher__title">Dispatcher</span>
        <span className="dispatcher__meta">
          {ingestedCount && ingestedCount > 0
            ? `${ingestedCount} block${ingestedCount === 1 ? '' : 's'} ingested`
            : 'driving the drain'}
        </span>
        {onDismiss && (
          <button
            className="dispatcher__dismiss"
            title="Dismiss the Dispatcher (ends the orchestrator session)"
            onClick={() => onDismiss()}
          >
            Dismiss
          </button>
        )}
      </div>
      {acts.length > 0 && (
        <div className="dispatcher__activities" role="log" aria-label="Dispatcher actions">
          {pendingCount > 0 && (
            <div className="dispatcher__activities-head">
              {pendingCount} action{pendingCount === 1 ? '' : 's'} awaiting your approval
            </div>
          )}
          <ul className="dispatcher__activity-list">
            {acts.map((a) => (
              <ActivityRow
                key={a.id}
                activity={a}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </ul>
        </div>
      )}
      <div className="dispatcher__body">
        <Pane dispatcher={target} onSession={onSession} />
      </div>
    </div>
  );
}
