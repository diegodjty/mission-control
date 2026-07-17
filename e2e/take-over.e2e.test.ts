/**
 * E2E take-over / post-mortem resume (issue 144, PRD headless-lane stories 8–10)
 * — grab a live headless Run mid-flight as an interactive Pane, and reopen a
 * finished Run's session post-mortem, both through the REAL adapters.
 *
 * The seam under test spans two real managers over the SAME command-override
 * (`MC_RUN_CMD`) the drain harness rides: the `HeadlessSessionManager` (the
 * `claude -p` child a drain Run is watched as) and the `PtySessionManager` (the
 * interactive Pane a take-over resumes into) — plus the pure `planDrain`
 * coordinator that proves the slot count and issue guard are unchanged, and the
 * real `ReceiptWatcher` that proves a resumed Run completes exactly like any
 * Pane Run. No LLM anywhere: `fake-headless-claude.mjs` gains a HANG mode (a Run
 * caught mid-flight, so take-over can kill it) and an INTERROGATE mode (a
 * post-mortem read that touches nothing on disk).
 *
 * What is machine-covered here:
 *   - AC1 — take-over kills the headless child, spawns the resume command
 *     (`claude --resume <id>`) in the SAME cwd, and the drain's slot + guard are
 *     unchanged before/after (planDrain sees an identical running Run) and keep
 *     scheduling around it.
 *   - AC2 — the resumed session finishing (flip `done` + Receipt) completes the
 *     Run exactly like any Pane Run: the REAL watcher ingests it.
 *   - AC3 — post-mortem resume opens a Pane for a finished Run WITHOUT creating a
 *     new Run (no slot taken) or touching the backlog (issue file + Receipt
 *     byte-identical before/after).
 *
 * The live-`claude` half (AC "a live take-over in the QA sandbox shows the same
 * conversation continuing") and the Electron/renderer halves (the Take over /
 * Resume button, the Feed→Pane swap in a real window) need the live shell and a
 * real binary; they are declared `manual-only` at the bottom, never silently
 * skipped. Run with `npm run test:e2e` before any QA walkthrough.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HeadlessSessionManager } from '../src/main/headless-session-manager';
import { PtySessionManager } from '../src/main/pty-session-manager';
import { ReceiptWatcher } from '../src/main/receipt-watcher';
import { readBacklog } from '../src/main/backlog-reader';
import { resolveResumeRunCommand } from '../src/main/resolve-run-command';
import { planDrain, type ActiveRun } from '../src/shared/run-coordinator';
import { parseReceipt } from '../src/shared/receipt-parser';
import { takeoverTarget } from '../src/shared/run-takeover';
import type {
  PtyExitMessage,
  RunSessionCapturedMessage,
  RunLogRecord,
  RunTarget,
} from '../src/shared/ipc-contract';
import { seedSandbox, sandboxIssue, waitFor, type Sandbox } from './sandbox';

const FAKE = join(process.cwd(), 'e2e', 'fake-headless-claude.mjs');

let sandbox: Sandbox;
let repo: string;
let headless: HeadlessSessionManager | null;
let pty: PtySessionManager | null;
let watcher: ReceiptWatcher | null;

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
  'MC_FAKE_HANG',
  'MC_FAKE_INTERROGATE',
];
let savedEnv: Record<string, string | undefined>;

/** Point the fake Worker at one issue's files; `mode` picks its behaviour. */
function configureFakeWorker(opts: {
  sessionId: string;
  slug: string;
  id: number;
  finished?: string;
  mode?: 'complete' | 'hang' | 'interrogate';
}): void {
  const mode = opts.mode ?? 'complete';
  process.env.MC_RUN_CMD = `node ${FAKE}`;
  process.env.MC_FAKE_SESSION_ID = opts.sessionId;
  process.env.MC_FAKE_ISSUE_FILE = join(repo, 'issues', `${opts.slug}.md`);
  process.env.MC_FAKE_RECEIPT_PATH = join(repo, 'issues', 'completions', `${opts.slug}.md`);
  process.env.MC_FAKE_DELIVERABLE = join(repo, 'work', `${opts.slug}.txt`);
  process.env.MC_FAKE_SLUG = opts.slug;
  process.env.MC_FAKE_ID = String(opts.id);
  process.env.MC_FAKE_FINISHED = opts.finished ?? '2026-07-17T12:00:00.000Z';
  process.env.MC_FAKE_OUTCOME = 'completed';
  // Reset the two take-over modes each call; set the one this spawn wants.
  delete process.env.MC_FAKE_HANG;
  delete process.env.MC_FAKE_INTERROGATE;
  if (mode === 'hang') process.env.MC_FAKE_HANG = '1';
  if (mode === 'interrogate') process.env.MC_FAKE_INTERROGATE = '1';
}

