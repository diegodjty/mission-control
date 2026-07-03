/**
 * Receipt Watcher — the I/O edge that makes Receipt files the Dispatcher's
 * live input (issue 56, ADR-0013; extends ADR-0006's watch-don't-poll).
 *
 * Workers hand off results by writing a **Receipt**
 * (`issues/completions/NN-slug.md`, issue 54/55); the file appearing or
 * changing IS the "Worker's final message is complete" signal the PTY scroll
 * could never give. This adapter watches each relevant `issues/` directory —
 * the Project checkout's for solo Runs, plus each parallel Run's worktree copy
 * (Mission Control owns the worktrees, so the caller knows the roots) — and
 * emits one parsed `RunLogRecord` per genuinely-new Receipt into the existing
 * capture pipeline.
 *
 * Robustness, per the ADR:
 *  - **Debounce half-written files.** A watch event can fire before the Worker
 *    finishes writing. After a quiet gap we read the file TWICE, a beat apart,
 *    and only ingest when the two reads agree — a truncated read never sticks;
 *    further writes just restart the wait.
 *  - **Dedupe re-ingestion.** The `seen` map (owned by the caller so it can be
 *    seeded from the persisted Run log and survive watch re-points) keys each
 *    ingest on issue + `finished` (via the pure `receipt-ingest` id) plus a
 *    content fingerprint: an MC restart or a re-scan over existing Receipts
 *    feeds nothing, while a re-run with a new `finished` stamp — or a changed
 *    body under the same stamp — comes through (the latter superseding its
 *    earlier record under the same id).
 *
 * The watch is RECURSIVE over `issues/` rather than pointed at `completions/`
 * itself: the completions dir usually doesn't exist until a Worker writes the
 * first Receipt, and a watcher can't attach to a directory that isn't there
 * yet. Recursive `fs.watch` is supported on macOS/Windows and on Linux from
 * Node 20 (this project requires 22). Non-Receipt churn is filtered out by the
 * pure `isReceiptPath` before any read happens.
 *
 * Electron-free on purpose (plain callbacks) so it is exercised against real
 * temp directories in unit tests, like the Backlog Watcher it sits beside.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RunLogRecord } from '../shared/ipc-contract';
import {
  contentFingerprint,
  isReceiptPath,
  shouldIngest,
  toReceiptRunLogRecord,
} from '../shared/receipt-ingest';

/** Coalesce a burst of events on one file into one read after this quiet gap. */
const DEFAULT_DEBOUNCE_MS = 200;
/** Gap between the two stability reads that must agree before ingesting. */
const DEFAULT_STABILITY_MS = 150;
/**
 * Give up on a file that never stabilises (rewritten every beat) after this
 * many re-reads — a later watch event starts a fresh attempt, so nothing is
 * permanently lost; this only stops a pathological writer pinning a timer loop.
 */
const MAX_STABILITY_ROUNDS = 20;

interface WatchEntry {
  /** One recursive watcher per watched `issues/` root, keyed by root path. */
  watchers: Map<string, FSWatcher>;
  /** id → fingerprint of ingested content (null = seeded, bytes unknown). */
  seen: Map<string, string | null>;
  onReceipt: (record: RunLogRecord) => void;
  /** Per-file debounce/stability timer, keyed by absolute file path. */
  pending: Map<string, ReturnType<typeof setTimeout>>;
}

