/**
 * E2E drain harness (issue 63) — walkthrough 58's checklist as code.
 *
 * Three human walkthroughs in a row failed on seam bugs 700 unit tests could
 * not see, because the seams (watchers, timers, git, worktrees, PTY delivery)
 * were only ever exercised by a human driving the live app. This suite drives
 * the REAL modules against REAL infrastructure — a temp git repo seeded like
 * the QA sandbox (`e2e/sandbox.ts`), the real Receipt watcher on the real
 * filesystem, real worktrees and the real `afk-merge.sh` merge path, the real
 * ingest → Run-log → lifecycle → pump pipeline (pumped into a scripted fake
 * PTY that records what was typed and submitted). Workers are scripted and
 * deterministic (`e2e/fake-worker.ts`) with configurable misbehavior modes.
 * No LLM anywhere.
 *
 * Scenarios map 1:1 to walkthrough 58's checklist:
 *   1. Solo Receipt        — one commit (deliverable + flip + Receipt); a
 *                            Run-log record with a DECLARED outcome.
 *   2. HITL notice         — park → `hitl-waiting` → notification DELIVERED
 *                            (fake PTY saw typed + submitted), surviving a
 *                            mid-queue session replacement (issue 60).
 *   3. Zero ghosts +       — a full mixed drain ingests zero unclassifiable
 *      park continuation     records AND continues past the parked HITL issue
 *                            (issue 64): every eligible issue runs, 05 stays
 *                            `wip`, exactly one hitl-waiting delivery. 3b/3c:
 *                            a declared-blocked Worker and a die-mid-exit
 *                            Worker (no Receipt, no flip) still halt.
 *   4. Parallel mode       — Receipts ingested LIVE from worktrees pre-merge;
 *                            a clean merge lands the Receipt files on main.
 *   5. Misbehavior         — stray Receipt on main is ADOPTED and the merge
 *                            proceeds (issue 62 — revert the adoption logic and
 *                            the first assertion here goes red); a no-receipt
 *                            Worker yields exactly ONE finished-without-receipt
 *                            note; a die-mid-exit Worker does not stall the
 *                            drain's remaining issues.
 *   6. Dirty non-Receipt   — a foreign dirty file on main halts TRUTHFULLY:
 *                            no merge, no auto-commit, no fake conflict.
 *   7. Run narrative       — ADR-0014 (issue 66): a mixed drain delivers ONE
 *                            conversation message per finished Run (the block,
 *                            heading + What-changed) plus the HITL park notice
 *                            and the drain-ended fact — all via the pump,
 *                            surviving a mid-drain session replacement; the
 *                            on-ask digest never repeats what the session saw
 *                            live, and a replacement session catches up via it.
 *   8. Memory loop         — issue 73 (ADR-0015): a workbench project's
 *                            CORE.md rides the real prompt builders via the
 *                            real file read; a fixture drain's end writes ONE
 *                            dated journal artifact into the workbench memory
 *                            (a second drain the same day gets its own file).
 *
 * Checklist items that genuinely need the live Electron shell are declared
 * `manual-only` at the bottom (as named, skipped specs) — zero silent gaps.
 * Run this suite (`npm run test:e2e`) BEFORE any human walkthrough.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ReceiptWatcher } from '../src/main/receipt-watcher';
import { RunLogStore } from '../src/main/run-log-store';
import { readBacklog } from '../src/main/backlog-reader';
import {
  applyIsolation,
  createWorktree,
  readIsolatedIssueStatus,
  commitFinishedMain,
  worktreePathFor,
  scanAfkBranches,
  isMidMerge,
} from '../src/main/git-worktree-adapter';
import { mergeRuns, defaultMergeScriptPath } from '../src/main/run-merge';
import { readCoreMemory, writeDrainJournal } from '../src/main/memory-files';
import { buildRunPrompt } from '../src/main/resolve-run-command';
import { buildDispatcherPrompt } from '../src/main/dispatcher-session';
import { CORE_MEMORY_LABEL } from '../src/shared/workbench-memory';
import { branchFor } from '../src/shared/isolation-policy';
import { planDrain, type ActiveRun, type DrainPlan } from '../src/shared/run-coordinator';
import { deriveRunStatus } from '../src/shared/run-state';
import {
  lifecycleKindForOutcome,
  actionForLifecycle,
  reactToLifecycleEvent,
} from '../src/shared/dispatcher-lifecycle';
import {
  INITIAL_TYPING_STATE,
  canFlushChat,
  channelForAction,
  reduceTyping,
  type TypingState,
} from '../src/shared/dispatcher-channel';
import { classifyAuthority } from '../src/shared/dispatcher-authority';
import {
  narrativeChannelFor,
  narrativeKindForLifecycle,
  narrativeKeyFor,
  sessionSeenRecordId,
} from '../src/shared/dispatcher-narrative';
import {
  renderCompletionEvent,
  toCompletionEvent,
} from '../src/shared/dispatcher-input-contract';
import { buildRunDigest } from '../src/shared/dispatcher-status-model';
import { createDispatcherPump, type DeliveryPhase } from '../src/shared/dispatcher-pump';
import {
  auditMissingReceipts,
  isReceiptRecord,
  latestReceiptOutcomeFor,
} from '../src/shared/receipt-audit';
import { isRealCapture } from '../src/shared/dispatcher-noise-floor';
import { parseReceipt } from '../src/shared/receipt-parser';
import type { RunLogRecord } from '../src/shared/ipc-contract';
import {
  seedSandbox,
  sandboxIssue,
  git,
  waitFor,
  sleep,
  FakePty,
  type Sandbox,
} from './sandbox';
import { runFakeWorker, type WorkerExit } from './fake-worker';

const SCRIPT = defaultMergeScriptPath();

let sandbox: Sandbox;
let repo: string;
let watcher: ReceiptWatcher;
let store: RunLogStore;

/** Everything the live ingest edge produced this test, in arrival order. */
let records: RunLogRecord[];
/** The caller-owned dedupe map (seeded from the Run log on a "restart"). */
let seen: Map<string, string | null>;
/** Store appends in flight (awaited before reading the store back). */
let appends: Promise<unknown>[];

/** The `issues/` roots the current test watches (for recovery re-points). */
let watchedDirs: string[];
let rescans = 0;

function onReceipt(record: RunLogRecord): void {
  records.push(record);
  appends.push(store.append(repo, record));
}

