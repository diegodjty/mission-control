/**
 * Planning Watcher — the file-watching adapter behind the Planning view's live
 * doc preview (issue 83, ADR-0016; ADR-0006 watch-don't-poll discipline).
 *
 * For one renderer's Planning view it watches the planning roots — the
 * workbench project dir (top-level PRDs + `issues/`) and the repo's
 * `CONTEXT.md` + `docs/adr/` — debounces the event bursts, re-scans the
 * watched set, and pushes the ordered doc list (most-recently-changed first,
 * via the pure planning model) only when it actually differs. The initial
 * `watch()` always pushes once, so the preview has its list without a separate
 * load call.
 *
 * READ-ONLY: this adapter stats and lists files; it never writes anything.
 * Watchers are keyed per caller (main uses the renderer's WebContents id);
 * `unwatch`/`closeAll` guarantee nothing outlives the Window that needed it.
 *
 * Electron-free on purpose (plain callback) so it is exercised against real
 * temp directories in unit tests, like the Backlog/Receipt/Attention watchers
 * beside it.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  derivePlanningDocs,
  isAdrPlanningChange,
  isRepoPlanningChange,
  isWorkbenchPlanningChange,
  type PlanningDoc,
  type PlanningRoots,
  type ScannedFile,
} from '../shared/planning-model';

/** Coalesce a burst of `fs.watch` events into one re-scan after this gap. */
const DEFAULT_DEBOUNCE_MS = 200;

interface WatchEntry {
  roots: PlanningRoots;
  onChange: (docs: PlanningDoc[]) => void;
  /** The workbench-dir + repo-root watchers (whichever attached). */
  watchers: FSWatcher[];
  /**
   * The `docs/adr/` watcher, kept separate: the dir may not exist yet when the
   * watch starts (a docs-first repo grows it later), so each re-scan re-tries
   * the attach while it is null.
   */
  adrWatcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Serialized last pushed list (suppresses no-op pushes). */
  lastPushed: string | null;
}

/** List a directory's files with mtimes; missing/unreadable dir = empty. */
async function listFiles(dir: string): Promise<ScannedFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name): Promise<ScannedFile | null> => {
      try {
        const s = await stat(join(dir, name));
        return s.isFile() ? { name, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null; // deleted mid-scan — not a doc
      }
    }),
  );
  return files.filter((f): f is ScannedFile => f !== null);
}

/** The file's mtime, or null when it doesn't exist / isn't a file. */
async function statMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

export class PlanningWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly debounceMs: number;

  constructor(opts: { debounceMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Start (or replace) the planning watch for `key` over the given roots.
   * Pushes the initial scan immediately, then on every debounced real change.
   * Replacing an existing key closes its previous watchers first.
   */
  watch(key: string, roots: PlanningRoots, onChange: (docs: PlanningDoc[]) => void): void {
    this.unwatch(key);

    const entry: WatchEntry = {
      roots,
      onChange,
      watchers: [],
      adrWatcher: null,
      timer: null,
      lastPushed: null,
    };
    this.entries.set(key, entry);

    // The workbench project dir: top-level PRDs + issues/, recursively —
    // filtered so completions/, memory/ and the auto-commit's .git churn
    // never trigger a re-scan.
    this.attach(entry, key, roots.workbenchDir, { recursive: true }, isWorkbenchPlanningChange);
    // The repo root (non-recursive): CONTEXT.md, plus `docs` appearing so the
    // adr attach below gets retried.
    this.attach(entry, key, roots.repoPath, { recursive: false }, isRepoPlanningChange);
    this.attachAdr(entry, key);

    // Initial scan: the preview needs its list now, not on the first change.
    void this.rescan(key, { force: true });
  }

  /** Stop and forget the watch for `key`. Safe for an unknown key. */
  unwatch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const w of entry.watchers) w.close();
    entry.adrWatcher?.close();
    this.entries.delete(key);
  }

  /** Close every watch — app quit / all windows closed. */
  closeAll(): void {
    for (const key of [...this.entries.keys()]) this.unwatch(key);
  }

  /** The roots the given key currently watches (the doc-read allowlist input). */
  rootsFor(key: string): PlanningRoots | null {
    return this.entries.get(key)?.roots ?? null;
  }

  /** How many watches are live (for tests / leak assertions). */
  get size(): number {
    return this.entries.size;
  }

  private attach(
    entry: WatchEntry,
    key: string,
    dir: string,
    opts: { recursive: boolean },
    relevant: (rel: string | null) => boolean,
  ): void {
    let watcher: FSWatcher;
    try {
      // persistent:false — a watcher must not by itself keep the process alive.
      watcher = watch(dir, { recursive: opts.recursive, persistent: false });
    } catch {
      return; // dir missing/unreadable — the scan simply sees nothing there
    }
    entry.watchers.push(watcher);
    watcher.on('change', (_eventType, filename) => {
      const rel = filename === null ? null : filename.toString();
      if (!relevant(rel)) return;
      this.schedule(key);
    });
    // A watcher-level error (dir removed mid-watch) must not crash main.
    watcher.on('error', () => watcher.close());
  }

  /** Attach the `docs/adr/` watcher when the dir exists; retried per re-scan. */
  private attachAdr(entry: WatchEntry, key: string): void {
    if (entry.adrWatcher !== null) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(join(entry.roots.repoPath, 'docs', 'adr'), { persistent: false });
    } catch {
      return; // no docs/adr yet — a later re-scan retries
    }
    entry.adrWatcher = watcher;
    watcher.on('change', (_eventType, filename) => {
      const rel = filename === null ? null : filename.toString();
      if (!isAdrPlanningChange(rel)) return;
      this.schedule(key);
    });
    watcher.on('error', () => {
      watcher.close();
      if (entry.adrWatcher === watcher) entry.adrWatcher = null;
    });
  }

  private schedule(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.rescan(key);
    }, this.debounceMs);
  }

  private async rescan(key: string, opts: { force?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return; // unwatched while the timer was pending
    this.attachAdr(entry, key); // docs/adr may have appeared since the last look

    const { workbenchDir, repoPath } = entry.roots;
    const [workbenchFiles, issueFiles, contextMtimeMs, adrFiles] = await Promise.all([
      listFiles(workbenchDir),
      listFiles(join(workbenchDir, 'issues')),
      statMtime(join(repoPath, 'CONTEXT.md')),
      listFiles(join(repoPath, 'docs', 'adr')),
    ]);
    // The watch may have been replaced/closed during the async scan.
    if (this.entries.get(key) !== entry) return;

    const docs = derivePlanningDocs(entry.roots, {
      workbenchFiles,
      issueFiles,
      contextMtimeMs,
      adrFiles,
    });
    const serialized = JSON.stringify(docs);
    if (!opts.force && serialized === entry.lastPushed) return;
    entry.lastPushed = serialized;
    entry.onChange(docs);
  }
}
