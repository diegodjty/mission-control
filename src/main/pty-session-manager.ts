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
import {
  resolveRunCommand,
  resolveResumeRunCommand,
  resolveTalkCommand,
  type TalkWorkbenchDest,
} from './resolve-run-command';
import { resolveDispatcherCommand } from './dispatcher-session';
import { buildWorkerSpawnEnv } from './spawn-env';
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

/**
 * Edge-gathered facts a spawn's prompt needs but the renderer never holds:
 * the workbench project's `memory/CORE.md` content (issue 73), read by the
 * IPC handler in main. Absent/null for legacy spawns and plain shells.
 */
export interface SpawnContext {
  memoryCore?: string | null;
  /**
   * A Planning talk session's explicit Workbench artifact destination (issue
   * 101), derived at the IPC edge from the talk target. Null/absent for a plain
   * "Just talk" session and every non-talk spawn — the talk prompt then stays
   * byte-identical to before.
   */
  talkDest?: TalkWorkbenchDest | null;
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

  spawn(req: PtySpawnRequest, context: SpawnContext = {}): PtySpawnResult {
    // A Run spawns a fresh interactive `claude` scoped to one issue, in the
    // Project repo (solo mode → directly on `main`, no worktree). A Dispatcher
    // spawns the conversational orchestrator `claude` for a drain, in the
    // Project repo (issue 35). A plain Pane spawns the walking-skeleton shell in
    // $HOME (issue 01).
    const { file, args } = req.run
      ? req.run.resume
        ? // A TAKE-OVER / post-mortem RESUME (issue 144): re-attach interactively
          // to the session the headless Run captured, `claude --resume <id>`, in
          // the same cwd — no fresh Worker seed. Everything else about the Run
          // (issue, cwd, tracking) is unchanged; only the command differs. A
          // resume is interactive, so it carries no model/effort tiering.
          resolveResumeRunCommand(process.env, req.run.resume.claudeSessionId)
        : resolveRunCommand(process.env, {
            id: req.run.issueId,
            fileName: req.run.issueFileName,
            title: req.run.issueTitle,
            // The Run's RESOLVED cwd (worktree in parallel mode, repo in solo;
            // the issue's TARGET repo for a workbench Project, issue 72) — the
            // prompt spells out the absolute per-Run Receipt path from it
            // (issue 62), so a Worker's cwd confusion can't misplace the write.
            cwd: req.run.projectPath,
            // Workbench Runs carry the explicit workbench paths in the prompt
            // (ADR-0015's discovery order); absent = legacy, prompt unchanged.
            workbench: req.run.workbench ?? null,
            // A workbench project's CORE.md, read at the IPC edge (issue 73);
            // null for legacy Runs and memory-less projects — nothing injected.
            memoryCore: context.memoryCore ?? null,
          },
          // Model + effort tiering (issues 154/155) fires only when the caller
          // declared them. This interactive Pane path is manual Runs (headless
          // drain Runs route to the Headless Session Manager). `req.run.effort` is
          // always unset here (effort stays drain-only), and `req.run.model` is
          // unset UNLESS the human picked a non-default tier in the manual-Run
          // model picker (issue 203, the one interactive exception): the picker's
          // default carries no model, so a plain click-through stays byte-identical
          // to the un-tiered interactive default; a chosen tier injects `--model`.
          { model: req.run.model ?? null, effort: req.run.effort ?? null })
      : req.dispatcher
        ? resolveDispatcherCommand(process.env, {
            projectPath: req.dispatcher.projectPath,
            activePrd: req.dispatcher.activePrd,
            // Same CORE.md injection for the Dispatcher seed (issue 73).
            memoryCore: context.memoryCore ?? null,
          })
        : req.talk
          ? // A talk Pane: a warm `claude` session. Just-talk (issue 81) is
            // bare + CORE.md; a Planning session (issue 101) also carries the
            // Workbench artifact destination so /to-prd, /to-issues write there.
            resolveTalkCommand(process.env, context.memoryCore ?? null, context.talkDest ?? null)
          : resolveShell(process.env, process.platform);
    const cwd =
      req.run?.projectPath ||
      req.dispatcher?.projectPath ||
      req.talk?.cwd ||
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
      // A Worker (Run) is spawned with NODE_ENV forced to `development`
      // (issue 136): MC may run under NODE_ENV=production (a packaged build),
      // and a bare install a Worker still runs would otherwise prune the
      // devDeps its build/test toolchain lives in. Non-Worker sessions
      // (Dispatcher, talk, plain shell) keep the inherited env unchanged.
      env: (isRun
        ? buildWorkerSpawnEnv(process.env)
        : process.env) as Record<string, string>,
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
