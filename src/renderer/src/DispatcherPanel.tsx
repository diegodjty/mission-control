import { Pane } from './Pane';
import type { DispatcherTarget } from '../../shared/ipc-contract';

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
}

/**
 * The Dispatcher chat panel (issue 35, ADR-0010): the conversational
 * orchestrator's `claude` session, rendered as a chat beside the Map. You talk
 * to it the way you'd talk to Claude in a terminal — ask "what's left?" and it
 * answers from the Completion blocks / Run log, never raw Pane scroll. The
 * worker Panes stay one click away in the Pane view. Spun up when a drain starts
 * (a single manual Run stays a bare Pane), scoped to one Project, dismissable.
 *
 * The terminal itself is a `Pane` in `dispatcher` mode; this wrapper adds the
 * header, the ingest count, and the Dismiss control. Dismissing unmounts the
 * Pane, whose cleanup kills the underlying session.
 */
export function DispatcherPanel({
  target,
  onSession,
  onDismiss,
  ingestedCount,
}: DispatcherPanelProps): JSX.Element {
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
      <div className="dispatcher__body">
        <Pane dispatcher={target} onSession={onSession} />
      </div>
    </div>
  );
}
