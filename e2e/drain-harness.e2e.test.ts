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
 *   9. Merge previews      — issue 109 (ADR-0018): the assembled preview
 *                            pipeline (real serializer + coordinator + the
 *                            merge-tree simulation adapter) wired exactly as
 *                            index.ts wires it. 9a: after parallel scripted Runs
 *                            finish, each finished-unmerged branch carries a
 *                            badge before Merge is pressed (a clean batch), and a
 *                            clean Merge takes the badges away WITH the branches.
 *                            9b: an engineered second-branch conflict fixture —
 *                            first branch `clean`, second `conflicts` naming the
 *                            file, third `blocked behind` the second. (The full
 *                            verdict matrix lives in unit/integration tests; the
 *                            e2e proves only the feature is wired end-to-end —
 *                            the machine gate before any human QA.)
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
  commitFinishedWorktree,
  worktreePathFor,
  scanAfkBranches,
  isMidMerge,
  isMergedIntoDefaultBranch,
  reconcileMergedWorktrees,
  detectDefaultBranch,
  enableParallel,
  isParallel,
} from '../src/main/git-worktree-adapter';
import { mergeRuns, defaultMergeScriptPath } from '../src/main/run-merge';
import {
  probeMergeTreeSupport,
  readPreviewStamp,
  simulateSequence,
} from '../src/main/merge-preview-adapter';
import { createPreviewCoordinator } from '../src/main/merge-preview-coordinator';
import {
  scanReposWithPreviews,
  type RepoPreviewScanDeps,
  type ReposScanResult,
} from '../src/main/merge-preview-scan';
import { createRepoSerializer } from '../src/shared/repo-serializer';
import { sweepAutoMergeLane } from '../src/main/auto-merge-lane-executor';
import { normalizeProjectKey } from '../src/shared/project-registry';
import { previewBadge, type MergePreviewVerdict } from '../src/shared/merge-preview';
import { readCoreMemory, writeDrainJournal } from '../src/main/memory-files';
import { buildRunPrompt } from '../src/main/resolve-run-command';
import { buildDispatcherPrompt } from '../src/main/dispatcher-session';
import { CORE_MEMORY_LABEL } from '../src/shared/workbench-memory';
import {
  branchFor,
  decideIsolation,
  runNeedsIsolation,
  type IsolationRun,
} from '../src/shared/isolation-policy';
import { eligibleForRun } from '../src/shared/run-eligibility';
import {
  planDrain,
  soloChainedIssueIds,
  type ActiveRun,
  type DrainPlan,
} from '../src/shared/run-coordinator';
import { deriveRunStatus } from '../src/shared/run-state';
import { classifyBranch, deriveWorktreeRunStates } from '../src/shared/worktree-scan';
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
import { classifyAuthority, isProtectedBranch } from '../src/shared/dispatcher-authority';
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
  issueFileContent,
  SANDBOX_ISSUES,
  git,
  waitFor,
  sleep,
  FakePty,
  type Sandbox,
  type SandboxIssue,
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

// --- Merge-preview pipeline (issue 109, ADR-0018) ----------------------------
// The assembled scan drives the REAL preview machinery — no fakes on the preview
// path — so the e2e proves the feature is wired end-to-end, not just that the
// pure modules agree (that matrix is unit-/integration-tested).

/** A settled (displayable) verdict — not the transient recalculating/suspended. */
function isSettledVerdict(v: MergePreviewVerdict | null): boolean {
  return v !== null && v.kind !== 'recalculating' && v.kind !== 'suspended';
}

/**
 * Assemble the merge-preview scan deps EXACTLY as `index.ts` wires them: a
 * per-repo serializer, the coordinator (verdict cache + one coalesced recompute
 * per repo), and the real `merge-tree`/`commit-tree` simulation adapter. So a
 * scan through this is the same orchestration production runs — the coordinator
 * read queues its recompute through the serializer, then later reads return the
 * cached sequence verdicts.
 */
function realPreviewDeps(supported: boolean): RepoPreviewScanDeps {
  const serializer = createRepoSerializer();
  const coordinator = createPreviewCoordinator({
    serializer,
    isSupported: () => supported,
    simulate: (repoPath, stamp) => simulateSequence(repoPath, stamp),
  });
  return {
    scanBranches: async (r) =>
      (await scanAfkBranches(r)).map((b) => ({ ...b, repoPath: r })),
    isMidMerge,
    previewSupported: supported,
    detectDefaultBranch,
    readStamp: readPreviewStamp,
    readPreviews: (input) => coordinator.read(input),
    serializerKeyFor: (r) => normalizeProjectKey(r),
  };
}

/**
 * Drive the ~1.5 s scan poll the way the app does: re-read the assembled scan
 * until `done(scan)` holds. The first read finds a cold cache — every badge
 * `recalculating` — and queues ONE coalesced recompute through the serializer; a
 * later read returns the settled sequence verdicts. Throws with `label` on
 * timeout so a hang fails loudly.
 */