export class ReceiptWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly debounceMs: number;
  private readonly stabilityMs: number;

  constructor(opts: { debounceMs?: number; stabilityMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.stabilityMs = opts.stabilityMs ?? DEFAULT_STABILITY_MS;
  }

  /**
   * Start (or re-point) the Receipt watch for `key` over the given `issues/`
   * directories (the checkout's plus any live worktrees'). Reconciling is
   * incremental: roots that persist keep their watcher (no re-scan churn),
   * removed roots close, new roots attach and get an initial scan — so a
   * Receipt written while nobody watched (or before a worktree root was added)
   * is still picked up, deduped by `seen`. The caller owns `seen` (seed it
   * from the persisted Run log) so dedupe survives re-points and restarts.
   */
  watch(
    key: string,
    issueDirs: string[],
    seen: Map<string, string | null>,
    onReceipt: (record: RunLogRecord) => void,
  ): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { watchers: new Map(), seen, onReceipt, pending: new Map() };
      this.entries.set(key, entry);
    }
    entry.seen = seen;
    entry.onReceipt = onReceipt;

    const want = new Set(issueDirs);
    for (const [root, watcher] of [...entry.watchers]) {
      if (!want.has(root)) {
        watcher.close();
        entry.watchers.delete(root);
      }
    }
    for (const root of want) {
      if (!entry.watchers.has(root)) this.attach(key, entry, root);
    }
  }

  /** Stop and forget the watch for `key`. Safe to call for an unknown key. */
  unwatch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const timer of entry.pending.values()) clearTimeout(timer);
    entry.pending.clear();
    for (const watcher of entry.watchers.values()) watcher.close();
    entry.watchers.clear();
    this.entries.delete(key);
  }

  /** Close every watch — call when the last Window goes away / on quit. */
  closeAll(): void {
    for (const key of [...this.entries.keys()]) this.unwatch(key);
  }

  /** How many keys are currently watched (for tests / leak assertions). */
  get size(): number {
    return this.entries.size;
  }

  private attach(key: string, entry: WatchEntry, root: string): void {
    let watcher: FSWatcher;
    try {
      // persistent:false — the watcher must not by itself keep the process
      // alive (Electron's loop does); recursive — `completions/` may not exist
      // yet, so we watch the `issues/` root it will be created under.
      watcher = watch(root, { recursive: true, persistent: false });
    } catch {
      // Root missing/unreadable (e.g. a worktree already cleaned up): nothing
      // to watch. The caller re-points on the next reconcile if it reappears.
      return;
    }
    entry.watchers.set(root, watcher);

    watcher.on('change', (_eventType, filename) => {
      const rel = filename === null ? null : filename.toString();
      if (!isReceiptPath(rel)) return;
      this.schedule(key, join(root, rel as string));
    });
    // A watcher-level error (e.g. the worktree was removed mid-watch) must not
    // crash main; drop this root, keep the others.
    watcher.on('error', () => {
      watcher.close();
      entry.watchers.delete(root);
    });

    // Initial scan: Receipts already on disk (written while nobody watched, or
    // present when a worktree root joins) go through the SAME debounce/dedupe
    // pipeline as live events — `seen` keeps a restart/re-scan silent.
    void this.scan(key, root);
  }

  private async scan(key: string, root: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(join(root, 'completions'));
    } catch {
      return; // no completions dir yet — the recursive watch covers its birth
    }
    for (const name of names) {
      if (isReceiptPath(join('completions', name))) {
        this.schedule(key, join(root, 'completions', name));
      }
    }
  }

  /** (Re)start the quiet-gap timer for one file; new events reset the clock. */
  private schedule(key: string, filePath: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const prev = entry.pending.get(filePath);
    if (prev) clearTimeout(prev);
    entry.pending.set(
      filePath,
      setTimeout(() => void this.settle(key, filePath, 0, null), this.debounceMs),
    );
  }

  /**
   * The stability loop: read the file, wait a beat, read again; ingest only
   * when two consecutive reads agree (and aren't blank). A file mid-write
   * keeps differing, so the truncated read never sticks; a deleted/unreadable
   * file simply drops out (a later event retries).
   */
  private async settle(
    key: string,
    filePath: string,
    round: number,
    lastText: string | null,
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return; // unwatched while the timer was pending
    entry.pending.delete(filePath);

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return;
    }

    if (text !== lastText || text.trim() === '') {
      if (round + 1 >= MAX_STABILITY_ROUNDS) return;
      // Not stable yet — but if a NEW watch event re-scheduled this file while
      // we were reading, its fresh debounce owns the file now; don't stack a
      // second timer chain on top of it.
      if (entry.pending.has(filePath)) return;
      entry.pending.set(
        filePath,
        setTimeout(() => void this.settle(key, filePath, round + 1, text), this.stabilityMs),
      );
      return;
    }

    // Stable: parse, dedupe (issue + finished, plus content fingerprint so an
    // unchanged rescan is silent but a changed body supersedes), then emit.
    const record = toReceiptRunLogRecord(text, basename(filePath), new Date().toISOString());
    const fingerprint = contentFingerprint(text);
    if (!shouldIngest(entry.seen, record.id, fingerprint)) return;
    entry.seen.set(record.id, fingerprint);
    entry.onReceipt(record);
  }
}
