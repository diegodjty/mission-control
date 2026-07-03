import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { RunTarget } from '../../shared/ipc-contract';

interface PaneProps {
  /**
   * When set, this Pane hosts a Run: a fresh interactive `claude`
   * afk-issue-runner session scoped to the issue, in the Project repo. When
   * unset, it hosts a plain walking-skeleton shell (issue 01).
   */
  run?: RunTarget;
  onStatusChange?: (status: string) => void;
  /** Fired when the underlying session exits (with its exit code). */
  onExit?: (exitCode: number) => void;
  /**
   * Fired with the PTY session id once this Pane's session is spawned (issue
   * 34), so the parent can capture the Run's Completion block from that session's
   * buffered output when the Run ends.
   */
  onSession?: (sessionId: string) => void;
  /**
   * Bump this number to stop the Run: the underlying session is killed. The
   * Pane stays mounted so its final output remains visible.
   */
  stopSignal?: number;
}

/**
 * One embedded interactive Pane: an xterm.js terminal wired to a main-process
 * PTY over the IPC Contract (`window.mc`). Keystrokes go out via writePty;
 * output comes back via onPtyData. A Run passes `run` so main spawns `claude`
 * scoped to the issue instead of a shell.
 */
export function Pane({ run, onStatusChange, onExit, onSession, stopSignal }: PaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Keep the latest onSession in a ref so the spawn effect (keyed on the Run
  // target) doesn't need it as a dependency and re-run when the parent re-renders.
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  // Primitive deps so the effect only re-runs when the actual Run target
  // changes, not on every parent render (run is a fresh object each time).
  const runId = run?.issueId ?? null;
  const runPath = run?.projectPath ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0f14', foreground: '#e6edf3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Fitting a zero-sized host (e.g. a tile currently hidden behind a
    // maximized sibling) throws; only reflow once the host actually has area.
    const safeFit = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    };
    safeFit();

    let sessionId: string | null = null;
    let disposed = false;

    const offData = window.mc.onPtyData((msg) => {
      if (msg.sessionId === sessionId) term.write(msg.data);
    });
    const offExit = window.mc.onPtyExit((msg) => {
      if (msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[90m[process exited: ${msg.exitCode}]\x1b[0m\r\n`);
        onStatusChange?.(`exited (${msg.exitCode})`);
        onExit?.(msg.exitCode);
      }
    });

    const inputDisposable = term.onData((data) => {
      if (sessionId) window.mc.writePty({ sessionId, data });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (sessionId) window.mc.resizePty({ sessionId, cols, rows });
    });

    void window.mc
      .spawnPty({ cols: term.cols, rows: term.rows, run })
      .then((res) => {
        if (disposed) {
          window.mc.killPty({ sessionId: res.sessionId });
          return;
        }
        sessionId = res.sessionId;
        sessionIdRef.current = res.sessionId;
        // Only Run sessions have a Completion block worth capturing (issue 34).
        if (run) onSessionRef.current?.(res.sessionId);
        onStatusChange?.(run ? `running (${res.file})` : `live (${res.file})`);
        term.focus();
      })
      .catch((err: unknown) => {
        term.write(`\r\n\x1b[31m[failed to start: ${String(err)}]\x1b[0m\r\n`);
        onStatusChange?.('failed');
      });

    const onWindowResize = (): void => safeFit();
    window.addEventListener('resize', onWindowResize);

    // Reflow when this Pane's own box changes size — the terminal now lives in
    // an adaptive tiled grid (issue 12), so its tile grows/shrinks as Runs come
    // and go and when it's maximized/restored, with no window-level resize.
    const resizeObserver = new ResizeObserver(() => safeFit());
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      resizeObserver.disconnect();
      offData();
      offExit();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (sessionId) window.mc.killPty({ sessionId });
      sessionIdRef.current = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, runPath]);

  // Stop the Run on demand: kill the live session but keep the Pane mounted so
  // its final output (e.g. the agent's blocked reason) stays on screen.
  useEffect(() => {
    if (!stopSignal) return;
    const id = sessionIdRef.current;
    if (id) window.mc.killPty({ sessionId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSignal]);

  return <div className="pane" ref={hostRef} />;
}