async function pollScan(
  deps: RepoPreviewScanDeps,
  done: (scan: ReposScanResult) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<ReposScanResult> {
  const deadline = Date.now() + timeoutMs;
  let scan = await scanReposWithPreviews([repo], deps);
  while (Date.now() < deadline) {
    if (done(scan)) return scan;
    await sleep(30);
    scan = await scanReposWithPreviews([repo], deps);
  }
  throw new Error(`pollScan timed out after ${timeoutMs}ms: ${label}`);
}

/**
 * Hand-build a finished-unmerged `afk/<slug>` branch off main: apply `edit` (the
 * branch's work), flip its issue file to `done`, and commit — the exact on-disk
 * shape a finished isolated Run leaves (committed `done`, unmerged), which the
 * scan reads as a Merge candidate. Used to engineer the conflict fixture (9b)
 * with precise per-branch edits the scripted Worker (unique files only) can't
 * produce.
 */
async function makeFinishedBranch(slug: string, edit: () => Promise<void>): Promise<void> {
  const issue = SANDBOX_ISSUES.find((i) => i.slug === slug);
  if (!issue) throw new Error(`no sandbox issue for slug ${slug}`);
  await git(repo, 'checkout', '-b', branchFor(slug), 'main');
  await edit();
  await writeFile(join(repo, 'issues', `${slug}.md`), issueFileContent(issue, 'done'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', `afk: complete ${slug}`);
  await git(repo, 'checkout', 'main');
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
  // Scenario 4b (issue 111) — a dependency chain stays SOLO on the integration
  // branch even while parallel mode is on for an unrelated leftover worktree, so
  // the dependent Run builds on its dependency's COMMITTED work rather than a
  // worktree cut from a stale base.
  // ---------------------------------------------------------------------------
  it('Scenario 4b: a dependency chain stays solo on the integration branch, so the dependent Run observes its dependency\'s committed work (issue 111)', async () => {
    ingestFrom(sandbox.issuesDir);

    // A leftover worktree from an unrelated pending merge keeps `.afk-parallel`
    // ON — the exact state that used to force every subsequent Run into a
    // worktree cut from the (stale) integration-branch HEAD.
    const leftover = sandboxIssue(7);
    await createWorktree(repo, leftover.slug, branchFor(leftover.slug));
    await runFakeWorker({ repo, worktree: worktreePathFor(repo, leftover.slug), issue: leftover });
    await enableParallel(repo);
    expect(isParallel(repo)).toBe(true);
    const leftoverRun = { issueId: 7, slug: leftover.slug }; // finished-unmerged, kept in the set

    // The chain: A = 02, B = 03 (`depends_on: [2]`). The coordinator marks both
    // as solo-on-integration-branch because they sit on a dependency edge among
    // not-done issues in the drain.
    const A = sandboxIssue(2);
    const B = sandboxIssue(3);
    const backlog = await readBacklog(repo);
    const solo = soloChainedIssueIds(backlog.issues);
    expect(solo.has(2)).toBe(true);
    expect(solo.has(3)).toBe(true);
    expect(solo.has(7)).toBe(false); // the leftover is independent

    // --- A's Run: placed SOLO on the integration branch despite parallel-on ---
    const isoA = await applyIsolation(repo, [
      leftoverRun,
      { issueId: 2, slug: A.slug, chained: solo.has(2) },
    ]);
    // The leftover keeps parallel mode on…
    expect(isoA.parallel).toBe(true);
    const placeA = isoA.placements.find((p) => p.issueId === 2)!;
    // …but the chained dependency lands SOLO on the integration branch, NOT a
    // worktree cut from a stale base — the core fix (pre-111 this was a worktree).
    expect(placeA.cwd).toBe(repo);
    expect(placeA.branch).toBeNull();
    // The unrelated leftover worktree is untouched (its pending merge is safe).
    expect(existsSync(worktreePathFor(repo, leftover.slug))).toBe(true);

    // A does its code work SOLO in the integration checkout and adds a symbol;
    // Mission Control owns the solo commit, landing it on the integration branch.
    await runFakeWorker({ repo, issue: A }); // solo: writes work/02-*.txt, flips done
    const symbolPath = join(repo, 'work', 'shared-symbol.ts');
    await writeFile(symbolPath, 'export const FROM_A = 111; // symbol A added\n');
    await waitForReceipt(2);
    const commitA = await commitFinishedMain(repo, A.slug);
    expect(commitA.committed).toBe(true);
    // A's symbol is now on the integration branch (main).
    expect(await git(repo, 'ls-files')).toContain('work/shared-symbol.ts');

    // --- B's Run: its base now includes A's committed work ---
    // 02 is done, so `soloChainedIssueIds` no longer forces 03 solo — but that's
    // safe precisely because 02 ran solo and its work is on the integration
    // branch, so 03's worktree (cut from that HEAD) or a solo 03 both see it
    // (issue 111 AC1's two allowed forms).
    const backlog2 = await readBacklog(repo);
    const isoB = await applyIsolation(repo, [
      leftoverRun,
      { issueId: 3, slug: B.slug, chained: soloChainedIssueIds(backlog2.issues).has(3) },
    ]);
    const placeB = isoB.placements.find((p) => p.issueId === 3)!;

    // The core assertion (issue 111 AC5): B's Run OBSERVED A's committed change —
    // A's symbol is present and readable in B's Run cwd, never missing because B
    // was cut from a base lacking its dependency's work.
    const seenByB = await readFile(join(placeB.cwd, 'work', 'shared-symbol.ts'), 'utf8');
    expect(seenByB).toContain('FROM_A');
    expect(existsSync(join(placeB.cwd, 'work', `${A.slug}.txt`))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4c (issue 135) — a /to-issues batch is three mutually-independent
  // issues plus one HITL batch-QA walkthrough that `depends_on` all of them and
  // stays not-done for the whole drain. The aggregator's edges are eligibility-
  // only, not build edges, so they must NOT solo-chain the batch: a cap-3 drain
  // fans all three out into their own worktrees on the very first plan tick,
  // rather than serializing behind a walkthrough that never lands.
  // ---------------------------------------------------------------------------
  it('Scenario 4c: a cap-3 drain over 3 independents under an HITL aggregator starts 3 parallel worktree Runs in the first tick (issue 135)', async () => {
    // Replace the seeded backlog with the batch fixture: three independent
    // non-HITL issues + one HITL aggregator depending on all three. Commit it so
    // HEAD (the worktree base) matches the working tree the Backlog Model reads.
    const batch: SandboxIssue[] = [
      { id: 2, slug: '02-independent-a', title: 'Independent A', status: 'open', dependsOn: [], hitl: false },
      { id: 4, slug: '04-independent-b', title: 'Independent B', status: 'open', dependsOn: [], hitl: false },
      { id: 6, slug: '06-independent-c', title: 'Independent C', status: 'open', dependsOn: [], hitl: false },
      { id: 9, slug: '09-batch-qa', title: 'Batch QA walkthrough (HITL)', status: 'open', dependsOn: [2, 4, 6], hitl: true },
    ];
    for (const name of await readdir(sandbox.issuesDir)) {
      await rm(join(sandbox.issuesDir, name));
    }
    for (const issue of batch) {
      await writeFile(join(sandbox.issuesDir, `${issue.slug}.md`), issueFileContent(issue, issue.status));
    }
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'e2e: batch fixture (3 independents + HITL aggregator)');

    const backlog = await readBacklog(repo);
    // Ground truth: 9 is HITL and depends on every batch issue.
    const aggregator = backlog.issues.find((i) => i.id === 9)!;
    expect(aggregator.hitl).toBe(true);
    expect(aggregator.dependsOn.sort((a, b) => a - b)).toEqual([2, 4, 6]);

    // Core of the fix: the aggregator's eligibility edges do NOT solo-chain any
    // endpoint — neither the three independents nor the aggregator itself.
    expect([...soloChainedIssueIds(backlog.issues)]).toEqual([]);

    // First plan tick, cap 3: all three independents are startable; the
    // aggregator is not eligible (deps not done) so it neither starts nor queues.
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 3, activeRuns: [] });
    expect(plan.startable).toEqual([2, 4, 6]);
    expect(plan.queued).toEqual([]);

    // Isolating those three startable Runs (none chained) cuts THREE worktrees
    // and turns parallel mode on — the "3 parallel worktree Runs" the AC demands,
    // instead of the pre-135 single integration-branch Run.
    const solo = soloChainedIssueIds(backlog.issues);
    const startableRuns = plan.startable.map((id) => {
      const issue = backlog.issues.find((i) => i.id === id)!;
      return { issueId: id, slug: issue.slug, chained: solo.has(id) };
    });
    const iso = await applyIsolation(repo, startableRuns);
    expect(iso.parallel).toBe(true);
    expect(iso.placements).toHaveLength(3);
    expect(iso.placements.every((p) => p.branch !== null)).toBe(true);
    for (const id of plan.startable) {
      const issue = backlog.issues.find((i) => i.id === id)!;
      expect(existsSync(worktreePathFor(repo, issue.slug))).toBe(true);
    }
    expect(isParallel(repo)).toBe(true);
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

  // ---------------------------------------------------------------------------
  // Scenario 9 — Merge previews (issue 109, ADR-0018). The minimal badge
  // assertions that prove the feature is wired end-to-end in the ASSEMBLED drain
  // flow (machine-before-human rule): after parallel scripted Runs finish, every
  // finished-unmerged branch carries a preview badge BEFORE Merge is pressed, and
  // a clean Merge removes the badges WITH the branches. The preview machinery is
  // the real one — the per-repo serializer, the coordinator (cache + coalesced
  // recompute), and the `merge-tree` simulation adapter — assembled exactly as
  // index.ts assembles it; only the ~1.5 s poll is driven by the harness. The
  // full verdict matrix stays in the unit/integration suites (PRD Testing
  // Decisions); the e2e proves only that finished Runs produce badges here.
  // ---------------------------------------------------------------------------
  it('Scenario 9: parallel Runs finish → each finished-unmerged branch carries a badge; a clean Merge takes the badges with the branches', async () => {
    const supported = await probeMergeTreeSupport();
    expect(supported, 'git ≥ 2.38 required for merge previews').toBe(true);

    // Two parallel scripted Runs, exactly as Scenario 4: real isolation, real
    // worktrees, well-behaved Workers that commit their own work + Receipt.
    const six = sandboxIssue(6);
    const seven = sandboxIssue(7);
    const iso = await applyIsolation(repo, [
      { issueId: 6, slug: six.slug },
      { issueId: 7, slug: seven.slug },
    ]);
    expect(iso.parallel).toBe(true);
    const wt6 = worktreePathFor(repo, six.slug);
    const wt7 = worktreePathFor(repo, seven.slug);
    ingestFrom(sandbox.issuesDir, join(wt6, 'issues'), join(wt7, 'issues'));
    await runFakeWorker({ repo, worktree: wt6, issue: six });
    await runFakeWorker({ repo, worktree: wt7, issue: seven });
    await waitForReceipt(6);
    await waitForReceipt(7);

    // Ground truth before Merge: both branches are finished-unmerged (the
    // candidates a badge must cover).
    const facts = await scanAfkBranches(repo);
    const finishedUnmerged = facts
      .filter((f) => f.committedStatus === 'done' && !f.mergedIntoMain)
      .map((f) => f.issueId)
      .sort((a, b) => a - b);
    expect(finishedUnmerged).toEqual([6, 7]);

    // Drive the assembled scan until the cold-cache `recalculating` badges settle.
    const deps = realPreviewDeps(supported);
    const before = await pollScan(
      deps,
      (s) => s.previews.length === 2 && s.previews.every((p) => isSettledVerdict(p.verdict)),
      'clean-batch previews settle before Merge',
    );

    // AC1: every finished-unmerged branch carries a badge — a real verdict, one
    // per candidate, no orphan row. This disjoint batch is `clean`.
    expect(before.previews.map((p) => p.issueId).sort((a, b) => a - b)).toEqual(finishedUnmerged);
    for (const p of before.previews) {
      expect(p.verdict).toEqual({ kind: 'clean' });
      expect(previewBadge(p.verdict!).tone).toBe('clean');
    }
    expect(before.midMerge).toBe(false);

    // Clean Merge via the REAL afk-merge.sh: both branches land AND are removed.
    const result = await mergeRuns(repo, [six.slug, seven.slug], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged.sort()).toEqual([six.slug, seven.slug]);

    // AC3: with the branches gone, so are their badges — the scan finds no
    // finished-unmerged candidate, so it reads (and caches) no preview for them.
    const after = await pollScan(
      deps,
      (s) => s.branches.every((b) => b.slug !== six.slug && b.slug !== seven.slug),
      'merged branches gone from the scan',
    );
    expect(after.branches.some((b) => b.slug === six.slug || b.slug === seven.slug)).toBe(false);
    expect(after.previews).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Scenario 9b — the engineered second-branch conflict (issue 109, AC2). Three
  // finished Runs whose SEQUENTIAL merge (ascending issue id, what pressing Merge
  // does) yields the tell-tale shape: the first branch `clean`, the second
  // `conflicts` naming the file, the third `blocked behind` the second — the
  // pairwise-wrong case (each merges clean against main, but the second collides
  // with the first once it lands) that motivated sequential simulation. The
  // conflict is engineered per-branch, so it's a hand-built fixture rather than
  // scripted Workers (which only ever write unique per-slug files).
  // ---------------------------------------------------------------------------
  it('Scenario 9b: an engineered second-branch conflict — first clean, second conflicts (named file), third blocked behind it', async () => {
    const supported = await probeMergeTreeSupport();
    expect(supported, 'git ≥ 2.38 required for merge previews').toBe(true);

    // A shared file on main that the two early branches edit differently.
    await writeFile(join(repo, 'conflict-target.txt'), 'top\nMIDDLE\nbottom\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'seed conflict-target on main');

    // Three finished Runs in the fixed merge order (ascending id: 4, 6, 7): 04
    // edits the middle line, 06 edits the SAME line differently, 07 touches a
    // disjoint file. Sequentially 04 lands clean, 06 then conflicts on
    // conflict-target, and 07 never merges (blocked behind 06).
    await makeFinishedBranch('04-independent', async () => {
      await writeFile(join(repo, 'conflict-target.txt'), 'top\nFROM-04\nbottom\n');
    });
    await makeFinishedBranch('06-parallel-a', async () => {
      await writeFile(join(repo, 'conflict-target.txt'), 'top\nFROM-06\nbottom\n');
    });
    await makeFinishedBranch('07-parallel-b', async () => {
      await writeFile(join(repo, 'disjoint.txt'), 'only 07 touches this\n');
    });

    const deps = realPreviewDeps(supported);
    const scan = await pollScan(
      deps,
      (s) => s.previews.length === 3 && s.previews.every((p) => isSettledVerdict(p.verdict)),
      'conflict-fixture previews settle',
    );

    const byId = new Map(scan.previews.map((p) => [p.issueId, p.verdict!]));
    // First branch: clean (nothing conflicts with the sequence head).
    expect(byId.get(4)).toEqual({ kind: 'clean' });
    // Second branch: conflicts, naming at least the shared file.
    const second = byId.get(6)!;
    expect(second.kind).toBe('conflicts');
    if (second.kind === 'conflicts') {
      expect(second.files).toContain('conflict-target.txt');
    }
    // Third branch: blocked behind the second — no speculative verdict past the stop.
    expect(byId.get(7)).toEqual({ kind: 'blocked', behindIssueId: 6 });

    // The human-facing badge each verdict renders (the renderer's input).
    expect(previewBadge(byId.get(4)!).tone).toBe('clean');
    expect(previewBadge(second).label).toContain('conflict-target.txt');
    expect(previewBadge(byId.get(7)!).label).toBe('blocked behind 06');

    // Not mid-merge; the engineered conflict didn't smear an artifact verdict.
    expect(scan.midMerge).toBe(false);
    expect(scan.previews.some((p) => p.verdict?.kind === 'artifact')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 12 — issue 136: a parallel drain in a repo WITH node_modules present
  // provisions each worktree's deps from the main checkout (no network install),
  // and — because the provisioned node_modules stays git-ignored — produces NO
  // artifact-hygiene refusal and NO node_modules content on any afk/ branch. This
  // closes the recurring "won't merge — adds install artifacts" failure at the
  // isolation boundary. Drives the REAL applyIsolation adapter, real fake Workers,
  // the real preview scan, and the real afk-merge.sh.
  // ---------------------------------------------------------------------------
  it('Scenario 12 (issue 136): a parallel drain provisions node_modules into each worktree — no artifact refusal, no node_modules on any afk/ branch', async () => {
    const supported = await probeMergeTreeSupport();
    expect(supported, 'git ≥ 2.38 required for merge previews').toBe(true);

    // A real Node repo commits a .gitignore that ignores node_modules; the main
    // checkout then holds an installed node_modules (untracked, ignored).
    await writeFile(join(repo, '.gitignore'), 'node_modules\n');
    await git(repo, 'add', '.gitignore');
    await git(repo, 'commit', '-m', 'ignore node_modules');
    await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(repo, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => "installed";\n',
    );

    const six = sandboxIssue(6);
    const seven = sandboxIssue(7);

    // A parallel drain cuts a worktree per Run — provisioning runs as part of it.
    const iso = await applyIsolation(repo, [
      { issueId: 6, slug: six.slug },
      { issueId: 7, slug: seven.slug },
    ]);
    expect(iso.parallel).toBe(true);
    const wt6 = worktreePathFor(repo, six.slug);
    const wt7 = worktreePathFor(repo, seven.slug);

    // AC1 (e2e): each worktree's deps are present WITHOUT a network install.
    expect(existsSync(join(wt6, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(join(wt7, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

    // Well-behaved Workers finish and commit on their afk/ branches (git add -A).
    await runFakeWorker({ repo, worktree: wt6, issue: six });
    await runFakeWorker({ repo, worktree: wt7, issue: seven });
    expect((await readIsolatedIssueStatus(repo, six.slug)).status).toBe('done');
    expect((await readIsolatedIssueStatus(repo, seven.slug)).status).toBe('done');

    // The provisioned node_modules never entered tracked scope on either branch —
    // .gitignore kept `git add -A` from staging it (issue 98 hazard, closed).
    for (const wt of [wt6, wt7]) {
      const tracked = (await git(wt, 'ls-files')).split('\n');
      expect(tracked.some((p) => p.split('/').includes('node_modules'))).toBe(false);
      // The worktree tree is clean too — provisioning dirtied nothing.
      expect((await git(wt, 'status', '--porcelain')).trim()).toBe('');
    }

    // So the merge preview finds NO artifact verdict (the "adds install
    // artifacts" refusal never fires) — both branches badge a clean sequence.
    const scan = await pollScan(
      realPreviewDeps(supported),
      (s) => s.previews.length === 2 && s.previews.every((p) => isSettledVerdict(p.verdict)),
      'issue-136 provisioned previews settle',
    );
    expect(scan.previews.some((p) => p.verdict?.kind === 'artifact')).toBe(false);
    expect(scan.previews.every((p) => p.verdict?.kind === 'clean')).toBe(true);

    // And the REAL afk-merge.sh integrates both cleanly — no artifact refusal —
    // leaving main with NO node_modules tracked.
    const result = await mergeRuns(repo, [six.slug, seven.slug], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged.slice().sort()).toEqual([six.slug, seven.slug].slice().sort());
    const mainTracked = (await git(repo, 'ls-files')).split('\n');
    expect(mainTracked.some((p) => p.split('/').includes('node_modules'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 10 — issue 113: merge targets the branch you're on, and landing on a
  // protected branch STOPS for the "big warning". Drives the REAL afk-merge.sh
  // (with MC's `--into` current-branch targeting) and the assembled guard exactly
  // as the drain wires it — the machine gate before any human QA.
  // ---------------------------------------------------------------------------
  it('Scenario 10a (issue 113 Part A): a FEATURE-branch checkout integrates afk/ branches into that feature branch, never forced main', async () => {
    // The repo sits on a feature branch while `main` still exists locally — the
    // exact shape pre-113 afk-merge.sh refused with a "wrong branch" preflight.
    await git(repo, 'checkout', '-b', 'feature/ship');
    const six = sandboxIssue(6);

    // A finished-unmerged Run in a worktree off the feature branch.
    const wt = worktreePathFor(repo, six.slug);
    await createWorktree(repo, six.slug, branchFor(six.slug));
    await mkdir(join(wt, 'work'), { recursive: true });
    await writeFile(join(wt, 'work', `${six.slug}.txt`), 'feature-branch work\n');
    await writeFile(join(wt, 'issues', `${six.slug}.md`), issueFileContent(six, 'done'));
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', `afk: complete ${six.slug}`);

    // MC detects the CURRENT branch and passes it to afk-merge.sh via --into.
    expect(await detectDefaultBranch(repo)).toBe('feature/ship');
    const result = await mergeRuns(repo, [six.slug], { scriptPath: SCRIPT });

    // No "wrong branch" refusal: it integrates into the feature branch.
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual([six.slug]);
    expect(result.message).toContain('into feature/ship');
    expect(result.message).not.toContain('into main');

    // The work landed on the feature branch; `main` never received it.
    await git(repo, 'checkout', 'feature/ship');
    expect(await git(repo, 'ls-files')).toContain(`work/${six.slug}.txt`);
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain(`work/${six.slug}.txt`);
  });

  it('Scenario 10b (issue 113 Part B): landing on protected main is a blocking gate — nothing lands until confirmed', async () => {
    // The sandbox repo is on `main` (protected). The drain composes the gate
    // exactly as App.tsx does: a protected target → a `protected-branch-land`
    // action → blocking (the drain STOPS for the "big warning").
    const branch = await detectDefaultBranch(repo);
    expect(branch).toBe('main');
    expect(isProtectedBranch(branch)).toBe(true);
    expect(classifyAuthority('protected-branch-land')).toBe('blocking');

    // A finished-unmerged Run ready to integrate onto main.
    const six = sandboxIssue(6);
    const wt = worktreePathFor(repo, six.slug);
    await createWorktree(repo, six.slug, branchFor(six.slug));
    await mkdir(join(wt, 'work'), { recursive: true });
    await writeFile(join(wt, 'work', `${six.slug}.txt`), 'main-bound work\n');
    await writeFile(join(wt, 'issues', `${six.slug}.md`), issueFileContent(six, 'done'));
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', `afk: complete ${six.slug}`);
    const baseline = await commitCount();

    // The guarded merge WITHHOLDS: nothing lands on main, and the result names the
    // protected branch so the drain raises the gate (declining leaves it here).
    const withheld = await mergeRuns(repo, [six.slug], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: false },
    });
    expect(withheld.ok).toBe(false);
    expect(withheld.conflicted).toBe(false);
    expect(withheld.protectedBranch).toBe('main');
    expect(withheld.merged).toEqual([]);
    expect(await commitCount()).toBe(baseline); // main untouched
    expect(existsSync(wt)).toBe(true); // work waits on its worktree/branch
    // The afk/ branch survives for the confirmed retry (rev-parse succeeds).
    await expect(
      git(repo, 'rev-parse', '--verify', '--quiet', branchFor(six.slug)),
    ).resolves.toBeDefined();
    expect(await git(repo, 'ls-files')).not.toContain(`work/${six.slug}.txt`);

    // Approving the "big warning" re-runs WITH confirmation → the work lands.
    const confirmed = await mergeRuns(repo, [six.slug], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: true },
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.merged).toEqual([six.slug]);
    expect(confirmed.protectedBranch ?? null).toBeNull();
    expect(await git(repo, 'ls-files')).toContain(`work/${six.slug}.txt`);
  });

  // ---------------------------------------------------------------------------
  // Scenario 11 — issue 132: a leftover Pane from a PRIOR drain must not wedge a
  // fresh drain. The reported bug: two `claude` Panes from yesterday's drain
  // lingered alive at their prompt having neither flipped `done` nor written a
  // Receipt, so run-state read them `running` forever. A fresh cap-3 drain over
  // three eligible issues then computed one free slot, started ONE Run,
  // never toggled `.afk-parallel`, cut no worktrees, and the queue starved. This
  // drives the SAME composition App.tsx wires (the drive-loop's leftover
  // derivation → planDrain → decideIsolation), proving the fix end-to-end.
  // ---------------------------------------------------------------------------
  it('Scenario 11 (issue 132): two leftover phantom Panes from a prior drain do not shrink a fresh drain — all three eligible issues start in parallel', async () => {
    const backlog = await readBacklog(repo);
    // The real sandbox has ≥3 eligible issues (open, deps met), enough to fill
    // a cap-3 drain. (Some are chain roots — the sandbox's 02/05 — so isolation
    // places those solo; the point here is the SLOT budget, proven below.)
    const eligibleCount = backlog.issues.filter((i) => eligibleForRun(i, backlog.issues)).length;
    expect(eligibleCount).toBeGreaterThanOrEqual(3);

    // The drive-loop's activeRuns derivation (App.tsx), verbatim: a Run started
    // by an EARLIER drain generation (99/105, generation 1) is `leftover`; the
    // fresh drain runs under generation 2. Both phantoms still read `running`.
    const priorGeneration = 1;
    const currentGeneration = 2;
    const trackedRuns = [
      { issueId: 99, status: 'running' as const, drainGeneration: priorGeneration },
      { issueId: 105, status: 'running' as const, drainGeneration: priorGeneration },
    ];
    const activeRuns: ActiveRun[] = trackedRuns.map((r) => ({
      issueId: r.issueId,
      status: r.status,
      leftover: r.drainGeneration !== null && r.drainGeneration < currentGeneration,
    }));

    // The fix: with the two phantoms marked leftover, a cap-3 drain uses its FULL
    // budget (three Runs start), and no lingering leftover halts it.
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 3, activeRuns });
    expect(plan.drain.stop).toBe(false); // a lingering leftover never halts it
    expect(plan.startable).toHaveLength(3);

    // And the isolation decision the drive loop feeds the adapter flips parallel
    // ON and cuts a worktree for each genuinely-independent startable Run — the
    // ".afk-parallel toggled, worktrees created" the report said never happened.
    const solo = soloChainedIssueIds(backlog.issues);
    const isolationRuns: IsolationRun[] = plan.startable.map((id) => {
      const issue = backlog.issues.find((i) => i.id === id)!;
      return { issueId: id, slug: issue.slug, chained: solo.has(id) };
    });
    const decision = decideIsolation(isolationRuns);
    expect(decision.parallel).toBe(true);
    // Every independent (non-chained) startable Run lands in its own worktree.
    for (const placed of decision.placements) {
      const expectWorktree = !solo.has(placed.issueId);
      expect(placed.placement.kind).toBe(expectWorktree ? 'worktree' : 'main');
    }
    expect(decision.placements.some((p) => p.placement.kind === 'worktree')).toBe(true);

    // Control: WITHOUT the leftover marking the two phantoms eat two of three
    // slots and only ONE Run starts — the exact reported failure, proving the
    // leftover flag is what fixes it (not some incidental change).
    const regressed = planDrain({
      issues: backlog.issues,
      maxConcurrent: 3,
      activeRuns: trackedRuns.map((r) => ({ issueId: r.issueId, status: r.status })),
    });
    expect(regressed.startable).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 12 — issue 134: the drive loop must scope its isolation set to
  // LIVE + FINISHED-UNMERGED Runs. The reported bug: it fed EVERY tracked Run in,
  // including terminal ones lingering on screen. Once a finished CHAINED Run's
  // dependency edge resolved (so it stops counting as chained), the unscoped set
  // handed it a spurious worktree cut and kept `.afk-parallel` enabled round
  // after round. This drives the SAME composition App.tsx wires — the drive
  // loop's `needsIsolation` scoping (`runNeedsIsolation`) → soloChainedIssueIds →
  // decideIsolation → the real applyIsolation adapter — proving the fix on disk.
  // ---------------------------------------------------------------------------
  it('Scenario 12 (issue 134): a finished chained Run whose edge resolved is scoped out — no spurious worktree, no .afk-parallel stuck on across rounds', async () => {
    ingestFrom(sandbox.issuesDir);

    // The 02→03 chain from a PRIOR drain round: 02 (the root) ran SOLO on main
    // (chained) and finished. Flip it `done` on disk so its edge to 03 has now
    // resolved — the exact state that used to un-chain 02 and expose the bug.
    const A = sandboxIssue(2); // 02-second-step — finished, terminal, on main
    const B = sandboxIssue(3); // 03-blocked-on-02 — now unblocked and live
    await writeFile(join(repo, 'issues', `${A.slug}.md`), issueFileContent(A, 'done'));
    const backlog = await readBacklog(repo);
    const solo = soloChainedIssueIds(backlog.issues);
    // 02 is done and 03's only dependency is satisfied → NEITHER is chained now.
    expect(solo.has(2)).toBe(false);
    expect(solo.has(3)).toBe(false);

    // The drive loop's tracked Runs this round, reduced to the two membership
    // facts App.tsx derives per Run (`runStatusOf === 'running'` → live, and
    // `isIsolated` → in a worktree): 02 lingers TERMINAL (finished, solo on main)
    // while 03 is LIVE (running, solo on main). Neither is in a worktree.
    const trackedRuns = [
      { issueId: 2, slug: A.slug, live: false, isolated: false }, // finished on main
      { issueId: 3, slug: B.slug, live: true, isolated: false }, // running on main
    ];

    // --- The fix: scope the tracked Runs through `runNeedsIsolation` (exactly
    // what App.tsx's `needsIsolation` does in the drive loop) ---
    const scoped: IsolationRun[] = trackedRuns
      .filter((r) => runNeedsIsolation(r))
      .map((r) => ({ issueId: r.issueId, slug: r.slug, chained: solo.has(r.issueId) }));
    // The terminal solo Run 02 drops out; only the live 03 survives.
    expect(scoped.map((r) => r.issueId)).toEqual([3]);
    const fixed = decideIsolation(scoped);
    expect(fixed.parallel).toBe(false);
    expect(fixed.placements).toEqual([
      { issueId: 3, slug: B.slug, placement: { kind: 'main' } },
    ]);

    // Drive TWO rounds through the REAL adapter on a clean tree: no worktree is
    // ever cut (not for the finished 02, not for the solo 03) and `.afk-parallel`
    // never turns on — nothing accumulates across drain rounds (AC2).
    for (let round = 0; round < 2; round++) {
      const applied = await applyIsolation(repo, scoped);
      expect(applied.parallel).toBe(false);
      expect(existsSync(worktreePathFor(repo, A.slug))).toBe(false);
      expect(existsSync(worktreePathFor(repo, B.slug))).toBe(false);
      expect(isParallel(repo)).toBe(false);
    }

    // --- Control (the reported bug): feed EVERY tracked Run in, unscoped ---
    // 02 (now un-chained) joins 03 → two independent Runs → parallel flips ON and
    // the FINISHED Run 02 is handed a worktree it should never get. This is the
    // exact regression the scoping above prevents.
    const unscoped: IsolationRun[] = trackedRuns.map((r) => ({
      issueId: r.issueId,
      slug: r.slug,
      chained: solo.has(r.issueId),
    }));
    const regressedDecision = decideIsolation(unscoped);
    expect(regressedDecision.parallel).toBe(true);
    expect(regressedDecision.placements.find((p) => p.issueId === 2)?.placement.kind).toBe(
      'worktree',
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 13 — issue 153: a GHOST completion commit on an already-merged
  // afk/ branch, and its lingering worktree. The live 2026-07-17 incident:
  // afk/138 was merged into main, yet its worktree survived, and a later
  // observe/recovery tick auto-committed the worktree's STALE tree as a fresh
  // "afk: complete issue 138" commit (`fddc618`). That ghost moved the branch
  // tip off main's history (re-badging the Run finished-unmerged) and, being
  // BEHIND the merge, the Merge press then walked the human toward reverting the
  // day's doc work. This drives the REAL observe/commit + cleanup seam and
  // asserts: no ghost commit lands, no finished-unmerged badge reappears, and
  // the lingering merged worktree + branch are reclaimed.
  // ---------------------------------------------------------------------------
  it('Scenario 13a (issue 153): a recovery tick over a lingering merged worktree writes no ghost commit and shows no finished-unmerged badge', async () => {
    ingestFrom(sandbox.issuesDir);
    const six = sandboxIssue(6);
    const wt = worktreePathFor(repo, six.slug);
    const branch = branchFor(six.slug);

    // A finished isolated Run: worktree work + done flip, committed onto its
    // branch by MC's real auto-commit (this is what lands the completion commit).
    await createWorktree(repo, six.slug, branch);
    await runFakeWorker({ repo, worktree: wt, issue: six });
    const obs = await readIsolatedIssueStatus(repo, six.slug);
    expect(obs.status).toBe('done');
    const defaultBranch = await detectDefaultBranch(repo);
    expect(await isMergedIntoDefaultBranch(repo, six.slug, defaultBranch)).toBe(false);

    // The "day's doc work" lands on main directly — so main advances beyond the
    // base the worktree was cut with (the incident's CONTEXT.md + configs).
    await writeFile(join(repo, 'CONTEXT.md'), '# Context\n' + 'doc line\n'.repeat(30));
    await git(repo, 'add', 'CONTEXT.md');
    await git(repo, 'commit', '-m', 'docs: grow CONTEXT.md (the day\'s doc work)');

    // Merge the branch into main but DELIBERATELY keep the worktree (cleanup:
    // false) — reproducing "the worktree survived the merge".
    const merge = await mergeRuns(repo, [six.slug], { scriptPath: SCRIPT, cleanup: false });
    expect(merge.ok).toBe(true);
    expect(merge.merged).toEqual([six.slug]);
    expect(await isMergedIntoDefaultBranch(repo, six.slug, defaultBranch)).toBe(true);
    expect(existsSync(wt)).toBe(true); // lingered

    // A residual uncommitted change appears in the lingering worktree (a late
    // Receipt / re-touched file) — the trigger a real observe/recovery tick sees.
    await writeFile(join(wt, 'late-residue.txt'), 'residue in a lingering worktree\n');

    const tipBefore = (await git(repo, 'rev-parse', branch)).trim();

    // The recovery tick, BOTH observe paths the app runs:
    //  - IssueStatusObserve → readIsolatedIssueStatus → commitFinishedWorktree
    //  - WorktreeCommit (workbench) → commitFinishedWorktree with statusOverride
    const recover1 = await readIsolatedIssueStatus(repo, six.slug);
    const recover2 = await commitFinishedWorktree(repo, six.slug, { statusOverride: 'done' });

    // No ghost commit: both refuse, the branch tip is unmoved, and it stays merged.
    expect(recover2.committed).toBe(false);
    expect(recover2.error).toBeNull();
    expect((await git(repo, 'rev-parse', branch)).trim()).toBe(tipBefore);
    expect(await isMergedIntoDefaultBranch(repo, six.slug, defaultBranch)).toBe(true);
    // The observe still reports the Run done (its work is on main) — it just
    // never re-commits.
    expect(recover1.status).toBe('done');

    // No finished-unmerged badge: the scan classifies the merged branch as
    // integrated (null), never finished-unmerged.
    const facts = await scanAfkBranches(repo);
    const f6 = facts.find((f) => f.slug === six.slug)!;
    expect(f6.mergedIntoMain).toBe(true);
    expect(classifyBranch(f6, [])).toBeNull();
    expect(deriveWorktreeRunStates(facts, []).find((s) => s.slug === six.slug)).toBeUndefined();

    // Main still holds the day's doc work — nothing regressed it.
    expect((await git(repo, 'show', `main:CONTEXT.md`)).split('\n').length).toBeGreaterThan(20);
  });

  it('Scenario 13b (issue 153): a dirty lingering merged worktree + branch are reclaimed by post-merge cleanup', async () => {
    ingestFrom(sandbox.issuesDir);
    const six = sandboxIssue(6);
    const wt = worktreePathFor(repo, six.slug);
    const branch = branchFor(six.slug);

    // A finished isolated Run committed onto its branch.
    await createWorktree(repo, six.slug, branch);
    await runFakeWorker({ repo, worktree: wt, issue: six });
    expect((await readIsolatedIssueStatus(repo, six.slug)).status).toBe('done');

    // The worktree is DIRTY at merge time (an untracked leftover) — the exact
    // state that made a non-force remove refuse and the worktree linger.
    await writeFile(join(wt, 'untracked-leftover.txt'), 'stale scratch\n');

    // A full merge (cleanup ON): its work lands on main AND the just-merged,
    // dirty worktree is force-removed with its branch — no lingering residue.
    const merge = await mergeRuns(repo, [six.slug], { scriptPath: SCRIPT });
    expect(merge.ok).toBe(true);
    expect(merge.merged).toEqual([six.slug]);
    expect(existsSync(wt)).toBe(false);
    await expect(
      git(repo, 'rev-parse', '--verify', '--quiet', branch),
    ).rejects.toBeTruthy(); // branch deleted
    expect(await git(repo, 'ls-files')).toContain(`work/${six.slug}.txt`);

    // And the standalone reconcile sweep is idempotent + also reclaims a dirty
    // merged worktree left by another route (cleanup:false), not just the merge's
    // own slugs.
    const seven = sandboxIssue(7);
    const wt7 = worktreePathFor(repo, seven.slug);
    await createWorktree(repo, seven.slug, branchFor(seven.slug));
    await runFakeWorker({ repo, worktree: wt7, issue: seven });
    await readIsolatedIssueStatus(repo, seven.slug);
    await mergeRuns(repo, [seven.slug], { scriptPath: SCRIPT, cleanup: false }); // lingers
    await writeFile(join(wt7, 'untracked-leftover.txt'), 'stale scratch\n'); // dirty
    expect(existsSync(wt7)).toBe(true);

    const swept = await reconcileMergedWorktrees(repo);
    expect(swept.reclaimed).toContain(seven.slug);
    expect(swept.leftBehind).toEqual([]);
    expect(existsSync(wt7)).toBe(false);
    await expect(
      git(repo, 'rev-parse', '--verify', '--quiet', branchFor(seven.slug)),
    ).rejects.toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Scenario 14 — issue 145 (ADR-0021): the auto-merge lane's walking skeleton.
  // A Run finishes on ONE clean, Receipt-backed branch and, on the Run-finish
  // sweep, the branch MERGES ITSELF into main within a single sweep — a silent
  // + passive `merge` note, NO blocking approval. The lane executor is assembled
  // exactly as index.ts would wire it: the real preview pipeline (serializer +
  // coordinator + merge-tree simulation) as the go/no-go, the real `afk-merge.sh`
  // under the per-repo serializer, and the ingested Receipts as the Run log. The
  // issue's `done`, the Receipt on disk, and the Run log are unchanged in shape by
  // the auto-merge (a clean lane merge lands what a manual Merge would, and writes
  // no journal / no new record). Ordering, pause, and skip are issue 146; the
  // Merge button path (Scenarios 4/9/10) is untouched.
  // ---------------------------------------------------------------------------
  it('Scenario 14 (issue 145): a finished, clean, Receipt-backed branch merges itself in one sweep — passive note, no gate', async () => {
    const supported = await probeMergeTreeSupport();
    expect(supported, 'git ≥ 2.38 required for merge previews').toBe(true);

    // A single finished isolated Run: a worktree on afk/06-…, a well-behaved
    // scripted Worker that commits its work + done flip + Receipt onto the branch.
    const six = sandboxIssue(6);
    const wt = worktreePathFor(repo, six.slug);
    await createWorktree(repo, six.slug, branchFor(six.slug));
    // Watch the worktree's completions so the Worker's Receipt ingests LIVE — the
    // Run-finish event that fires the lane sweep.
    ingestFrom(sandbox.issuesDir, join(wt, 'issues'));
    await runFakeWorker({ repo, worktree: wt, issue: six });
    const rec = await waitForReceipt(6);
    expect(rec.outcome).toBe('completed');
    expect(rec.id.startsWith(`receipt:${six.slug}:`)).toBe(true);

    // Ground truth: the branch is finished-unmerged and Receipt-backed, and main
    // is idle (clean tree, not mid-merge). The exact state the lane merges from.
    const defaultBranch = await detectDefaultBranch(repo);
    expect(await isMergedIntoDefaultBranch(repo, six.slug, defaultBranch)).toBe(false);
    const preFacts = await scanAfkBranches(repo);
    expect(preFacts.find((f) => f.slug === six.slug)?.committedStatus).toBe('done');
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    expect(await isMidMerge(repo)).toBe(false);
    const baselineRecords = records.length;

    // Warm the REAL preview pipeline until the branch stamps `clean` — the app's
    // ~1.5 s poll settling the go/no-go verdict before the lane consults it.
    const previewDeps = realPreviewDeps(supported);
    await pollScan(
      previewDeps,
      (s) => s.previews.length === 1 && s.previews[0].verdict?.kind === 'clean',
      'issue-145 clean preview settles before the sweep',
    );

    // Fire ONE lane sweep on the Run-finish, assembled as index.ts would wire it:
    // the real preview scan as go/no-go, the ingested Receipts as the Run log, the
    // real afk-merge.sh under the shared per-repo serializer.
    const laneSerializer = createRepoSerializer();
    const mergeCalls: string[][] = [];
    const outcome = await sweepAutoMergeLane({
      scan: async () => {
        const s = await scanReposWithPreviews([repo], previewDeps);
        return { branches: s.branches, previews: s.previews, midMerge: s.midMerge };
      },
      isCleanTree: async () => (await git(repo, 'status', '--porcelain')).trim() === '',
      hasLiveSoloRun: () => false,
      runLog: records,
      merge: (slugs) => {
        mergeCalls.push(slugs);
        return mergeRuns(repo, slugs, { scriptPath: SCRIPT });
      },
      serializer: laneSerializer,
      serializerKey: normalizeProjectKey(repo),
    });

    // The branch merged ITSELF in one sweep — a clean auto-merge classified as the
    // passive `merge` note (silent + note), never a blocking approval.
    expect(outcome.kind).toBe('swept');
    if (outcome.kind !== 'swept') throw new Error('lane held instead of merging');
    expect(outcome.slug).toBe(six.slug);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.conflicted).toBe(false);
    expect(outcome.result.merged).toEqual([six.slug]);
    expect(mergeCalls).toEqual([[six.slug]]); // exactly one merge, the chosen branch
    expect(outcome.decision).toEqual({
      kind: 'auto',
      action: 'merge',
      note: outcome.result.message,
    });
    if (outcome.decision.kind !== 'auto') throw new Error('expected a clean auto-merge decision');
    // No gate: the `merge` note sits on the passive (non-blocking) tier (ADR-0011).
    expect(classifyAuthority('merge')).toBe('passive');
    expect(classifyAuthority(outcome.decision.action)).not.toBe('blocking');

    // The work is on main and the branch is integrated + reclaimed (clean merge).
    expect(await git(repo, 'ls-files')).toContain(`work/${six.slug}.txt`);
    expect(await git(repo, 'ls-files')).toContain(`issues/completions/${six.slug}.md`);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    expect(await isMidMerge(repo)).toBe(false);
    const postFacts = await scanAfkBranches(repo);
    expect(postFacts.find((f) => f.slug === six.slug)?.mergedIntoMain ?? true).toBe(true);

    // Unchanged in shape: the issue reads `done` on main (what a manual Merge lands
    // too), the Receipt survived byte-for-byte (its post-merge copy on main deduped
    // — no new Run-log record), and the lane wrote no journal artifact.
    const backlog = await readBacklog(repo);
    expect(backlog.issues.find((i) => i.id === 6)?.status).toBe('done');
    const receiptOnMain = await readReceipt(six.slug);
    expect(parseReceipt(receiptOnMain).outcome).toBe('completed');
    await sleep(150); // let any (wrong) re-ingest of the merged-in Receipt appear
    expect(records.filter((r) => r.issueId === 6)).toHaveLength(1);
    expect(records.length).toBe(baselineRecords);
    expect(existsSync(join(sandbox.scratch, 'workbench'))).toBe(false); // no journal side effect
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