/** (Re)point the real Receipt watcher at the given `issues/` roots. */
function ingestFrom(...issueDirs: string[]): void {
  watchedDirs = issueDirs;
  watcher.watch('project', issueDirs, seen, onReceipt);
}

/**
 * Wait until the live edge has ingested a Receipt for the given issue id.
 *
 * Normally the recursive watch delivers within the debounce window. Under
 * load, though, macOS FSEvents can DROP an event raised before its stream
 * finished starting — a pure test-timing artifact (the harness writes Receipts
 * milliseconds after attaching; in the app the watch is attached long before
 * any Worker exits, and its reconcile re-points recover anything missed). So
 * after a grace period this falls back to the app's own recovery pattern: a
 * re-point whose initial scan re-reads what is already on disk, deduped by the
 * shared `seen` map so nothing ever double-feeds.
 */
async function waitForReceipt(issueId: number): Promise<RunLogRecord> {
  const ingested = (): boolean => records.some((r) => r.issueId === issueId);
  for (let attempt = 0; attempt < 3 && !ingested(); attempt++) {
    try {
      await waitFor(ingested, `receipt for issue ${issueId} ingested`, 1500);
    } catch {
      watcher.watch(`project-rescan-${rescans++}`, watchedDirs, seen, onReceipt);
    }
  }
  await waitFor(ingested, `receipt for issue ${issueId} ingested (after re-point scans)`, 2000);
  return records.find((r) => r.issueId === issueId)!;
}

/** Current committed-history commit count on main. */
async function commitCount(): Promise<number> {
  return Number((await git(repo, 'rev-list', '--count', 'HEAD')).trim());
}

beforeEach(async () => {
  sandbox = await seedSandbox();
  repo = sandbox.repo;
  // Fast (but real) debounce/stability timers so the suite stays quick while
  // still exercising the genuine two-read stability loop.
  watcher = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
  store = new RunLogStore(join(sandbox.scratch, 'store'));
  records = [];
  seen = new Map();
  appends = [];
});

afterEach(async () => {
  watcher.closeAll();
  await rm(sandbox.scratch, { recursive: true, force: true });
});

