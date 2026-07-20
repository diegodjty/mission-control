/**
 * E2E telemetry persistence regression (issue 177) — closes the blind spot
 * that let issue 143's telemetry ship with usage NEVER actually persisted:
 * every unit and e2e test up to now exercised only the pure extraction/fold
 * (`run-telemetry.ts`, `headless-run.e2e.test.ts`'s `finalContent.result`),
 * never the durable path. This suite drives the REAL `RunLogStore`, the REAL
 * `ReceiptWatcher` (including a genuine double-read — a second independently-
 * seeded watch instance re-scanning the same Receipt, exactly like two open
 * Windows on one Project, or an MC restart re-scan), and the REAL journal
 * writer, with a fake headless Worker emitting a stream-json result event
 * that carries a realistic `usage`/`total_cost_usd` payload
 * (`fake-headless-claude.mjs`, shared with `headless-run.e2e.test.ts`).
 *
 * Root cause under test (see issue 177): the Receipt watch's ingest merge
 * used to source usage ONLY from the one-shot pending stash
 * (`pending ? { ...record, usage: pending } : record`). A re-ingest of the
 * SAME Receipt — a stability double-read, a second Window's independent
 * watch, a restart re-scan — found the stash already consumed and clobbered
 * a just-applied usage back to null, because the store collapses to the
 * latest write per record id. `stickyIngestUsage` (`run-usage-pending.ts`)
 * fixes this by falling back to the already-persisted usage when there is no
 * pending value. This test would fail on the old merge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessSessionManager } from '../src/main/headless-session-manager';
import { ReceiptWatcher } from '../src/main/receipt-watcher';
import { RunLogStore } from '../src/main/run-log-store';
import { applyRunUsage, PendingRunUsageStash, stickyIngestUsage } from '../src/main/run-usage-pending';
import { extractRunUsage } from '../src/shared/run-telemetry';
import { writeDrainJournal } from '../src/main/memory-files';
import type { PtyExitMessage, RunFeedUpdateMessage, RunLogRecord } from '../src/shared/ipc-contract';
import { seedSandbox, sandboxIssue, waitFor, type Sandbox } from './sandbox';

const FAKE = join(process.cwd(), 'e2e', 'fake-headless-claude.mjs');

let sandbox: Sandbox;
let manager: HeadlessSessionManager | null;
let watcherA: ReceiptWatcher | null;
let watcherB: ReceiptWatcher | null;
let scratchStore: string;

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
];
let savedEnv: Record<string, string | undefined>;

afterEach(async () => {
  manager?.killAll();
  watcherA?.closeAll();
  watcherB?.closeAll();
  for (const k of FAKE_ENV_KEYS) {
    if (savedEnv?.[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(sandbox.scratch, { recursive: true, force: true });
  await rm(scratchStore, { recursive: true, force: true });
});

/**
 * Ingest one Receipt exactly the way `main/index.ts`'s ReceiptWatch handler
 * does: consume any pending usage for this issue, merge it stickily against
 * whatever is already persisted (issue 177's fix), then persist the result.
 */
async function ingest(
  store: RunLogStore,
  stash: PendingRunUsageStash,
  projectPath: string,
  record: RunLogRecord,
): Promise<RunLogRecord> {
  const pending = record.issueId !== null ? stash.take(projectPath, record.issueId) : undefined;
  const finalRecord = await stickyIngestUsage(store, projectPath, record, pending);
  await store.append(projectPath, finalRecord);
  return finalRecord;
}

