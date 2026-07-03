import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptWatcher } from './receipt-watcher';
import { contentFingerprint } from '../shared/receipt-ingest';
import type { RunLogRecord } from '../shared/ipc-contract';

/**
 * Exercises the real Receipt capture edge (issue 56, ADR-0013) against real
 * temp `issues/completions/` directories: watcher → parsed event, plus the
 * debounce (half-written files) and dedupe (restart / re-scan / re-run) cases
 * the acceptance criteria name.
 */

function receipt(finished: string, body = 'The app now reads Receipts.'): string {
  return (
    `---\nissue: 56\nslug: capture-edge\noutcome: completed\nfinished: ${finished}\n---\n\n` +
    `## Completed issue 56 — capture-edge\n\n` +
    `**What changed** — ${body}\n\n**Verified** — edge test.\n`
  );
}

/** Wait until `predicate` is true or time out. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for watcher event');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const watchers: ReceiptWatcher[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.closeAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A temp "checkout": an `issues/` dir (with completions/ only when asked). */
async function makeRoot(withCompletions = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mc-receipt-'));
  dirs.push(root);
  await mkdir(join(root, 'issues'));
  if (withCompletions) await mkdir(join(root, 'issues', 'completions'));
  return root;
}

function newWatcher(): ReceiptWatcher {
  const w = new ReceiptWatcher({ debounceMs: 30, stabilityMs: 40 });
  watchers.push(w);
  return w;
}