describe('e2e drain harness — real modules, real infrastructure', () => {
  it('the real afk-merge.sh exists where the skill installs it', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — Solo Run: ONE commit containing deliverable + flip + Receipt;
  // a Run-log record with a DECLARED outcome. (Walkthrough 58, "Solo Receipt".)
  // ---------------------------------------------------------------------------
  it('Scenario 1: solo Run → one commit (deliverable + flip + Receipt) and a declared Run-log record', async () => {
    ingestFrom(sandbox.issuesDir);
    const baseline = await commitCount();
    const issue = sandboxIssue(2);
    const finished = '2026-07-03T12:00:00.000Z';

    // The Worker finishes issue 02 solo (uncommitted — MC owns the commit).
    const trace = await runFakeWorker({ repo, issue, finished });
    expect(trace.receiptPath).toBe(join(repo, 'issues', 'completions', `${issue.slug}.md`));

    // The REAL watcher (real fs events, debounce, stability reads) ingests it,
    // keyed on issue + `finished` (ADR-0013's dedupe identity).
    const record = await waitForReceipt(2);
    expect(record.id).toBe(`receipt:${issue.slug}:${finished}`);
    expect(record.outcome).toBe('completed');
    expect(record.whatChanged).toBeTruthy();
    expect(record.tryIt).toBeTruthy();

    // Declared, not inferred: classification is a frontmatter field read.
    expect(parseReceipt(await readReceipt(issue.slug)).outcomeSource).toBe('declared');

    // The record enters the durable Run log (real JSONL on disk) intact.
    await Promise.all(appends);
    const persisted = await store.read(repo);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(record.id);
    expect(persisted[0].outcome).toBe('completed');
    expect(isReceiptRecord(persisted[0])).toBe(true);

    // MC observes the finished solo Run → exactly ONE run commit lands, holding
    // the deliverable, the done flip AND the Receipt (issue 59's contract).
    const outcome = await commitFinishedMain(repo, issue.slug);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();
    expect(await commitCount()).toBe(baseline + 1);
    const committedFiles = await git(repo, 'show', '--name-only', '--pretty=format:', 'HEAD');
    expect(committedFiles).toContain(`work/${issue.slug}.txt`);
    expect(committedFiles).toContain(`issues/${issue.slug}.md`);
    expect(committedFiles).toContain(`issues/completions/${issue.slug}.md`);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');

    // Ground truth agrees: the issue reads done from the real backlog reader.
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 2)?.status).toBe('done');
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — HITL Run parks → `hitl-waiting` derived → the notification is
  // DELIVERED (fake PTY saw typed + submitted), surviving a mid-queue session
  // replacement (issue 60's guarantee, end-to-end).
  // ---------------------------------------------------------------------------
  it('Scenario 2: HITL park → hitl-waiting → notification delivered through a session replacement', async () => {
    ingestFrom(sandbox.issuesDir);
    const issue = sandboxIssue(5);

    // The Worker parks the HITL issue: stays wip, Receipt declares the park.
    await runFakeWorker({ repo, issue, exit: 'needs-verification' });
    const record = await waitForReceipt(5);
    expect(record.outcome).toBe('needs-verification');
    expect(record.detail).toContain('manual verification');

    // Ground truth from the real backlog: 05 is wip and hitl.
    const backlog = await readBacklog(repo);
    const five = backlog.issues.find((i) => i.id === 5)!;
    expect(five.status).toBe('wip');
    expect(five.hitl).toBe(true);

    // The pure chain the app composes: outcome + hitl flag → hitl-waiting →
    // a blocking chat-tier prompt (never the ambient log).
    const kind = lifecycleKindForOutcome(record.outcome, five.hitl);
    expect(kind).toBe('hitl-waiting');
    expect(actionForLifecycle(kind!)).toBe('hitl-signoff');
    expect(channelForAction(actionForLifecycle(kind!))).toBe('chat');

    const reaction = reactToLifecycleEvent({
      kind: kind!,
      runId: record.id,
      issueId: record.issueId,
      slug: record.slug,
      title: null,
      detail: record.detail,
    });
    expect(reaction.proactive).toBe(true);
    expect(reaction.notification).toContain('HITL gate waiting');
    expect(reaction.notification).toContain('05');

    // Delivery through the REAL pump into a scripted chat PTY — with the
    // Dispatcher session dying and being replaced MID-pump (issue 60).
    const pty = new FakePty();
    pty.create('dispatcher-A');
    pty.create('dispatcher-B');
    const phases: { key: string; phase: DeliveryPhase }[] = [];
    const pump = createDispatcherPump({
      write: pty.write,
      canFlush: () => true,
      onDelivery: (key, phase) => phases.push({ key, phase }),
    });
    pump.attachSession('dispatcher-A');

    const key = `hitl-waiting:${record.id}`;
    expect(pump.enqueue({ key, text: reaction.notification! })).toBe(true);
    // Gate churn can't multiply one notification: same key won't double-queue.
    expect(pump.enqueue({ key, text: reaction.notification! })).toBe(false);

    // The pump has typed into A but NOT yet submitted (the submit write is a
    // separate later step). Kill A mid-queue and attach the replacement.
    pty.kill('dispatcher-A');
    pump.attachSession(null);
    pump.attachSession('dispatcher-B');

    await waitFor(() => phases.some((p) => p.phase === 'submitted'), 'delivery to replacement session');

    // Delivered: the REPLACEMENT session saw the message typed AND submitted.
    const submitted = pty.submittedMessages('dispatcher-B');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('HITL gate waiting');
    expect(submitted[0]).toContain('05');
    expect(submitted[0]).toContain('manual verification');
    // The dead session never received a completed submit.
    expect(pty.submittedMessages('dispatcher-A')).toHaveLength(0);
    expect(pump.pending()).toBe(0);

    // Delivery was observable end-to-end (issue 60 rule 3).
    const seq = phases.filter((p) => p.key === key).map((p) => p.phase);
    expect(seq[0]).toBe('queued');
    expect(seq).toContain('requeued');
    expect(seq[seq.length - 1]).toBe('submitted');
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — a full cap-1 mixed drain with LINGERING Workers: zero
  // unclassifiable records, and the drain CONTINUES past the parked HITL issue
  // (issues 64 + 65). The Workers here linger the way a real claude Pane does —
  // they finish their exit and keep their session alive at the prompt — so the
  // slot only frees if the Run's status turns terminal on DECLARED facts (the
  // `done` flip, or the Receipt's outcome), never on session death. Before
  // issue 65 this exact drain stalled at 05: the parked HITL Run read
  // `running` forever and the cap-1 coordinator (correctly) waited for a slot
  // that never came. Fake workers that exit hid it; lingering ones catch it.
  // ---------------------------------------------------------------------------
  it('Scenario 3: a cap-1 mixed drain with lingering Workers parks the HITL issue, frees its slot, and completes the rest', async () => {
    ingestFrom(sandbox.issuesDir);

    // Drive the drain the way the app does: re-plan with the REAL coordinator
    // against the REAL backlog after every Run, cap 1, each Run carrying its
    // latest Receipt's declared outcome (issue 64). Scripted exits: 02/03/04
    // complete (03 becomes eligible only after 02 is done), 05 parks HITL,
    // 06/07 complete AFTER the park — the drain must not halt at 05.
    const exits = new Map<number, WorkerExit>([
      [2, 'completed'],
      [3, 'completed'],
      [4, 'completed'],
      [5, 'needs-verification'],
      [6, 'completed'],
      [7, 'completed'],
    ]);
    const terminal: ActiveRun[] = [];
    const started: number[] = [];
    let stop: DrainPlan['drain'] | null = null;
    let stalledAtFullCap = false;
    for (let round = 0; round < 10; round++) {
      const backlog = await readBacklog(repo);
      const plan = planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns: terminal });
      if (plan.drain.stop) {
        stop = plan.drain;
        break;
      }
      const id = plan.startable[0];
      if (id === undefined) {
        // Live but nothing startable: every tracked Run lingers at its prompt
        // and at least one still counts as `running` — the walkthrough-58
        // third-attempt stall this scenario exists to catch (issue 65).
        stalledAtFullCap = true;
        break;
      }
      started.push(id);
      const issue = sandboxIssue(id);
      // Linger mode: the Worker writes everything, then sits at its prompt —
      // `sessionAlive` stays true, exactly like a real claude Pane.
      const trace = await runFakeWorker({
        repo,
        issue,
        exit: exits.get(id) ?? 'completed',
        linger: true,
      });
      const record = await waitForReceipt(id);
      const after = await readBacklog(repo);
      const status = deriveRunStatus({
        sessionAlive: trace.sessionAlive,
        stoppedByUser: false,
        issueStatus: after.issues.find((i) => i.id === id)?.status ?? null,
        receiptOutcome: record.outcome,
      });
      if (status === 'finished') await commitFinishedMain(repo, issue.slug);
      terminal.push({ issueId: id, status, receiptOutcome: record.outcome });
    }

    // Issue 65's core assertion: the lingering HITL park did NOT wedge the
    // cap — its Run turned terminal (`parked`) on the Receipt's declared
    // outcome alone, freeing the slot while the session stayed alive.
    expect(stalledAtFullCap).toBe(false);
    expect(terminal.find((r) => r.issueId === 5)?.status).toBe('parked');

    // Issue 64's core assertion: the drain ran EVERY eligible issue, parking
    // 05 along the way — no halt at the park. It ended because nothing
    // eligible remained, never because a Run "blocked".
    expect(started).toEqual([2, 3, 4, 5, 6, 7]);
    expect(stop).not.toBeNull();
    expect(stop!.reason).toBe('no-eligible');

    // The park is real: 05 is left `wip` (awaiting the human), everything
    // else the drain touched is `done`.
    const backlog = await readBacklog(repo);
    const five = backlog.issues.find((i) => i.id === 5)!;
    expect(five.status).toBe('wip');
    expect(five.hitl).toBe(true);
    for (const id of [2, 3, 4, 6, 7]) {
      expect(backlog.issues.find((i) => i.id === id)?.status).toBe('done');
    }

    // A park blocks only its dependents: 08 (`depends_on: [5]`) was never
    // started and stays open — no special casing, its dependency simply
    // never reached `done`.
    expect(started).not.toContain(8);
    expect(backlog.issues.find((i) => i.id === 8)?.status).toBe('open');

    // Exactly ONE hitl-waiting event derives from the whole drain's records —
    // and it is delivered exactly once through the real pump into the chat PTY.
    const isHitlIssue = (issueId: number | null): boolean =>
      issueId !== null && (backlog.issues.find((i) => i.id === issueId)?.hitl ?? false);
    const hitlRecords = records.filter(
      (r) => lifecycleKindForOutcome(r.outcome, isHitlIssue(r.issueId)) === 'hitl-waiting',
    );
    expect(hitlRecords).toHaveLength(1);
    expect(hitlRecords[0].issueId).toBe(5);

    const pty = new FakePty();
    pty.create('dispatcher');
    const pump = createDispatcherPump({ write: pty.write, canFlush: () => true });
    pump.attachSession('dispatcher');
    for (const rec of hitlRecords) {
      const reaction = reactToLifecycleEvent({
        kind: 'hitl-waiting',
        runId: rec.id,
        issueId: rec.issueId,
        slug: rec.slug,
        title: rec.title,
        detail: rec.detail,
      });
      // Enqueue twice on the same key — dedupe keeps delivery at one.
      pump.enqueue({ key: `hitl-waiting:${rec.id}`, text: reaction.notification! });
      pump.enqueue({ key: `hitl-waiting:${rec.id}`, text: reaction.notification! });
    }
    await waitFor(
      () => pty.submittedMessages('dispatcher').length > 0,
      'hitl-waiting notification delivered',
    );
    const delivered = pty.submittedMessages('dispatcher');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('HITL gate waiting');
    expect(delivered[0]).toContain('05');

    // ZERO ghosts: every ingested record is a classified, real capture — no
    // `unknown`s, no boot-screen junk, exactly one record per Receipt written.
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.outcome !== 'unknown')).toBe(true);
    expect(records.every((r) => isRealCapture(r))).toBe(true);
    expect(records.every((r) => isReceiptRecord(r))).toBe(true);
    const outcomes = new Map(records.map((r) => [r.issueId, r.outcome]));
    expect(outcomes.get(2)).toBe('completed');
    expect(outcomes.get(3)).toBe('completed');
    expect(outcomes.get(4)).toBe('completed');
    expect(outcomes.get(5)).toBe('needs-verification');
    expect(outcomes.get(6)).toBe('completed');
    expect(outcomes.get(7)).toBe('completed');

    // The durable Run log agrees, with unique ids (no double-feeds).
    await Promise.all(appends);
    const persisted = await store.read(repo);
    expect(persisted).toHaveLength(6);
    expect(new Set(persisted.map((r) => r.id)).size).toBe(6);

    // An MC "restart" — a fresh watcher whose `seen` is seeded from the
    // persisted Run log — re-scans every existing Receipt and feeds NOTHING.
    const restartRecords: RunLogRecord[] = [];
    const restartSeen = new Map<string, string | null>(persisted.map((r) => [r.id, null]));
    const restarted = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    try {
      restarted.watch('restart', [sandbox.issuesDir], restartSeen, (r) => restartRecords.push(r));
      await sleep(400);
      expect(restartRecords).toEqual([]);
    } finally {
      restarted.closeAll();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 3b — the conservative halts issue 64 must NOT relax: a Worker that
  // DECLARES `outcome: blocked` still stops the drain with today's report —
  // even while its session LINGERS at the prompt (issue 65: a blocked Worker
  // also never exits, so the Run must end `blocked` on the declared Receipt
  // alone, not wait for a session death that never comes).
  // ---------------------------------------------------------------------------
  it('Scenario 3b: a lingering Worker declaring outcome: blocked still halts the drain', async () => {
    ingestFrom(sandbox.issuesDir);

    // 02 completes normally; 03 (unblocked by it) then declares blocked.
    const two = sandboxIssue(2);
    await runFakeWorker({ repo, issue: two, exit: 'completed' });
    await commitFinishedMain(repo, two.slug);
    const rec2 = await waitForReceipt(2);
    const terminal: ActiveRun[] = [{ issueId: 2, status: 'finished', receiptOutcome: rec2.outcome }];

    let backlog = await readBacklog(repo);
    expect(planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns: terminal }).startable[0]).toBe(3);
    const trace3 = await runFakeWorker({ repo, issue: sandboxIssue(3), exit: 'blocked', linger: true });
    expect(trace3.sessionAlive).toBe(true);

    // Walkthrough item "Blocked exit": the blocked report lands as a Receipt
    // (`outcome: blocked`) — one classified record, carrying the reason.
    const rec3 = await waitForReceipt(3);
    expect(rec3.outcome).toBe('blocked');
    expect(isReceiptRecord(rec3)).toBe(true);
    expect(rec3.detail).toContain('I stopped because');

    backlog = await readBacklog(repo);
    const status = deriveRunStatus({
      sessionAlive: trace3.sessionAlive,
      stoppedByUser: false,
      issueStatus: backlog.issues.find((i) => i.id === 3)?.status ?? null,
      receiptOutcome: rec3.outcome,
    });
    expect(status).toBe('blocked');
    terminal.push({ issueId: 3, status, receiptOutcome: latestReceiptOutcomeFor(records, 3) });

    // The re-plan HALTS: declared blocked is a genuine stop, never a park —
    // nothing further starts, and the un-started issues are reported.
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns: terminal });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(3);
    expect(plan.startable).toEqual([]);
    expect(plan.queued).toEqual([4, 5, 6, 7]);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3c — a die-mid-exit Worker (no Receipt, no done flip) also still
  // halts: with nothing DECLARED, even the HITL marker cannot park it (the
  // genuinely-unknown case keeps the conservative stop, issue 64).
  // ---------------------------------------------------------------------------
  it('Scenario 3c: a Worker that dies with no Receipt and no flip still halts the drain', async () => {
    ingestFrom(sandbox.issuesDir);

    // The Worker claims the HITL issue 05, then dies mid-exit: the issue stays
    // `wip` and NO Receipt is ever written.
    await runFakeWorker({
      repo,
      issue: sandboxIssue(5),
      exit: 'needs-verification',
      misbehavior: 'no-receipt',
    });
    await sleep(300);
    expect(records).toEqual([]);

    const backlog = await readBacklog(repo);
    const five = backlog.issues.find((i) => i.id === 5)!;
    expect(five.status).toBe('wip');
    expect(five.hitl).toBe(true);

    // Even on an HITL-marked issue, no Receipt means no declared park — the
    // drain stops and reports, exactly as before issue 64.
    const status = deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: 'wip' });
    const plan = planDrain({
      issues: backlog.issues,
      maxConcurrent: 1,
      activeRuns: [{ issueId: 5, status, receiptOutcome: latestReceiptOutcomeFor(records, 5) }],
    });
    expect(plan.drain.stop).toBe(true);
    expect(plan.drain.reason).toBe('run-blocked');
    expect(plan.drain.blockedIssueId).toBe(5);
    expect(plan.startable).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — Parallel Runs: Receipts ingested LIVE from worktrees pre-merge;
  // a clean auto-merge lands the Receipt files on main.
  // ---------------------------------------------------------------------------
  it('Scenario 4: parallel Receipts ingest live from worktrees, then a clean merge lands them on main', async () => {
    const six = sandboxIssue(6);
    const seven = sandboxIssue(7);
    const iso = await applyIsolation(repo, [
      { issueId: 6, slug: six.slug },
      { issueId: 7, slug: seven.slug },
    ]);
    expect(iso.parallel).toBe(true);
    const wt6 = worktreePathFor(repo, six.slug);
    const wt7 = worktreePathFor(repo, seven.slug);

    // The watcher covers the checkout AND each live worktree's issues dir —
    // exactly how the app re-points it as worktrees appear.
    ingestFrom(sandbox.issuesDir, join(wt6, 'issues'), join(wt7, 'issues'));

    // 06's Worker exercises the receipt-before-commit mode: its Receipt is on
    // disk in the worktree while NOTHING is committed yet.
    await runFakeWorker({ repo, worktree: wt6, issue: six, misbehavior: 'receipt-before-commit' });
    const rec6 = await waitForReceipt(6);
    expect(rec6.outcome).toBe('completed');
    // Ingested LIVE from the WORKTREE: nothing has reached main (or even the
    // branch — this Worker died before committing), yet the record exists.
    expect(await git(repo, 'ls-files')).not.toContain(`issues/completions/${six.slug}.md`);
    expect(existsSync(join(repo, 'issues', 'completions', `${six.slug}.md`))).toBe(false);

    // MC observes the finished worktree → the real auto-commit repairs the
    // dropped commit (deliverable + flip + Receipt land on afk/06-parallel-a),
    // leaving the branch genuinely ahead of main (finished-unmerged).
    const obs6 = await readIsolatedIssueStatus(repo, six.slug);
    expect(obs6.status).toBe('done');
    expect(obs6.commitError).toBeNull();
    let facts = await scanAfkBranches(repo);
    expect(facts.find((f) => f.slug === six.slug)?.mergedIntoMain).toBe(false);

    // 07's Worker is well-behaved: commits its own work + Receipt.
    const trace7 = await runFakeWorker({ repo, worktree: wt7, issue: seven });
    expect(trace7.committed).toBe(true);
    const rec7 = await waitForReceipt(7);
    expect(rec7.outcome).toBe('completed');
    const obs7 = await readIsolatedIssueStatus(repo, seven.slug);
    expect(obs7.status).toBe('done');

    // Both Receipts were ingested BEFORE any merge — from the worktrees.
    facts = await scanAfkBranches(repo);
    expect(facts.every((f) => !f.mergedIntoMain)).toBe(true);
    expect(records.map((r) => r.issueId).sort()).toEqual([6, 7]);

    // Clean merge via the REAL afk-merge.sh: both branches land, and the
    // Receipt files are present ON MAIN afterwards.
    const result = await mergeRuns(repo, [six.slug, seven.slug], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged.sort()).toEqual([six.slug, seven.slug]);
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain(`issues/completions/${six.slug}.md`);
    expect(tracked).toContain(`issues/completions/${seven.slug}.md`);
    expect(existsSync(join(repo, 'issues', 'completions', `${six.slug}.md`))).toBe(true);
    expect(existsSync(join(repo, 'issues', 'completions', `${seven.slug}.md`))).toBe(true);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — deliberately misbehaving Workers.
  // ---------------------------------------------------------------------------
  describe('Scenario 5: misbehaving Workers', () => {
    it('a stray Receipt on main is adopted (issue 62) and the merge proceeds', async () => {
      ingestFrom(sandbox.issuesDir);
      const six = sandboxIssue(6);
      await createWorktree(repo, six.slug, branchFor(six.slug));
      const wt6 = worktreePathFor(repo, six.slug);

      // The walkthrough-2 bug, scripted: the Worker commits its work on the
      // branch but writes its Receipt into the MAIN checkout's completions dir.
      const trace = await runFakeWorker({
        repo,
        worktree: wt6,
        issue: six,
        misbehavior: 'receipt-to-wrong-checkout',
      });
      expect(trace.committed).toBe(true);
      expect(trace.receiptPath).toBe(join(repo, 'issues', 'completions', `${six.slug}.md`));

      // Ingest handles both locations: the stray Receipt still reaches the log.
      const record = await waitForReceipt(6);
      expect(record.outcome).toBe('completed');

      // The stray file is untracked on main — the exact state that used to fail
      // EVERY later merge. The merge now ADOPTS it and proceeds. (Reverting
      // issue 62's adoption turns this into a dirty-tree halt → ok === false.)
      const result = await mergeRuns(repo, [six.slug], { scriptPath: SCRIPT });
      expect(result.ok).toBe(true);
      expect(result.adopted).toEqual([`issues/completions/${six.slug}.md`]);
      expect(result.merged).toEqual([six.slug]);

      // The adoption is a dedicated, greppable commit; main ends clean with the
      // work merged and the Receipt tracked.
      const log = await git(repo, 'log', '--pretty=%s');
      expect(log).toContain('chore: adopt stray Receipt(s)');
      expect(await git(repo, 'ls-files')).toContain(`issues/completions/${six.slug}.md`);
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    });

    it('a no-receipt Worker yields exactly one finished-without-receipt passive note', async () => {
      ingestFrom(sandbox.issuesDir);
      const two = sandboxIssue(2);
      const four = sandboxIssue(4);

      // 02 finishes properly (Receipt written); 04 finishes with NO Receipt.
      await runFakeWorker({ repo, issue: two });
      await waitForReceipt(2);
      await commitFinishedMain(repo, two.slug);
      await runFakeWorker({ repo, issue: four, misbehavior: 'no-receipt' });
      await commitFinishedMain(repo, four.slug);
      // Give the real watcher time to (wrongly) surface anything for 04.
      await sleep(300);
      expect(records.some((r) => r.issueId === 4)).toBe(false);

      // The audit derives EXACTLY ONE honest event — for 04, never for 02.
      const events = auditMissingReceipts(
        [
          { issueId: 2, slug: two.slug, title: two.title, status: 'finished' },
          { issueId: 4, slug: four.slug, title: four.title, status: 'finished' },
        ],
        records,
      );
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('finished-without-receipt');
      expect(events[0].issueId).toBe(4);

      // It surfaces as ONE honest line — no scrape, no junk entry. Under
      // ADR-0014 (issue 66) a missing Receipt is a drain fact worth telling:
      // it is chat NARRATIVE (a message in the conversation) while remaining a
      // non-blocking relay — a fact, never a gate.
      const reaction = reactToLifecycleEvent(events[0]);
      expect(reaction.notification).toContain('finished without a receipt');
      expect(reaction.proactive).toBe(false);
      expect(narrativeChannelFor(narrativeKindForLifecycle(events[0].kind))).toBe('chat');
      expect(classifyAuthority(actionForLifecycle(events[0].kind))).not.toBe('blocking');
    });

    it('a die-mid-exit Worker does not stall the drain\'s remaining issues', async () => {
      ingestFrom(sandbox.issuesDir);
      const two = sandboxIssue(2);

      // The Worker flips 02 done, then dies: no Receipt, nothing committed.
      await runFakeWorker({ repo, issue: two, misbehavior: 'die-mid-exit' });

      // Ground truth still reads "finished" (the flip IS on disk), so MC's solo
      // auto-commit self-heals the dropped exit and main ends clean.
      const status = deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: 'done' });
      expect(status).toBe('finished');
      const outcome = await commitFinishedMain(repo, two.slug);
      expect(outcome.committed).toBe(true);
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');

      // The drain's next re-plan CONTINUES: the dead Run's issue is done, so
      // the dep-blocked 03 unblocks and is startable — no stall, no stop.
      const backlog = await readBacklog(repo);
      const plan = planDrain({
        issues: backlog.issues,
        maxConcurrent: 1,
        activeRuns: [{ issueId: 2, status }],
      });
      expect(plan.drain.stop).toBe(false);
      expect(plan.startable).toEqual([3]);

      // And the honest signal fires: one finished-without-receipt note for 02.
      const events = auditMissingReceipts(
        [{ issueId: 2, slug: two.slug, title: two.title, status: 'finished' }],
        records,
      );
      expect(events).toHaveLength(1);
      expect(events[0].issueId).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 — a dirty NON-Receipt file on main: truthful halt, no merge,
  // no auto-commit, no fake conflict.
  // ---------------------------------------------------------------------------
  it('Scenario 6: a dirty non-Receipt file on main halts truthfully — no merge, no fake conflict', async () => {
    const six = sandboxIssue(6);
    await createWorktree(repo, six.slug, branchFor(six.slug));
    const wt6 = worktreePathFor(repo, six.slug);
    const trace = await runFakeWorker({ repo, worktree: wt6, issue: six });
    expect(trace.committed).toBe(true);

    // Unknown state on main: a tracked file modified outside MC's knowledge.
    await appendFile(join(repo, 'README.md'), 'uncommitted local edit\n');

    const result = await mergeRuns(repo, [six.slug], { scriptPath: SCRIPT });

    // Truthful halt: not ok, NOT a conflict, nothing merged, nothing adopted.
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.midMerge).toBe(false);
    expect(result.merged).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.message).toMatch(/uncommitted changes/i);
    expect(result.message).toContain('README.md');

    // The foreign file was NOT auto-committed, main is not mid-merge, and the
    // finished branch is left intact for after the user cleans up.
    expect(await git(repo, 'status', '--porcelain')).toContain('README.md');
    expect(await isMidMerge(repo)).toBe(false);
    const facts = await scanAfkBranches(repo);
    expect(facts.find((f) => f.slug === six.slug)?.mergedIntoMain).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7 — run narrative lands in the Dispatcher CONVERSATION (issue 66,
  // ADR-0014). The same cap-1 lingering mixed drain as Scenario 3, but with the
  // chat wired: each finished Run's Completion block is typed + submitted into
  // the Dispatcher session as ONE message via the real pump, the HITL park
  // notice arrives the same way, and the drain's ending is a spoken fact — all
  // surviving a mid-drain session replacement. Live delivery and the on-ask
  // digest (issue 61) share one "session has seen it" set: a digest ask after
  // live delivery repeats nothing, and a replacement session (a brand-new
  // claude conversation) catches up on what it missed via the digest.
  // ---------------------------------------------------------------------------
  it('Scenario 7: run narrative — live blocks + park notice + drain fact into the conversation; digest is catch-up only', async () => {
    ingestFrom(sandbox.issuesDir);

    const pty = new FakePty();
    pty.create('S1');
    pty.create('S2');
    // The ONE shared "this session has seen it" set (issues 61 + 66): marked on
    // enqueue of a narrative/park message (as App.tsx marks it) and re-marked by
    // the delivery hook when a submit lands — which is what repairs the set
    // after a session replacement requeues and re-delivers an item.
    let sessionSeen = new Set<string>();
    // Issue 68: the chat input stream runs through the REAL defer-while-typing
    // gate, exactly as App.tsx wires it — each user chunk folds via
    // `reduceTyping`, and the pump consults `canFlushChat` before every flush.
    let typing: TypingState = INITIAL_TYPING_STATE;
    const pump = createDispatcherPump({
      write: pty.write,
      canFlush: (now) => canFlushChat(typing, now),
      onDelivery: (key, phase) => {
        if (phase !== 'submitted') return;
        const recId = sessionSeenRecordId(key);
        if (recId !== null) sessionSeen.add(recId);
      },
    });
    pump.attachSession('S1');

    // Route one ingested record exactly the way App.tsx does under ADR-0014:
    // completed → the rendered block as chat narrative; HITL park → the
    // blocking notice (unchanged authority path). Both count as session-seen.
    const narrate = (rec: RunLogRecord, hitl: boolean): void => {
      const kind = lifecycleKindForOutcome(rec.outcome, hitl);
      if (kind === 'finished') {
        expect(narrativeChannelFor(narrativeKindForLifecycle(kind))).toBe('chat');
        pump.enqueue({
          key: narrativeKeyFor(rec.id),
          text: renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec })),
        });
        sessionSeen.add(rec.id);
      } else if (kind === 'hitl-waiting') {
        const reaction = reactToLifecycleEvent({
          kind,
          runId: rec.id,
          issueId: rec.issueId,
          slug: rec.slug,
          title: rec.title,
          detail: rec.detail,
        });
        expect(channelForAction(actionForLifecycle(kind))).toBe('chat');
        pump.enqueue({ key: `hitl-waiting:${rec.id}`, text: reaction.notification! });
        sessionSeen.add(rec.id);
      }
    };

    // Drive the cap-1 lingering mixed drain (Scenario 3's loop), narrating each
    // Run as its Receipt lands. After 03 finishes, the Dispatcher session is
    // REPLACED — a brand-new claude conversation: the seen-set resets to the
    // drain-start baseline (empty here: no records predate this drain), which is
    // App.tsx's replacement rule.
    const exits = new Map<number, WorkerExit>([
      [2, 'completed'],
      [3, 'completed'],
      [4, 'completed'],
      [5, 'needs-verification'],
      [6, 'completed'],
      [7, 'completed'],
    ]);
    const terminal: ActiveRun[] = [];
    let stop: DrainPlan['drain'] | null = null;
    for (let round = 0; round < 10; round++) {
      const backlog = await readBacklog(repo);
      const plan = planDrain({ issues: backlog.issues, maxConcurrent: 1, activeRuns: terminal });
      if (plan.drain.stop) {
        stop = plan.drain;
        break;
      }
      const id = plan.startable[0];
      if (id === undefined) break;
      const issue = sandboxIssue(id);
      const trace = await runFakeWorker({
        repo,
        issue,
        exit: exits.get(id) ?? 'completed',
        linger: true,
      });
      const record = await waitForReceipt(id);
      const after = await readBacklog(repo);
      narrate(record, after.issues.find((i) => i.id === id)?.hitl ?? false);
      await waitFor(() => pump.pending() === 0, `narrative for issue ${id} delivered`);
      const status = deriveRunStatus({
        sessionAlive: trace.sessionAlive,
        stoppedByUser: false,
        issueStatus: after.issues.find((i) => i.id === id)?.status ?? null,
        receiptOutcome: record.outcome,
      });
      if (status === 'finished') await commitFinishedMain(repo, issue.slug);
      terminal.push({ issueId: id, status, receiptOutcome: record.outcome });
      if (id === 2) {
        // Issue 68 (failing-first on pre-68 code): mid-drain the user CLICKS
        // the chat pane and SCROLLS it — the terminal emits focus-in/out
        // reports and SGR mouse-report bursts. None of that is typing: every
        // later narrative message (03, 04, the park notice, 06, 07, the drain
        // fact) must keep flowing live. On pre-68 code the first of these
        // chunks armed `composing` forever and dammed the whole queue behind
        // the user's next Enter.
        typing = reduceTyping(typing, '\x1b[I', Date.now());
        typing = reduceTyping(typing, '\x1b[<64;18;6M\x1b[<64;18;6M\x1b[<65;18;7M', Date.now());
        typing = reduceTyping(typing, '\x1b[O', Date.now());
      }
      if (id === 3) {
        // Mid-drain session replacement (issue 60 churn): S1 dies, S2 attaches.
        pty.kill('S1');
        pump.attachSession(null);
        pump.attachSession('S2');
        sessionSeen = new Set();
      }
    }

    // The drain ended because nothing eligible remained — and its ending is a
    // narrative fact spoken into the conversation (ADR-0014).
    expect(stop).not.toBeNull();
    expect(stop!.reason).toBe('no-eligible');
    expect(narrativeChannelFor('drain-halted')).toBe('chat');
    // Issue 68, the other half: a GENUINELY mid-compose line (printable chars,
    // no submit) still holds the queue — the drain fact waits behind the user's
    // half-typed question — and the held message flushes once the line is
    // submitted. (The ~15s idle decay path is unit-tested with a fake clock.)
    typing = reduceTyping(typing, 'status?', Date.now());
    pump.enqueue({ key: 'drain-halted:1', text: stop!.message });
    await sleep(700);
    expect(pump.pending(), 'drain fact held behind a live compose').toBe(1);
    typing = reduceTyping(typing, '\r', Date.now());
    await waitFor(() => pump.pending() === 0, 'drain-ended fact delivered after the submit');

    // --- One conversation message per finished Run, in finish order ---------
    const s1 = pty.submittedMessages('S1');
    const s2 = pty.submittedMessages('S2');
    const all = [...s1, ...s2];
    // 5 completed blocks + 1 park notice + 1 drain fact — and NOTHING else.
    expect(all).toHaveLength(7);
    const blockIdsOf = (msgs: string[]): string[] =>
      msgs
        .map((m) => /Completion block for issue (\d\d) \(completed\)/.exec(m)?.[1] ?? null)
        .filter((id): id is string => id !== null);
    for (const id of [2, 3, 4, 6, 7]) {
      const label = String(id).padStart(2, '0');
      const mine = all.filter((m) => m.includes(`Completion block for issue ${label} (completed)`));
      expect(mine, `one message for issue ${label}`).toHaveLength(1);
      // The block's substance rode along: heading + What-changed.
      expect(mine[0]).toContain('What changed');
      expect(mine[0]).toContain(sandboxIssue(id).title);
    }
    // Delivery survived the replacement: 02/03 into S1; everything after the
    // churn — 04, the park notice, 06, 07, the drain fact — into S2, in order.
    expect(blockIdsOf(s1)).toEqual(['02', '03']);
    expect(blockIdsOf(s2)).toEqual(['04', '06', '07']);
    const park = s2.find((m) => m.includes('HITL gate waiting'));
    expect(park).toBeDefined();
    expect(park!).toContain('05');
    expect(park!).toContain('manual verification');
    expect(s2.indexOf(park!)).toBeLessThan(
      s2.findIndex((m) => m.includes('Completion block for issue 06')),
    );
    expect(s2[s2.length - 1]).toContain('no eligible issue remains');

    // --- The noise floor stands: nothing else reached the conversation ------
    expect(records.every((r) => r.outcome !== 'unknown' && isRealCapture(r))).toBe(true);
    expect(all.some((m) => m.includes('Ground-truth status'))).toBe(false);
    expect(narrativeChannelFor('status-refresh')).toBe('history');
    expect(narrativeChannelFor('doc-drift')).toBe('history');
    expect(narrativeChannelFor('cross-run-overlap')).toBe('history');

    // --- Blocking-approval behavior unchanged (the ADR-0011 three-item list) -
    expect(classifyAuthority('merge-conflict')).toBe('blocking');
    expect(classifyAuthority('abort-drain')).toBe('blocking');
    expect(classifyAuthority('hitl-signoff')).toBe('blocking');
    expect(channelForAction('merge-conflict')).toBe('chat');

    // --- The digest is catch-up only (issues 61 + 66) ------------------------
    await Promise.all(appends);
    const newestFirst = [...records].reverse();
    // S2 saw 04/05/06/07 live; 02/03 were delivered only to the DEAD S1 — the
    // digest catches the replacement session up on exactly those, no repeats.
    const digest = buildRunDigest(newestFirst, sessionSeen);
    expect(digest.text).not.toBeNull();
    expect(digest.text!).toContain('issue 02');
    expect(digest.text!).toContain('issue 03');
    for (const label of ['04', '05', '06', '07']) {
      expect(digest.text!, `digest must not repeat issue ${label}`).not.toContain(
        `issue ${label}`,
      );
    }
    // Once given, a further ask repeats nothing.
    for (const id of digest.digestedIds) sessionSeen.add(id);
    expect(buildRunDigest(newestFirst, sessionSeen).text).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 8 — the memory loop's MC half (issue 73, ADR-0015): a workbench
  // project's CORE.md rides the REAL prompt builders via the REAL file read,
  // and a fixture drain's end writes ONE dated journal artifact into the
  // workbench memory — a second drain the same day gets its OWN entry. The
  // full two-repo workbench fixture (cross-repo drain, registry resolution)
  // is issue 75's; this drives exactly the issue-73 seam.
  // ---------------------------------------------------------------------------
  it('Scenario 8: CORE.md rides the spawn prompts; a fixture drain writes one dated journal artifact (issue 73)', async () => {
    ingestFrom(sandbox.issuesDir);

    // A workbench-shaped memory skeleton for the fixture project.
    const memoryRoot = join(sandbox.scratch, 'workbench', 'proj', 'memory');
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(
      join(memoryRoot, 'CORE.md'),
      '- The sandbox resets via git reset --hard (distinctive fixture fact).\n',
      'utf8',
    );

    // --- In: the REAL CORE.md read feeds the REAL prompt builders ----------
    const core = await readCoreMemory(memoryRoot);
    const workerPrompt = buildRunPrompt({
      id: 2,
      fileName: '02-second-step.md',
      title: 'Second step',
      cwd: repo,
      workbench: {
        issuesRoot: join(sandbox.scratch, 'workbench', 'proj', 'issues'),
        completionsRoot: join(sandbox.scratch, 'workbench', 'proj', 'completions'),
      },
      memoryCore: core,
    });
    expect(workerPrompt).toContain(CORE_MEMORY_LABEL);
    expect(workerPrompt).toContain('distinctive fixture fact');
    const seed = buildDispatcherPrompt({ projectPath: repo, activePrd: null, memoryCore: core });
    expect(seed).toContain(CORE_MEMORY_LABEL);
    expect(seed).toContain('distinctive fixture fact');
    // Absent CORE injects nothing (the missing-memory read resolves null).
    const noCore = await readCoreMemory(join(sandbox.scratch, 'nowhere'));
    expect(noCore).toBeNull();
    expect(
      buildDispatcherPrompt({ projectPath: repo, activePrd: null, memoryCore: noCore }),
    ).not.toContain(CORE_MEMORY_LABEL);

    // --- A compact real drain: 02 completes, 05 parks HITL, user stops -----
    const two = sandboxIssue(2);
    await runFakeWorker({ repo, issue: two, exit: 'completed' });
    await waitForReceipt(2);
    await commitFinishedMain(repo, two.slug);
    const five = sandboxIssue(5);
    await runFakeWorker({ repo, issue: five, exit: 'needs-verification' });
    await waitForReceipt(5);
    await Promise.all(appends);
    const persisted = await store.read(repo);
    expect(persisted).toHaveLength(2);

    // --- Out: the drain end writes exactly ONE dated journal entry ---------
    const first = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-04T18:00:00.000Z',
      reason: 'Drain stopped by you — in-flight Runs keep going.',
      records: persisted,
      notables: [],
    });
    expect(first.written).toBe(true);
    expect(first.error).toBeNull();
    const journalRoot = join(memoryRoot, 'journal');
    expect(await readdir(journalRoot)).toEqual(['2026-07-04.md']);
    const entry = await readFile(first.path!, 'utf8');
    // The entry names every Run with its declared outcome.
    expect(entry).toContain(`${two.slug}: completed`);
    expect(entry).toContain(`${five.slug}: parked (needs manual verification)`);
    expect(entry).toContain('Drain stopped by you');

    // A second drain the same day gets its OWN entry; the first is untouched.
    const second = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-04T21:00:00.000Z',
      reason: 'Drain complete: no eligible issue remains.',
      records: [],
      notables: ['Adopted stray Receipt(s) on main: 06-parallel-a.md'],
    });
    expect(second.written).toBe(true);
    expect((await readdir(journalRoot)).sort()).toEqual(['2026-07-04-2.md', '2026-07-04.md']);
    expect(await readFile(first.path!, 'utf8')).toBe(entry);
    const secondEntry = await readFile(second.path!, 'utf8');
    expect(secondEntry).toContain('no Run reported a Receipt this drain');
    expect(secondEntry).toContain('Adopted stray Receipt(s) on main');
  });
});

