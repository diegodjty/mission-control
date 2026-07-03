/**
 * PTY Session Manager (adapter) — the ONLY place node-pty is touched.
 *
 * Spawns/kills interactive processes and pipes their bytes. Lives in the main
 * process; the renderer reaches it only over the IPC Contract. Verified by
 * manual/integration runs (it is a thin I/O edge), not unit tests.
 */
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { resolveShell } from './resolve-shell';
import { resolveRunCommand } from './resolve-run-command';
import { resolveDispatcherCommand } from './dispatcher-session';
import type {
  PtyDataMessage,
  PtyExitMessage,
  PtySpawnRequest,
  PtySpawnResult,
  SessionId,
} from '../shared/ipc-contract';

interface Session {
  proc: pty.IPty;
}

export interface PtySessionManagerCallbacks {
  onData: (msg: PtyDataMessage) => void;
  onExit: (msg: PtyExitMessage) => void;
}

// Keep at most this many trailing chars of a Run's output. Tail-truncating
// (drop from the front) keeps the most recent activity while bounding memory
// over a long session.
const MAX_RUN_OUTPUT = 500_000;

export class PtySessionManager {
  private readonly sessions = new Map<SessionId, Session>();
  // Buffered output for Run sessions only — retained for HUMAN peek/debug ONLY
  // (issue 57, ADR-0013). It is never an input to any classifier, status model,
  // or the Dispatcher feed: Receipts (`issues/completions/`) are the sole
  // capture input. Kept after the session exits so a post-mortem peek is
  // possible; a plain shell Pane never buffers.
  private readonly runOutput = new Map<SessionId, string>();

  constructor(private readonly callbacks: PtySessionManagerCallbacks) {}

  spawn(req: PtySpawnRequest): PtySpawnResult {
    // A Run spawns a fresh interactive `claude` scoped to one issue, in the
    // Project repo (solo mode → directly on `main`, no worktree). A Dispatcher
    // spawns the conversational orchestrator `claude` for a drain, in the
    // Project repo (issue 35). A plain Pane spawns the walking-skeleton shell in
    // $HOME (issue 01).
    const { file, args } = req.run
      ? resolveRunCommand(process.env, {
          id: req.run.issueId,
          fileName: req.run.issueFileName,
          title: req.run.issueTitle,
          // The Run's RESOLVED cwd (worktree in parallel mode, repo in solo) —
          // the prompt spells out the absolute per-Run Receipt path from it
          // (issue 62), so a Worker's cwd confusion can't misplace the write.
          cwd: req.run.projectPath,
        })
      : req.dispatcher
        ? resolveDispatcherCommand(process.env, {
            projectPath: req.dispatcher.projectPath,
            activePrd: req.dispatcher.activePrd,
          })
        : resolveShell(process.env, process.platform);
    const cwd =
      req.run?.projectPath ||
      req.dispatcher?.projectPath ||
      process.env.HOME ||
      process.cwd();
    const sessionId = randomUUID();
    const isRun = Boolean(req.run);
    if (isRun) this.runOutput.set(sessionId, '');

    const proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: Math.max(1, req.cols || 80),
      rows: Math.max(1, req.rows || 24),
      cwd,
      env: process.env as Record<string, string>,
    });

    proc.onData((data) => {
      if (isRun) {
        const next = (this.runOutput.get(sessionId) ?? '') + data;
        this.runOutput.set(
          sessionId,
          next.length > MAX_RUN_OUTPUT ? next.slice(next.length - MAX_RUN_OUTPUT) : next,
        );
      }
      this.callbacks.onData({ sessionId, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.callbacks.onExit({ sessionId, exitCode, signal });
    });

    this.sessions.set(sessionId, { proc });
    return { sessionId, file };
  }

  /**
   * The buffered tail of a Run session's output — a PEEK/DEBUG surface only
   * (issue 57, ADR-0013). It must never be fed to a parser/classifier, the
   * status model, or the Dispatcher feed; Receipts are the sole capture input.
   * Empty string for an unknown/non-Run session. The buffer outlives the
   * session so a post-mortem peek is possible.
   */
  getRunOutput(sessionId: SessionId): string {
    return this.runOutput.get(sessionId) ?? '';
  }

  write(sessionId: SessionId, data: string): void {
    this.sessions.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: SessionId, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.proc.resize(Math.max(1, cols), Math.max(1, rows));
  }

  kill(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.proc.kill();
    this.sessions.delete(sessionId);
  }

  killAll(): void {
    for (const { proc } of this.sessions.values()) {
      proc.kill();
    }
    this.sessions.clear();
  }
}