describe('ReceiptWatcher (real filesystem)', () => {
  it('a Receipt written to the checkout completions/ surfaces as ONE parsed event', async () => {
    const root = await makeRoot();
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    await sleep(80); // let the initial scan settle

    await writeFile(join(root, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));

    await waitFor(() => seen.length > 0);
    await sleep(150); // long enough for any (wrong) duplicate ingest to appear
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe('completed');
    expect(seen[0].issueId).toBe(56);
    expect(seen[0].slug).toBe('56-capture-edge');
    expect(seen[0].id).toBe('receipt:56-capture-edge:2026-07-03T10:00:00Z');
    expect(seen[0].whatChanged).toContain('reads Receipts');
  });

  it('writing the same Receipt again unchanged produces nothing', async () => {
    const root = await makeRoot();
    const file = join(root, 'issues', 'completions', '56-capture-edge.md');
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    await sleep(80);

    await writeFile(file, receipt('2026-07-03T10:00:00Z'));
    await waitFor(() => seen.length === 1);

    await writeFile(file, receipt('2026-07-03T10:00:00Z'));
    await sleep(250);
    expect(seen).toHaveLength(1);
  });

  it('a half-written file is not ingested truncated: re-read until stable', async () => {
    const root = await makeRoot();
    const file = join(root, 'issues', 'completions', '56-capture-edge.md');
    const full = receipt('2026-07-03T10:00:00Z');
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    await sleep(80);

    // Simulate a Worker mid-write: the frontmatter lands first (already
    // parseable — the dangerous case), the body follows a beat later.
    await writeFile(file, full.slice(0, 80));
    await sleep(50); // inside the stability window: the truncated read must not stick
    await writeFile(file, full);

    await waitFor(() => seen.length > 0);
    await sleep(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].whatChanged).toContain('reads Receipts'); // the FULL content, never the truncation
    expect(seen[0].verified).toContain('edge test');
  });

  it('restart over existing Receipts does not re-feed; a NEW finished stamp does', async () => {
    const root = await makeRoot();
    const file = join(root, 'issues', 'completions', '56-capture-edge.md');
    await writeFile(file, receipt('2026-07-03T10:00:00Z'));

    // "Restart": the seen set is seeded from the persisted Run log, where the
    // original bytes are unknown (null fingerprint).
    const seeded = new Map<string, string | null>([
      ['receipt:56-capture-edge:2026-07-03T10:00:00Z', null],
    ]);
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], seeded, (r) => seen.push(r));

    await sleep(300); // initial scan runs over the existing Receipt — must stay silent
    expect(seen).toHaveLength(0);

    // A re-run of the same issue overwrites the file with a NEW finished stamp:
    // a new event by the issue+finished key.
    await writeFile(file, receipt('2026-07-03T11:00:00Z', 'Second run.'));
    await waitFor(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('receipt:56-capture-edge:2026-07-03T11:00:00Z');
  });

  it('the initial scan ingests a Receipt that landed while nobody watched', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'issues', 'completions', '07-offline.md'), receipt('2026-07-03T09:00:00Z'));
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));

    await waitFor(() => seen.length > 0);
    expect(seen[0].slug).toBe('07-offline');
  });

  it('a Receipt inside a parallel worktree root surfaces the same way, and its post-merge copy in the checkout is deduped', async () => {
    const checkout = await makeRoot();
    const worktree = await makeRoot();
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    const shared = new Map<string, string | null>();
    watcher.watch('w1', [join(checkout, 'issues'), join(worktree, 'issues')], shared, (r) => seen.push(r));
    await sleep(80);

    // Live, before any Merge: the Receipt exists only in the worktree.
    await writeFile(join(worktree, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));
    await waitFor(() => seen.length === 1);

    // After the Merge the SAME Receipt appears in the checkout: not a new event.
    await writeFile(join(checkout, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));
    await sleep(250);
    expect(seen).toHaveLength(1);
  });

  it('a completions/ dir created AFTER the watch starts is still covered', async () => {
    const root = await makeRoot(false); // no completions/ yet — the Worker creates it
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    await sleep(80);

    await mkdir(join(root, 'issues', 'completions'));
    await writeFile(join(root, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));

    await waitFor(() => seen.length > 0);
    expect(seen[0].issueId).toBe(56);
  });

  it('non-Receipt churn in issues/ (the backlog itself) emits nothing', async () => {
    const root = await makeRoot();
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    await sleep(80);

    await writeFile(join(root, 'issues', '56-capture-edge.md'), '---\nstatus: wip\n---\n# 56');
    await sleep(250);
    expect(seen).toHaveLength(0);
  });

  it('unwatch stops events and closes root watchers; re-watch reconciles roots', async () => {
    const root = await makeRoot();
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    watcher.watch('w1', [join(root, 'issues')], new Map(), (r) => seen.push(r));
    expect(watcher.size).toBe(1);

    watcher.unwatch('w1');
    expect(watcher.size).toBe(0);
    await writeFile(join(root, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));
    await sleep(250);
    expect(seen).toHaveLength(0);
  });

  it('re-watching the same key with the same roots does not re-ingest (no re-scan double-feed)', async () => {
    const root = await makeRoot();
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    const sharedSeen = new Map<string, string | null>();
    watcher.watch('w1', [join(root, 'issues')], sharedSeen, (r) => seen.push(r));
    await sleep(80);
    await writeFile(join(root, 'issues', 'completions', '56-capture-edge.md'), receipt('2026-07-03T10:00:00Z'));
    await waitFor(() => seen.length === 1);

    // The renderer re-sends the watch request (e.g. the worktree set changed
    // elsewhere): the re-scan over the existing Receipt must stay silent.
    watcher.watch('w1', [join(root, 'issues')], sharedSeen, (r) => seen.push(r));
    await sleep(250);
    expect(seen).toHaveLength(1);
  });

  it('the emitted record fingerprint matches the file content (supersede plumbing)', async () => {
    // Guards the seen-map contract: after ingest the map holds the ingested
    // bytes' fingerprint, so an identical rescan is silent but a changed body
    // with the SAME finished stamp supersedes (same id, new content).
    const root = await makeRoot();
    const file = join(root, 'issues', 'completions', '56-capture-edge.md');
    const seen: RunLogRecord[] = [];
    const watcher = newWatcher();
    const sharedSeen = new Map<string, string | null>();
    watcher.watch('w1', [join(root, 'issues')], sharedSeen, (r) => seen.push(r));
    await sleep(80);

    const v1 = receipt('2026-07-03T10:00:00Z');
    await writeFile(file, v1);
    await waitFor(() => seen.length === 1);
    expect(sharedSeen.get(seen[0].id)).toBe(contentFingerprint(v1));

    const v2 = receipt('2026-07-03T10:00:00Z', 'Amended block, same stamp.');
    await writeFile(file, v2);
    await waitFor(() => seen.length === 2);
    expect(seen[1].id).toBe(seen[0].id); // same key → supersedes, not a new card
    expect(seen[1].whatChanged).toContain('Amended block');
  });
});
