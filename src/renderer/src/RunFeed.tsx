import { useEffect, useRef, useState } from 'react';
import './RunFeed.css';
import type { RunTarget } from '../../shared/ipc-contract';
import type { RunStatus } from '../../shared/run-state';
import {
  deriveFeedState,
  formatElapsed,
  EMPTY_FEED_CONTENT,
  type FeedContent,
} from '../../shared/headless-feed';

interface RunFeedProps {
  /** The headless Run target (`headless: true`) this Feed watches. */
  run: RunTarget;
  /** The Run's derived status (run-state) — the label the strip shows. */
  status: RunStatus;
  /** Bump to stop the Run: the underlying child process is killed. */
  stopSignal?: number;
  /** Fired with the MC-internal spawn session id once spawned (issue 139). */
  onSession?: (sessionId: string) => void;
  /** Fired with the claude session id once captured from the stream (AC3). */
  onClaudeSession?: (claudeSessionId: string) => void;
  /**
   * Fired when the underlying child process exits, with its exit code and —
   * when the Headless Session Manager named one (issue 141) — the cause:
   * `timeout` (killed for exceeding `run_timeout`) or `crashed` (non-zero on
   * its own). Absent for a clean exit.
   */
  onExit?: (exitCode: number, cause?: 'timeout' | 'crashed') => void;
  /** Display-only status string for the focused-Run header (mirrors Pane). */
  onStatusChange?: (status: string) => void;
}

/**
 * The read-only **Feed** of a headless drain Run (issue 139, ADR-0001
 * amendment). Where a Pane is an interactive xterm you talk to, a Feed is a
 * status strip you *watch*: it shows the Run's status and elapsed time and —
 * by construction — has no input surface, so a headless Run that cannot hear
 * you can never be typed into (glossary: you watch a Feed, you talk to a Pane).
 *
 * It spawns the same way a Pane does (over the IPC Contract), but main routes a
 * `headless` Run to the child-process manager (`claude -p --output-format
 * stream-json`, no pty). Exit arrives on the shared PtyExit channel; the claude
 * session id arrives on RunSessionCaptured and is reported up for persistence.
 * The raw stream never reaches here — it is buffered in main for peek/debug only
 * (ADR-0013). The elapsed clock is a renderer-side timer feeding the pure
 * `deriveFeedState`/`formatElapsed` helpers.
 *
 * The live CONTENT (issue 140) — a derived activity line, the last assistant
 * message, and the terminal result — arrives already folded on RunFeedUpdate:
 * main reduces the event stream (via the pure `headless-feed` reducer) and
 * pushes snapshots here. This component NEVER parses an event; it self-filters
 * updates by its own spawn session id and renders the snapshot. It remains, by
 * construction, read-only: no input surface, no cursor (glossary AC3).
 */
export function RunFeed({
  run,
  status,
  stopSignal,
  onSession,
  onClaudeSession,
  onExit,
  onStatusChange,
}: RunFeedProps): JSX.Element {
  const sessionIdRef = useRef<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [exited, setExited] = useState<boolean>(false);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [content, setContent] = useState<FeedContent>(EMPTY_FEED_CONTENT);

  // Latest callbacks via refs so the spawn effect keys only on the Run target
  // (a fresh callback each render must not tear down and respawn the process).
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const onClaudeSessionRef = useRef(onClaudeSession);
  onClaudeSessionRef.current = onClaudeSession;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const runId = run.issueId;
  const runPath = run.projectPath;

  useEffect(() => {
    let sessionId: string | null = null;
    let disposed = false;

    const offExit = window.mc.onPtyExit((msg) => {
      if (msg.sessionId !== sessionId) return;
      setExited(true);
      onStatusChangeRef.current?.(`exited (${msg.exitCode})`);
      onExitRef.current?.(msg.exitCode, msg.cause);
    });
    const offCaptured = window.mc.onRunSessionCaptured((msg) => {
      if (msg.sessionId !== sessionId) return;
      setClaudeSessionId(msg.claudeSessionId);
      onClaudeSessionRef.current?.(msg.claudeSessionId);
    });
    // The folded Feed content (issue 140): main pushes a fresh snapshot whenever
    // the activity line, last message, or terminal result changes. Self-filter by
    // this spawn's internal session id — the raw stream is never parsed here.
    const offFeed = window.mc.onRunFeedUpdate((msg) => {
      if (msg.sessionId !== sessionId) return;
      setContent(msg.content);
    });

    // cols/rows are irrelevant to a headless child (no TTY) but the request
    // shape requires them; the manager ignores them.
    void window.mc
      .spawnPty({ cols: 80, rows: 24, run })
      .then((res) => {
        if (disposed) {
          window.mc.killPty({ sessionId: res.sessionId });
          return;
        }
        sessionId = res.sessionId;
        sessionIdRef.current = res.sessionId;
        setStartedAt(Date.now());
        onSessionRef.current?.(res.sessionId);
        onStatusChangeRef.current?.(`running (${res.file})`);
      })
      .catch((err: unknown) => {
        setExited(true);
        onStatusChangeRef.current?.(`failed: ${String(err)}`);
      });

    return () => {
      disposed = true;
      offExit();
      offCaptured();
      offFeed();
      if (sessionId) window.mc.killPty({ sessionId });
      sessionIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, runPath]);

  // Tick the elapsed clock once a second while the process is live.
  useEffect(() => {
    if (exited || startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [exited, startedAt]);

  // Stop the Run on demand: kill the child process (Pane parity).
  useEffect(() => {
    if (!stopSignal) return;
    const id = sessionIdRef.current;
    if (id) window.mc.killPty({ sessionId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSignal]);

  const feed = deriveFeedState({ startedAt, now, exited, sessionId: claudeSessionId, content });
  const label = feed.status === 'starting' ? 'starting…' : status;

  // While the Run is live, the activity line is what it is DOING right now; once
  // it exits, the terminal result supersedes it (a stale "editing …" would lie).
  const showActivity = feed.activity !== null && feed.status !== 'exited';
  const result = feed.result;

  return (
    <div className="run-feed" role="status" aria-live="polite">
      <div className="run-feed__line">
        <span className={`run-feed__status run-feed__status--${status}`}>{label}</span>
        <span className="run-feed__elapsed">{formatElapsed(feed.elapsedMs)}</span>
      </div>
      <div className="run-feed__meta">
        <span className="run-feed__badge">headless</span>
        <span className="run-feed__hint">
          Watching a headless Run — there is no terminal to type into.
        </span>
      </div>
      {showActivity && (
        <div className="run-feed__activity" title={feed.activity ?? undefined}>
          <span className="run-feed__activity-spinner" aria-hidden="true" />
          <span className="run-feed__activity-text">{feed.activity}</span>
        </div>
      )}
      {feed.lastMessage !== null && (
        <p className="run-feed__message">{feed.lastMessage}</p>
      )}
      {result !== null && (
        <div
          className={`run-feed__result run-feed__result--${result.isError ? 'error' : 'ok'}`}
        >
          {result.isError ? '✕' : '✓'} {result.subtype ?? (result.isError ? 'error' : 'done')}
        </div>
      )}
      {claudeSessionId !== null && (
        <div className="run-feed__session" title="claude session id — for resume / take over">
          session <code>{claudeSessionId}</code>
        </div>
      )}
    </div>
  );
}