describe('telemetry persistence across a Receipt re-ingest (issue 177)', () => {
  it('a headless Run\'s usage survives a second, independent Receipt watch re-scanning the same Receipt', async () => {
    sandbox = await seedSandbox();
    scratchStore = await mkdtemp(join(tmpdir(), 'mc-telemetry-e2e-'));
    savedEnv = {};
    for (const k of FAKE_ENV_KEYS) savedEnv[k] = process.env[k];

    const issue = sandboxIssue(2);
    const finished = '2026-07-19T12:00:00.000Z';
    process.env.MC_RUN_CMD = `node ${FAKE}`;
    process.env.MC_FAKE_SESSION_ID = 'sess-telemetry-e2e';
    process.env.MC_FAKE_ISSUE_FILE = join(sandbox.repo, 'issues', `${issue.slug}.md`);
    process.env.MC_FAKE_RECEIPT_PATH = join(sandbox.repo, 'issues', 'completions', `${issue.slug}.md`);
    process.env.MC_FAKE_DELIVERABLE = join(sandbox.repo, 'work', `${issue.slug}.txt`);
    process.env.MC_FAKE_SLUG = issue.slug;
    process.env.MC_FAKE_ID = '2';
    process.env.MC_FAKE_FINISHED = finished;
    process.env.MC_FAKE_OUTCOME = 'completed';

    const store = new RunLogStore(scratchStore);
    const stash = new PendingRunUsageStash();

    // --- 1. Real headless child process runs and exits, reporting usage ----
    // (the common ordering: the process exits and reports usage BEFORE any
    // Receipt watch has a chance to see the Receipt it just wrote).
    const exits: PtyExitMessage[] = [];
    const updates: RunFeedUpdateMessage[] = [];
    manager = new HeadlessSessionManager({
      onExit: (msg) => exits.push(msg),
      onSessionCaptured: () => {},
      onFeedUpdate: (msg) => updates.push(msg),
    });
    const startedAt = Date.now();
    const spawn = manager.spawn({
      cols: 80,
      rows: 24,
      run: {
        issueId: 2,
        issueFileName: `${issue.slug}.md`,
        issueTitle: issue.title,
        projectPath: sandbox.repo,
        workbench: null,
        headless: true,
      },
    });
    await waitFor(() => exits.length > 0, 'headless child exits');
    expect(exits[0].sessionId).toBe(spawn.sessionId);

    const lastResult = updates[updates.length - 1]?.content.result ?? null;
    const usage = extractRunUsage(lastResult, Date.now() - startedAt, 'sonnet');
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(1200);
    expect(usage!.outputTokens).toBe(340);
    expect(usage!.costUsd).toBe(0.01);

    // No Run-log record exists for this issue yet (no Receipt watched so far),
    // so applying the usage now stashes it — exactly `finishRunSpawn`'s path.
    const patched = await applyRunUsage(store, stash, sandbox.repo, 2, usage!);
    expect(patched).toBeNull();

    // --- 2. First Receipt watch ingests the Receipt the fake Worker wrote --
    const firstIngested: RunLogRecord[] = [];
    watcherA = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    watcherA.watch('windowA', [sandbox.issuesDir], new Map(), (record) => {
      void ingest(store, stash, sandbox.repo, record).then((r) => firstIngested.push(r));
    });
    await waitFor(() => firstIngested.some((r) => r.issueId === 2), 'first watch ingests the Receipt');

    // AC1 — the FIRST persisted version of the record already carries usage:
    // the pending stash landed before the Receipt watch fired.
    let persisted = await store.read(sandbox.repo);
    let ourRecord = persisted.find((r) => r.issueId === 2)!;
    expect(ourRecord.usage).not.toBeNull();
    expect(ourRecord.usage!.inputTokens).toBe(1200);

    // --- 3. A SECOND, independently-seeded watch re-scans the SAME Receipt -
    // (a second open Window, or an MC restart re-scan) — its own `seen` map
    // starts empty, so its initial directory scan treats the already-ingested
    // Receipt as brand new and fires onReceipt for it AGAIN. The pending stash
    // is already consumed (step 1 above), so on the OLD merge
    // (`pending ? {...} : record`) this clobbers `usage` back to null.
    const secondIngested: RunLogRecord[] = [];
    watcherB = new ReceiptWatcher({ debounceMs: 40, stabilityMs: 25 });
    watcherB.watch('windowB', [sandbox.issuesDir], new Map(), (record) => {
      void ingest(store, stash, sandbox.repo, record).then((r) => secondIngested.push(r));
    });
    await waitFor(() => secondIngested.some((r) => r.issueId === 2), 'second watch re-ingests the same Receipt');

    // AC2 — the re-ingest must NOT reset the populated usage to null.
    persisted = await store.read(sandbox.repo);
    ourRecord = persisted.find((r) => r.issueId === 2)!;
    expect(ourRecord.usage).not.toBeNull();
    expect(ourRecord.usage!.inputTokens).toBe(1200);
    expect(ourRecord.usage!.outputTokens).toBe(340);
    expect(ourRecord.usage!.costUsd).toBe(0.01);
    expect(persisted).toHaveLength(1); // still one record for this issue, not a duplicate

    // --- 4. The drain journal shows per-Run telemetry and non-zero Totals --
    const memoryRoot = join(scratchStore, 'memory');
    const journalOutcome = await writeDrainJournal({
      memoryRoot,
      endedAt: '2026-07-19T12:05:00.000Z',
      reason: 'Drain complete: no eligible issue remains.',
      records: persisted,
      notables: [],
    });
    expect(journalOutcome.written).toBe(true);
    const entry = await readFile(journalOutcome.path!, 'utf8');
    // Per-Run telemetry suffix (tokens/cost) rides the line naming the Run.
    expect(entry).toMatch(new RegExp(`${issue.slug}: completed.*in / .*out tok`));
    expect(entry).toContain('$0.01');
    // A non-zero Totals section — the whole point of issue 143 finally works.
    expect(entry).toContain('## Totals');
    const totalsSection = entry.slice(entry.indexOf('## Totals'));
    expect(totalsSection).toMatch(/1\.2k in \/ 340 out tok/);
    expect(totalsSection).toContain('1/1 Runs with telemetry');
  });
});
