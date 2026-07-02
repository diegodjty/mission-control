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

export class PtySessionManager {
  private readonly sessions = new Map<SessionId, Session>();

  constructor(private readonly callbacks: PtySessionManagerCallbacks) {}

  spawn(req: PtySpawnRequest): PtySpawnResult {
    // A Run spawns a fresh interactive `claude` scoped to one issue, in the
    // Project repo (solo mode → directly on `main`, no worktree). A plain Pane
    // spawns the walking-skeleton shell in $HOME (issue 01).
    const { file, args } = req.run
      ? resolveRunCommand(process.env, {
          id: req.run.issueId,
          fileName: req.run.issueFileName,
          title: req.run.issueTitle,
        })
      : resolveShell(process.env, process.platform);
    const cwd = req.run?.projectPath || process.env.HOME || process.cwd();
    const sessionId = randomUUID();

    const proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: Math.max(1, req.cols || 80),
      rows: Math.max(1, req.rows || 24),
      cwd,
      env: process.env as Record<string, string>,
    });

    proc.onData((data) => {
      this.callbacks.onData({ sessionId, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.callbacks.onExit({ sessionId, exitCode, signal });
    });

    this.sessions.set(sessionId, { proc });
    return { sessionId, file };
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
