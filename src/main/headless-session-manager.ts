/**
 * Headless Session Manager (adapter) — the ONLY place a drain Run's plain child
 * process is spawned (issue 139, ADR-0001 amendment). The interactive Pane's
 * counterpart is the PTY Session Manager; this one runs `claude -p
 * --output-format stream-json --verbose` as a plain `child_process` (NO pty),
 * because a drain Run is watched through a read-only Feed, never talked to.
 *
 * It captures the claude **session id** from the stream (the pure
 * `headless-feed` parser), tail-buffers the raw stream for human peek/debug ONLY
 * (never a capture input — ADR-0013: Receipts remain the sole capture), and
 * reports exit. Like the PTY manager it is a thin I/O edge, verified by the e2e
 * harness (`headless-run.e2e.test.ts`, which drives it against a real child
 * process via the command-override seam) and type-check, not unit tests — the
 * decisions it consumes (command resolution, stream parse, spawn env) live in
 * pure modules that ARE unit-tested.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveHeadlessRunCommand } from './resolve-run-command';
import { buildWorkerSpawnEnv } from './spawn-env';
import {
  createHeadlessStreamParser,
  reduceFeedContent,
  EMPTY_FEED_CONTENT,
  type HeadlessStreamParser,
  type HeadlessEvent,
  type FeedContent,
} from '../shared/headless-feed';
import type { SpawnContext } from './pty-session-manager';
import type {
  PtyDataMessage,
  PtyExitMessage,
  PtySpawnRequest,
  PtySpawnResult,
  RunSessionCapturedMessage,
  RunFeedUpdateMessage,
  SessionId,
} from '../shared/ipc-contract';

interface HeadlessSession {
  proc: ChildProcessWithoutNullStreams;
  parser: HeadlessStreamParser;
  /** Whether the captured session id has already been reported once. */
  captured: boolean;
  /**
   * The Feed content folded from this Run's stream so far (issue 140). Events
   * are reduced HERE, in main; the renderer receives snapshots and never parses.
   */
  content: FeedContent;
  /**
   * The armed `run_timeout` kill timer (issue 141), or null when this Run
   * carries no timeout (no `runTimeoutMs`, or a manual/interactive spawn).
   * Cleared on any exit path (timeout fire, normal close, manual kill) so it
   * never fires twice or outlives the process.
   */
  timeoutTimer: NodeJS.Timeout | null;
  /**
   * True once the timeout timer has fired and killed this session (issue
   * 141) — distinguishes a policy-driven kill from the Worker's own non-zero
   * crash exit, so the exit report can name the cause.
   */
  timedOut: boolean;
}

export interface HeadlessSessionManagerCallbacks {
  /**
   * Raw stream chunks, for a caller that wants to observe them. Mission Control
   * does NOT wire this to the renderer — the raw stream stays in main (peek via
   * `getRunOutput`); a headless Run's Feed shows folded content, not raw bytes.
   */
  onData?: (msg: PtyDataMessage) => void;
  onExit: (msg: PtyExitMessage) => void;
  /** Fired once per Run when its claude session id is parsed from the stream. */
  onSessionCaptured: (msg: RunSessionCapturedMessage) => void;
  /**
   * Fired whenever a Run's folded Feed content changes (issue 140) — the
   * activity line, last assistant message, or terminal result. Mission Control
   * broadcasts it to the renderer, whose Feed renders the snapshot directly.
   */
  onFeedUpdate?: (msg: RunFeedUpdateMessage) => void;
}

// Tail-truncate the raw stream at this many chars — same bound as the PTY tail
// buffer; keeps the most recent activity for a peek while bounding memory.
const MAX_RUN_OUTPUT = 500_000;

export class HeadlessSessionManager {
  private readonly sessions = new Map<SessionId, HeadlessSession>();
  // Buffered raw stream per Run, retained for HUMAN peek/debug ONLY (ADR-0013).
  // Never parsed into a Completion record; Receipts are the sole capture input.
  // Kept after the process exits so a post-mortem peek is possible.
  private readonly runOutput = new Map<SessionId, string>();

  constructor(private readonly callbacks: HeadlessSessionManagerCallbacks) {}

