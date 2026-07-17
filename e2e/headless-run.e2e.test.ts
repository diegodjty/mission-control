/**
 * E2E headless Run tracer (issue 139, ADR-0001 amendment) — a drain Run
 * executes through the HEADLESS child-process seam and completes, watched by a
 * minimal Feed.
 *
 * The seam under test is the same command-override (`MC_RUN_CMD`) the drain
 * harness already rides, but routed to the new `HeadlessSessionManager`, which
 * spawns a plain child process (`claude -p --output-format stream-json`, NO
 * pty) instead of an interactive pty. This suite drives that REAL adapter
 * against a REAL child process (`fake-headless-claude.mjs` — a scripted
 * stream-json Worker, no LLM) plus the REAL ReceiptWatcher and backlog reader,
 * exactly as `shell-keep-mounted` drives the real PtySessionManager:
 *
 *   - the claude session id is CAPTURED from the stream and reported once
 *     (AC3 — the "captured from the stream" half; persistence onto the React
 *     Run record is UI, declared manual-only below),
 *   - the raw stream is TAIL-BUFFERED for peek/debug and never parsed for
 *     capture (AC5, ADR-0013 untouched),
 *   - the on-disk work is unchanged in shape — claim flip → `done`, deliverable,
 *     Receipt — so the REAL watcher ingests it and the drain proceeds (AC1),
 *   - a park/blocked headless Worker flows through the SAME seam unchanged.
 *
 * The renderer halves (the Feed strip; a manual Run still opening an interactive
 * Pane) need the live Electron shell and are declared `manual-only` at the
 * bottom — zero silent gaps. Run this with `npm run test:e2e` before any QA.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HeadlessSessionManager } from '../src/main/headless-session-manager';
import { ReceiptWatcher } from '../src/main/receipt-watcher';
import { readBacklog } from '../src/main/backlog-reader';
import { parseReceipt } from '../src/shared/receipt-parser';
import { deriveRunStatus } from '../src/shared/run-state';
import { planDrain, type ActiveRun } from '../src/shared/run-coordinator';
import { deriveAttention } from '../src/shared/attention-hub-model';
import type {
  PtyExitMessage,
  RunLogRecord,
  RunSessionCapturedMessage,
  RunFeedUpdateMessage,
} from '../src/shared/ipc-contract';
import { seedSandbox, sandboxIssue, waitFor, type Sandbox } from './sandbox';

const FAKE = join(process.cwd(), 'e2e', 'fake-headless-claude.mjs');

let sandbox: Sandbox;
let repo: string;
let manager: HeadlessSessionManager | null;
let watcher: ReceiptWatcher | null;

// The env vars the fake Worker reads; every one set is restored in afterEach so
// a spawn's config never leaks into another test (or the parent process).
const FAKE_ENV_KEYS = [
  'MC_RUN_CMD',
  'MC_FAKE_SESSION_ID',
  'MC_FAKE_ISSUE_FILE',
  'MC_FAKE_RECEIPT_PATH',
  'MC_FAKE_DELIVERABLE',
  'MC_FAKE_SLUG',
  'MC_FAKE_ID',
  'MC_FAKE_FINISHED',
  'MC_FAKE_OUTCOME',
  'MC_FAKE_NO_RECEIPT',
  'MC_FAKE_DENIED_ACTION',
];
let savedEnv: Record<string, string | undefined>;

/** Configure the fake headless Worker for one issue via the command-override seam. */
function configureFakeWorker(opts: {
  sessionId: string;
  slug: string;
  id: number;
  finished: string;
  outcome?: 'completed' | 'blocked' | 'needs-verification';
  /** issue 142: with outcome=blocked, the action whose denial parked the Worker. */
  deniedAction?: string;
}): void {
  process.env.MC_RUN_CMD = `node ${FAKE}`;
  process.env.MC_FAKE_SESSION_ID = opts.sessionId;
  process.env.MC_FAKE_ISSUE_FILE = join(repo, 'issues', `${opts.slug}.md`);
  process.env.MC_FAKE_RECEIPT_PATH = join(repo, 'issues', 'completions', `${opts.slug}.md`);
  process.env.MC_FAKE_DELIVERABLE = join(repo, 'work', `${opts.slug}.txt`);
  process.env.MC_FAKE_SLUG = opts.slug;
  process.env.MC_FAKE_ID = String(opts.id);
  process.env.MC_FAKE_FINISHED = opts.finished;
  process.env.MC_FAKE_OUTCOME = opts.outcome ?? 'completed';
  if (opts.deniedAction) process.env.MC_FAKE_DENIED_ACTION = opts.deniedAction;
}