// -----------------------------------------------------------------------------
// Manual-only checklist items — walkthrough 58 lines that genuinely require the
// live Electron shell. Declared here (as named, skipped specs) so the coverage
// gap is explicit in the suite output, never silent. Everything else above is
// machine-verified; a human walkthrough runs ONLY after this suite passes.
// -----------------------------------------------------------------------------
describe('manual-only — needs the live Electron shell (declared, not silently skipped)', () => {
  it.skip('manual-only: the Run-log CARD visibly renders the block sections — reason: React renderer UI; the record fields feeding the card are asserted in Scenario 1', () => {});
  it.skip('manual-only: the HITL notification is visually PROMINENT in the Dispatcher chat — reason: the live `claude` chat TUI renders it; typed+submitted delivery into the PTY is asserted in Scenario 2', () => {});
  it.skip('manual-only: passive notes appear in the ambient activities LOG panel — reason: renderer UI; channel routing (log, not chat) is asserted in Scenario 5', () => {});
  it.skip('manual-only: the Drain button spawns real `claude` Panes with the per-Run prompt — reason: needs Electron + an authenticated claude CLI; the coordinator plan driving it is asserted in Scenarios 3 and 5', () => {});
});

/** Read a Receipt file from the main checkout's completions dir. */
async function readReceipt(slug: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(repo, 'issues', 'completions', `${slug}.md`), 'utf8');
}
