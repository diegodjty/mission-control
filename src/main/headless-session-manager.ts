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
    const { file, args } = resolveHeadlessRunCommand(process.env, {
      id: req.run.issueId,
      fileName: req.run.issueFileName,
      title: req.run.issueTitle,
      // The Run's RESOLVED cwd (the issue's target repo for a workbench Project),
      // from which the prompt spells out the absolute Receipt path (issue 62).
      cwd: req.run.projectPath,
      workbench: req.run.workbench ?? null,
      memoryCore: context.memoryCore ?? null,
    });
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
    };
    this.sessions.set(sessionId, session);
    this.runOutput.set(sessionId, '');

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
      if (this.sessions.delete(sessionId)) {
        this.callbacks.onExit({ sessionId, exitCode: 127 });
      }
    });

    proc.on('close', (code, signal) => {
      // Flush any trailing partial line, folding a late-arriving result event
      // (and capturing a late-arriving session id) before the Run is torn down.
      this.foldEvents(sessionId, session, parser.flush());
      this.reportSessionId(sessionId, session);
      this.sessions.delete(sessionId);
      const exitCode = typeof code === 'number' ? code : signal ? 128 : 1;
      this.callbacks.onExit({ sessionId, exitCode });
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