/** The RunTarget a workbench-less (legacy layout) drain Run carries, headless. */
function headlessRunTarget(id: number) {
  const issue = sandboxIssue(id);
  return {
    issueId: id,
    issueFileName: `${issue.slug}.md`,
    issueTitle: issue.title,
    projectPath: repo,
    workbench: null,
    headless: true,
  };
}

beforeEach(async () => {
  sandbox = await seedSandbox();
  repo = sandbox.repo;
  manager = null;
  watcher = null;
  savedEnv = {};
  for (const k of FAKE_ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(async () => {
  manager?.killAll();
  watcher?.closeAll();
  for (const k of FAKE_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(sandbox.scratch, { recursive: true, force: true });
});

describe('headless Run tracer (issue 139) — real child process, real modules', () => {
  it('the fake headless Worker script exists where the seam expects it', () => {
    expect(existsSync(FAKE)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC1 + AC3 + AC5 — a headless drain Run executes `claude -p` through the
  // child-process seam, its session id is captured from the stream, its raw
  // stream is retained for peek/debug, and its Receipt/flip land unchanged in
  // shape so the REAL watcher ingests it and the drain proceeds.
  // ---------------------------------------------------------------------------
  it('spawns a plain child process, captures the session id from the stream, and completes', async () => {
    const issue = sandboxIssue(2);
    const finished = '2026-07-17T12:00:00.000Z';
    configureFakeWorker({ sessionId: 'sess-headless-e2e', slug: issue.slug, id: 2, finished });

    const exits: PtyExitMessage[] = [];
    const captured: RunSessionCapturedMessage[] = [];
    manager = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: (msg) => captured.push(msg),
    });

    const spawn = manager.spawn({ cols: 80, rows: 24, run: headlessRunTarget(2) });
    // The executable is a plain child process (node running the fake), NOT a pty.
    expect(spawn.file).toBe('node');

    // The claude session id is captured from the stream and reported ONCE,
    // keyed to this spawn's internal session id (AC3, "captured from the stream").
    await waitFor(() => captured.length > 0, 'session id captured from the stream');
    expect(captured).toHaveLength(1);
    expect(captured[0].sessionId).toBe(spawn.sessionId);
    expect(captured[0].claudeSessionId).toBe('sess-headless-e2e');

    // The child exits cleanly (AC1 — the Run completes).
    await waitFor(() => exits.length > 0, 'headless child process exits');
    expect(exits[0].sessionId).toBe(spawn.sessionId);
    expect(exits[0].exitCode).toBe(0);

    // AC5 — the raw stream is tail-buffered for peek/debug (never parsed for
    // capture): the buffer holds the actual stream-json, session id and all.
    const tail = manager.getRunOutput(spawn.sessionId);
    expect(tail).toContain('"type":"system"');
    expect(tail).toContain('"session_id":"sess-headless-e2e"');
    expect(tail).toContain('"type":"result"');

    // AC1 — the on-disk work is unchanged in shape: the issue flipped `done`…
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 2)?.status).toBe('done');
    expect(existsSync(join(repo, 'work', `${issue.slug}.txt`))).toBe(true);

    // …and the Receipt landed and parses as a DECLARED `completed` outcome,
    // exactly like a Pane Worker's (drain-harness scenario 1's contract).
    const receiptFile = join(repo, 'issues', 'completions', `${issue.slug}.md`);
    expect(existsSync(receiptFile)).toBe(true);
    const parsed = parseReceipt(await readFile(receiptFile, 'utf8'));
    expect(parsed.outcome).toBe('completed');
    expect(parsed.outcomeSource).toBe('declared');

    // The REAL ReceiptWatcher ingests it (the drain proceeds exactly as today):
    // one classified Run-log record for this issue, keyed by the ADR-0013 identity.
    const records: RunLogRecord[] = [];
    watcher = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    watcher.watch('project', [sandbox.issuesDir], new Map(), (r) => records.push(r));
    await waitFor(() => records.some((r) => r.issueId === 2), 'watcher ingests the headless Receipt');
    const record = records.find((r) => r.issueId === 2)!;
    expect(record.outcome).toBe('completed');
    expect(record.id).toBe(`receipt:${issue.slug}:${finished}`);
    expect(record.whatChanged).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Issue 140 AC2 (main-side) — the event stream is FOLDED in main (via the pure
  // reducer) into Feed content and pushed on RunFeedUpdate: a live activity line
  // from a tool event, the last assistant message, and the terminal result with
  // its usage payload intact. The renderer consumes these snapshots and never
  // parses an event; the DOM render itself needs Electron (declared manual-only).
  // ---------------------------------------------------------------------------
  it('folds the stream into Feed content (activity, last message, result+usage) and pushes it', async () => {
    const issue = sandboxIssue(2);
    const finished = '2026-07-17T12:00:00.000Z';
    configureFakeWorker({ sessionId: 'sess-headless-feed', slug: issue.slug, id: 2, finished });

    const exits: PtyExitMessage[] = [];
    const updates: RunFeedUpdateMessage[] = [];
    manager = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: () => {},
      onFeedUpdate: (msg) => updates.push(msg),
    });
    const spawn = manager.spawn({ cols: 80, rows: 24, run: headlessRunTarget(2) });

    // Content updates are broadcast, keyed to this spawn's internal session id.
    await waitFor(() => updates.length > 0, 'Feed content pushed');
    expect(updates.every((u) => u.sessionId === spawn.sessionId)).toBe(true);

    await waitFor(() => exits.length > 0, 'headless child exits');

    // The final folded snapshot carries every content field the Feed renders.
    const finalContent = updates[updates.length - 1].content;
    // Activity line derived from the Bash tool_use turn ("running npm test").
    expect(finalContent.activity).toBe('running npm test');
    expect(finalContent.activityTool).toBe('Bash');
    // Last assistant prose survived the later tool-only turn (never blanked).
    expect(finalContent.lastMessage).toBe(`Working ${issue.slug}…`);
    // Terminal result extracted, `usage` intact VERBATIM (issue 143 consumes it).
    expect(finalContent.result?.subtype).toBe('success');
    expect(finalContent.result?.isError).toBe(false);
    expect(finalContent.result?.usage).toEqual({ input_tokens: 1200, output_tokens: 340 });
  });

  // ---------------------------------------------------------------------------
  // AC1 (park path) — a headless Worker that PARKS flows through the same seam
  // unchanged: the session id is still captured, the issue stays `wip`, and the
  // Receipt declares `needs-verification` (the drain would park it, not halt).
  // ---------------------------------------------------------------------------
  it('a parking headless Worker is captured the same way and leaves a needs-verification Receipt', async () => {
    const issue = sandboxIssue(5); // the HITL issue
    const finished = '2026-07-17T13:00:00.000Z';
    configureFakeWorker({
      sessionId: 'sess-headless-park',
      slug: issue.slug,
      id: 5,
      finished,
      outcome: 'needs-verification',
    });

    const exits: PtyExitMessage[] = [];
    const captured: RunSessionCapturedMessage[] = [];
    manager = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: (msg) => captured.push(msg),
    });
    manager.spawn({ cols: 80, rows: 24, run: headlessRunTarget(5) });

    await waitFor(() => captured.length > 0, 'park session id captured');
    expect(captured[0].claudeSessionId).toBe('sess-headless-park');
    await waitFor(() => exits.length > 0, 'park child exits');
    expect(exits[0].exitCode).toBe(0);

    // The park leaves the claim `wip` (awaiting the human), not `done`.
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 5)?.status).toBe('wip');

    const receiptFile = join(repo, 'issues', 'completions', `${issue.slug}.md`);
    const parsed = parseReceipt(await readFile(receiptFile, 'utf8'));
    expect(parsed.outcome).toBe('needs-verification');
    expect(parsed.outcomeSource).toBe('declared');
  });

  // ---------------------------------------------------------------------------
  // Issue 142 (consumer half) — a headless Worker that hits a PERMISSION DENIAL
  // parks `blocked` through the SAME seam: it names the denied action in its
  // Receipt, the Run reads `blocked`, an attention item is raised carrying the
  // denial, and the drain NEVER retries the denied issue. In THIS worktree issue
  // 137's continue-past-blocked change is not landed (its code is on the unmerged
  // `afk/137-…` branch), so the drain conservatively STOPS on the blocked Run —
  // issue 142's "conservative stop until then". Under either rule the denied
  // issue is off the table (it already has a Run), so no retry is scheduled.
  // ---------------------------------------------------------------------------
  it('a denial-blocked headless Worker parks blocked: Receipt names the denial, attention raised, never retried', async () => {
    const issue = sandboxIssue(2); // independent, non-HITL — the first drainable issue
    const finished = '2026-07-17T14:00:00.000Z';
    const deniedAction = 'git push';
    configureFakeWorker({
      sessionId: 'sess-headless-denied',
      slug: issue.slug,
      id: 2,
      finished,
      outcome: 'blocked',
      deniedAction,
    });

    const exits: PtyExitMessage[] = [];
    const captured: RunSessionCapturedMessage[] = [];
    manager = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: (msg) => captured.push(msg),
    });
    manager.spawn({ cols: 80, rows: 24, run: headlessRunTarget(2) });

    // Same headless seam: the session id is captured and the child exits CLEAN —
    // a denial is a Worker DECISION to park, not a crash (exit 0), and there is
    // exactly ONE process: no retry-loop against the denial at the process level.
    await waitFor(() => captured.length > 0, 'denied-run session id captured');
    expect(captured[0].claudeSessionId).toBe('sess-headless-denied');
    await waitFor(() => exits.length > 0, 'denied headless child exits');
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(0);

    // The park leaves the claim `wip` — a denial builds nothing and flips nothing.
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 2)?.status).toBe('wip');
    expect(existsSync(join(repo, 'work', `${issue.slug}.txt`))).toBe(false);

    // The Receipt DECLARES blocked and NAMES the denied action in its body.
    const receiptFile = join(repo, 'issues', 'completions', `${issue.slug}.md`);
    const raw = await readFile(receiptFile, 'utf8');
    const parsed = parseReceipt(raw);
    expect(parsed.outcome).toBe('blocked');
    expect(parsed.outcomeSource).toBe('declared');
    expect(raw).toContain(deniedAction);
    expect(parsed.detail).toContain(deniedAction);

    // The REAL watcher ingests it as one blocked record (the drain's input).
    const records: RunLogRecord[] = [];
    watcher = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    watcher.watch('project', [sandbox.issuesDir], new Map(), (r) => records.push(r));
    await waitFor(() => records.some((r) => r.issueId === 2), 'watcher ingests the denied Receipt');
    const record = records.find((r) => r.issueId === 2)!;
    expect(record.outcome).toBe('blocked');

    // Consumer 1 — the Run parks BLOCKED (the standard blocked handling; the
    // declared Receipt ends it without waiting for a session death).
    const status = deriveRunStatus({
      sessionAlive: false,
      stoppedByUser: false,
      issueStatus: backlog.issues.find((i) => i.id === 2)?.status ?? null,
      receiptOutcome: record.outcome,
    });
    expect(status).toBe('blocked');

    // Consumer 2 — a `blocked-run` attention item is raised, its text carrying
    // the denied action (so the human reads exactly what to grant).
    const attention = deriveAttention({
      project: 'sandbox',
      backlog,
      receipts: [parsed],
      coreProposedPresent: false,
      humanSetup: null,
      journal: [],
      lastSeen: null,
    });
    const blockedItem = attention.items.find((i) => i.kind === 'blocked-run' && i.issueId === 2);
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.text).toContain(deniedAction);

    // Consumer 3 — the drain does NOT retry the denial. The blocked issue already
    // has a Run, so the coordinator excludes it from BOTH startable and queued
    // (true under conservative-stop AND under issue 137's continue-past rules).
    const activeRuns: ActiveRun[] = [{ issueId: 2, status, receiptOutcome: record.outcome }];
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns });
    expect(plan.drain.stop).toBe(true); // conservative stop (137 unmerged here)
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(2);
    expect(plan.startable).not.toContain(2);
    expect(plan.queued).not.toContain(2);

    // Idempotent re-plan — re-observing the same blocked Run schedules no retry.
    const replan = planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns });
    expect(replan.startable).toEqual(plan.startable);
    expect(replan.startable).not.toContain(2);

    // Process-level: still exactly one child was ever spawned for this issue.
    expect(exits).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Manual-only (need the live Electron shell / a real `claude` binary): named,
  // never silently skipped.
  // ---------------------------------------------------------------------------
  it.skip('manual-only: a drain Run renders the Feed strip (activity + elapsed + last message), not an xterm, with no input surface (issue 139 AC2 / issue 140 AC2 — the DOM render; the fold is covered above)', () => {});
  it.skip('manual-only: a manual single Run still opens an interactive Pane — no regression (AC4)', () => {});
  it.skip('manual-only: the real `claude -p --output-format stream-json --verbose` binary streams a system/init session_id', () => {});
});