  /**
   * Spawn a headless drain Run. `req.run` must be present (headless is only ever
   * a Run); the same Worker seed as an interactive Run is built via
   * `resolveHeadlessRunCommand` (which reuses `buildRunPrompt` — skill
   * instructions, CORE.md injection, explicit Receipt path all unchanged).
   */
  spawn(req: PtySpawnRequest, context: SpawnContext = {}): PtySpawnResult {
    if (!req.run) {
      throw new Error('HeadlessSessionManager.spawn requires a Run target');
    }
    const { file, args } = resolveHeadlessRunCommand(
      process.env,
      {
        id: req.run.issueId,
        fileName: req.run.issueFileName,
        title: req.run.issueTitle,
        // The Run's RESOLVED cwd (the issue's target repo for a workbench Project),
        // from which the prompt spells out the absolute Receipt path (issue 62).
        cwd: req.run.projectPath,
        workbench: req.run.workbench ?? null,
        memoryCore: context.memoryCore ?? null,
      },
      // The declared drain-worker tier + effort (issues 154/155): a headless Run
      // is always a drain Run, so `--model <id>` and `--effort <level>` are
      // injected when the drain set them.
      { model: req.run.model ?? null, effort: req.run.effort ?? null },
    );
    const cwd = req.run.projectPath || process.env.HOME || process.cwd();
    const sessionId = randomUUID();

    const proc = spawn(file, args, {
      cwd,
      // A Worker inherits MC's env with NODE_ENV forced to `development` (issue
      // 136) — identical to the PTY Run path, so a headless Worker's installs
      // don't prune the devDeps its toolchain needs.
      env: buildWorkerSpawnEnv(process.env) as NodeJS.ProcessEnv,
    }) as ChildProcessWithoutNullStreams;

    const parser = createHeadlessStreamParser();
    const session: HeadlessSession = {
      proc,
      parser,
      captured: false,
      content: EMPTY_FEED_CONTENT,
      timeoutTimer: null,
      timedOut: false,
    };
    this.sessions.set(sessionId, session);
    this.runOutput.set(sessionId, '');

    // Run timeout (issue 141): a headless Run is watched, never talked to, so
    // nothing else stops it hanging forever. `runTimeoutMs` is the resolved
    // CONFIG `run_timeout` (default 30 min, `run-timeout.ts`); when the caller
    // set one, arm a real kill timer HERE — the Headless Session Manager is
    // the thing that executes the kill on breach, not a policy decision. The
    // exit report names the cause so the no-Receipt handling can distinguish
    // a timeout kill from the Worker's own crash.
    const runTimeoutMs = req.run.runTimeoutMs;
    if (typeof runTimeoutMs === 'number' && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        session.timedOut = true;
        proc.kill();
      }, runTimeoutMs);
    }

    // The prompt rides argv (not stdin); close stdin so `claude -p` doesn't wait
    // on it and exits cleanly after its final result event.
    proc.stdin.end();
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const ingest = (data: string): void => {
      this.append(sessionId, data);
      // Fold every completed event into the Feed content HERE (issue 140), so
      // the renderer only ever consumes a reduced snapshot — never an event.
      this.foldEvents(sessionId, session, parser.push(data));
      this.reportSessionId(sessionId, session);
      this.callbacks.onData?.({ sessionId, data });
    };
    proc.stdout.on('data', ingest);
    // stderr is buffered into the same peek tail but never parsed for events.
    proc.stderr.on('data', (data: string) => {
      this.append(sessionId, data);
      this.callbacks.onData?.({ sessionId, data });
    });

    proc.on('error', () => {
      // The executable could not be spawned (e.g. `claude` not on PATH). Report a
      // non-zero exit so the Run lands in the no-Receipt path rather than hanging.
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
      if (this.sessions.delete(sessionId)) {
        this.callbacks.onExit({ sessionId, exitCode: 127, cause: 'crashed' });
      }
    });

    proc.on('close', (code, signal) => {
      // Flush any trailing partial line, folding a late-arriving result event
      // (and capturing a late-arriving session id) before the Run is torn down.
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
      this.foldEvents(sessionId, session, parser.flush());
      this.reportSessionId(sessionId, session);
      this.sessions.delete(sessionId);
      const exitCode = typeof code === 'number' ? code : signal ? 128 : 1;
      // `timedOut` wins (a policy-driven kill, even if the process happened to
      // exit non-zero from the SIGTERM); otherwise a non-zero exit is the
      // Worker's own crash; a clean 0 exit carries no cause (issue 141).
      const cause: 'timeout' | 'crashed' | undefined = session.timedOut
        ? 'timeout'
        : exitCode !== 0
          ? 'crashed'
          : undefined;
      this.callbacks.onExit({ sessionId, exitCode, cause });
    });

    return { sessionId, file };
  }

  /**
   * Fold newly-parsed events into the Run's Feed content and, when the content
   * actually changed, push the snapshot (issue 140). The pure reducer returns
   * the SAME reference on a no-op event, so `!==` is a cheap change test — a
   * quiet stream (system pings, tool results) broadcasts nothing.
   */
  private foldEvents(
    sessionId: SessionId,
    session: HeadlessSession,
    events: readonly HeadlessEvent[],
  ): void {
    let changed = false;
    for (const event of events) {
      const next = reduceFeedContent(session.content, event);
      if (next !== session.content) {
        session.content = next;
        changed = true;
      }
    }
    if (changed) this.callbacks.onFeedUpdate?.({ sessionId, content: session.content });
  }

  /** Report the captured claude session id exactly once for this Run. */
  private reportSessionId(sessionId: SessionId, session: HeadlessSession): void {
    if (session.captured) return;
    const claudeSessionId = session.parser.sessionId();
    if (claudeSessionId === null) return;
    session.captured = true;
    this.callbacks.onSessionCaptured({ sessionId, claudeSessionId });
  }

  private append(sessionId: SessionId, data: string): void {
    const next = (this.runOutput.get(sessionId) ?? '') + data;
    this.runOutput.set(
      sessionId,
      next.length > MAX_RUN_OUTPUT ? next.slice(next.length - MAX_RUN_OUTPUT) : next,
    );
  }

  /**
   * The buffered raw stream of a headless Run — a PEEK/DEBUG surface only
   * (ADR-0013). Never fed to a parser/classifier or the Dispatcher feed. Empty
   * for an unknown session. The buffer outlives the process for a post-mortem.
   */
  getRunOutput(sessionId: SessionId): string {
    return this.runOutput.get(sessionId) ?? '';
  }

  kill(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    session.proc.kill();
    this.sessions.delete(sessionId);
  }

  killAll(): void {
    for (const { proc, timeoutTimer } of this.sessions.values()) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      proc.kill();
    }
    this.sessions.clear();
  }
}