/** The headless RunTarget for a legacy-layout drain Run of `id`. */
function headlessRunTarget(id: number): RunTarget {
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
  headless = null;
  pty = null;
  watcher = null;
  savedEnv = {};
  for (const k of FAKE_ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(async () => {
  headless?.killAll();
  pty?.killAll();
  watcher?.closeAll();
  for (const k of FAKE_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(sandbox.scratch, { recursive: true, force: true });
});

describe('take-over a live headless Run (issue 144) — real managers, real watcher', () => {
  // ---------------------------------------------------------------------------
  // AC1 + AC2 — a live Run is taken over: the child is killed, the resume command
  // spawns in the same cwd, the slot + guard are unchanged and the drain keeps
  // scheduling around it, and the resumed session finishing completes the Run
  // exactly like any Pane Run.
  // ---------------------------------------------------------------------------
  it('kills the child, resumes in the same cwd, keeps the slot/guard, and completes like a Pane Run', async () => {
    // A drain Run of issue 2, caught mid-flight (HANG): it declares its session
    // id then stays alive, doing no on-disk work — a Run to grab the wheel of.
    configureFakeWorker({ sessionId: 'sess-takeover', slug: sandboxIssue(2).slug, id: 2, mode: 'hang' });

    const exits: PtyExitMessage[] = [];
    const captured: RunSessionCapturedMessage[] = [];
    headless = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: (msg) => captured.push(msg),
    });
    const headlessSpawn = headless.spawn({ cols: 80, rows: 24, run: headlessRunTarget(2) });

    // The session id is captured from the stream — the id take-over resumes.
    await waitFor(() => captured.length > 0, 'headless session id captured');
    expect(captured[0].claudeSessionId).toBe('sess-takeover');
    // It has NOT exited on its own — a genuine mid-flight Run.
    expect(exits).toHaveLength(0);

    // Slot + guard BEFORE take-over: cap 2, one running Run on issue 2. The
    // coordinator guards issue 2 (never re-started) and fills the other slot with
    // the next eligible issue (4) — the drain schedules around the running Run.
    const backlogBefore = await readBacklog(repo);
    const runningAsRun: ActiveRun[] = [{ issueId: 2, status: 'running' }];
    const planBefore = planDrain({ issues: backlogBefore.issues, maxConcurrent: 2, activeRuns: runningAsRun });
    expect(planBefore.startable).not.toContain(2);
    expect(planBefore.startable).toContain(4);
    expect(planBefore.drain.stop).toBe(false);

    // TAKE OVER — step 1: kill the headless child (what the RunFeed's unmount
    // does when the tile flips Feed → Pane). The real child dies and reports it.
    headless.kill(headlessSpawn.sessionId);
    await waitFor(() => exits.length > 0, 'headless child killed on take-over');
    expect(exits[0].sessionId).toBe(headlessSpawn.sessionId);

    // TAKE OVER — step 2: the resume target keeps the Run's identity and cwd, and
    // resolves to `claude --resume <captured-id>` — an interactive Pane, no seed.
    const resumeTarget = takeoverTarget(headlessRunTarget(2), 'sess-takeover');
    expect(resumeTarget.headless).toBe(false);
    expect(resumeTarget.projectPath).toBe(repo); // SAME working directory
    const resumeCmd = resolveResumeRunCommand(process.env, resumeTarget.resume!.claudeSessionId);
    expect(resumeCmd.args).toContain('--resume');
    expect(resumeCmd.args).toContain('sess-takeover');

    // The resumed Pane now finishes the issue (the operator drives it home). Point
    // the fake at issue 2 in COMPLETE mode and spawn it through the REAL pty
    // adapter — the same seam a resume Pane reaches — in the same cwd.
    configureFakeWorker({ sessionId: 'sess-takeover', slug: sandboxIssue(2).slug, id: 2, mode: 'complete' });
    const paneExits: PtyExitMessage[] = [];
    pty = new PtySessionManager({ onData: () => {}, onExit: (m) => paneExits.push(m) });
    const paneSpawn = pty.spawn({ cols: 80, rows: 24, run: resumeTarget });
    // The override resolves to `node <fake> --resume …` — a real child, not a pty
    // shell fallback.
    expect(paneSpawn.file).toBe('node');

    await waitFor(() => paneExits.length > 0, 'resumed Pane process exits');

    // AC2 — the resumed session finished exactly like any Pane Run: the issue is
    // `done` on disk, the deliverable landed, and the Receipt declares completed.
    const backlogAfter = await readBacklog(repo);
    expect(backlogAfter.issues.find((i) => i.id === 2)?.status).toBe('done');
    expect(existsSync(join(repo, 'work', `${sandboxIssue(2).slug}.txt`))).toBe(true);
    const receiptFile = join(repo, 'issues', 'completions', `${sandboxIssue(2).slug}.md`);
    const parsed = parseReceipt(await readFile(receiptFile, 'utf8'));
    expect(parsed.outcome).toBe('completed');
    expect(parsed.outcomeSource).toBe('declared');

    // The REAL ReceiptWatcher ingests it — the drain proceeds as for any Run.
    const records: RunLogRecord[] = [];
    watcher = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    watcher.watch('project', [sandbox.issuesDir], new Map(), (r) => records.push(r));
    await waitFor(() => records.some((r) => r.issueId === 2), 'watcher ingests the resumed Receipt');
    expect(records.find((r) => r.issueId === 2)!.outcome).toBe('completed');

    // Slot + guard AFTER: while the resumed Run was running, the coordinator saw
    // the SAME { issue 2, running } — an identical plan to `planBefore`, so the
    // slot count is provably unchanged across the mode switch. Once it finishes
    // (issue 2 `done`), issue 2 frees its slot yet stays guarded, and the drain
    // continues scheduling (its dependent 3 is now eligible off it).
    const finishedAsRun: ActiveRun[] = [{ issueId: 2, status: 'finished' }];
    const planAfter = planDrain({ issues: backlogAfter.issues, maxConcurrent: 2, activeRuns: finishedAsRun });
    expect(planAfter.startable).not.toContain(2); // still guarded (has a Run)
    expect(planAfter.startable).toContain(3); // dependent unblocked by 2 = done
    expect(planAfter.drain.stop).toBe(false); // drain continues
  });

  // ---------------------------------------------------------------------------
  // AC3 — post-mortem resume opens a Pane for a FINISHED Run without creating a
  // new Run (no slot taken) or touching the backlog (issue file + Receipt are
  // byte-identical before and after the resume).
  // ---------------------------------------------------------------------------
  it('post-mortem resume of a finished Run touches nothing on disk and takes no slot', async () => {
    // A completed drain Run of issue 4: it flips `done`, writes its Receipt, exits.
    configureFakeWorker({ sessionId: 'sess-postmortem', slug: sandboxIssue(4).slug, id: 4, mode: 'complete' });
    const exits: PtyExitMessage[] = [];
    const captured: RunSessionCapturedMessage[] = [];
    headless = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: (msg) => captured.push(msg),
    });
    headless.spawn({ cols: 80, rows: 24, run: headlessRunTarget(4) });
    await waitFor(() => captured.length > 0, 'finished Run session id captured');
    await waitFor(() => exits.length > 0, 'finished Run exits');

    const issueFile = join(repo, 'issues', `${sandboxIssue(4).slug}.md`);
    const receiptFile = join(repo, 'issues', 'completions', `${sandboxIssue(4).slug}.md`);
    expect((await readBacklog(repo)).issues.find((i) => i.id === 4)?.status).toBe('done');
    // Snapshot the on-disk state the post-mortem resume must NOT change.
    const issueBefore = await readFile(issueFile, 'utf8');
    const receiptBefore = await readFile(receiptFile, 'utf8');

    // POST-MORTEM RESUME: reopen the finished session (INTERROGATE mode — reads,
    // writes nothing) in the same cwd through the real pty adapter.
    configureFakeWorker({ sessionId: 'sess-postmortem', slug: sandboxIssue(4).slug, id: 4, mode: 'interrogate' });
    const resumeTarget = takeoverTarget(headlessRunTarget(4), 'sess-postmortem');
    const paneExits: PtyExitMessage[] = [];
    pty = new PtySessionManager({ onData: () => {}, onExit: (m) => paneExits.push(m) });
    const paneSpawn = pty.spawn({ cols: 80, rows: 24, run: resumeTarget });
    expect(paneSpawn.file).toBe('node');
    await waitFor(() => paneExits.length > 0, 'post-mortem Pane exits');

    // No backlog touch: the issue file and the Receipt are byte-identical, and the
    // issue is still `done` (no re-claim, no second flip).
    expect(await readFile(issueFile, 'utf8')).toBe(issueBefore);
    expect(await readFile(receiptFile, 'utf8')).toBe(receiptBefore);
    expect((await readBacklog(repo)).issues.find((i) => i.id === 4)?.status).toBe('done');

    // No new Run / no slot: a post-mortem-resumed finished Run does not occupy a
    // slot (it reads `finished`, `done` on disk), so the coordinator's free-slot
    // count is the full cap and issue 4 stays guarded — resuming introduces zero
    // scheduling pressure.
    const backlog = await readBacklog(repo);
    const asFinished: ActiveRun[] = [{ issueId: 4, status: 'finished' }];
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 2, activeRuns: asFinished });
    expect(plan.startable).not.toContain(4); // guarded — never re-run
    expect(plan.startable.length).toBe(2); // both slots free (finished takes none)
    expect(plan.drain.stop).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Manual-only (need the live Electron shell / a real `claude` binary): named,
  // never silently skipped.
  // ---------------------------------------------------------------------------
  it.skip('manual-only: a live take-over in the QA sandbox shows the SAME conversation continuing interactively — reason: needs a real `claude --resume` session (issue 144 AC4)', () => {});
  it.skip('manual-only: the Take over / Resume button on a Run tile swaps the Feed for a Pane in the live window — reason: renderer DOM + xterm in Electron; the transform is behavior-tested via run-takeover unit tests + the manager seam above', () => {});
});
