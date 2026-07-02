/**
 * Backlog Watcher — the file-watching adapter that powers live Map updates
 * (issue 05). This is the general mechanism that supersedes the targeted
 * poll-while-a-Run-is-live loop the Run slice (issue 03) added to the renderer.
 *
 * Design choice (see ADR-0006): we WATCH the `issues/` directory with the OS
 * file watcher (`fs.watch`) rather than polling it on a timer. Watching is
 * event-driven, so it neither pegs the CPU nor adds latency, and it fires for
 * hand-edits and Run-driven writes alike. `fs.watch` is noisy (an editor save
 * can emit several events) and its `filename` is unreliable across platforms,
 * so we treat every event as "something might have changed", debounce the
 * burst, then re-read the whole backlog through the pure Backlog Model and only
 * push to the renderer when the result actually differs (`backlogChanged`).
 *
 * Watchers are keyed so callers can register/replace/close them per Window; the
 * key is opaque here (main uses the renderer's WebContents id). `closeAll()`
 * and `unwatch(key)` guarantee no watcher outlives the Window that needed it.
 *
 * Electron-free on purpose (takes a plain `onChange` callback) so it can be
 * exercised against a real temp directory in unit tests.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { readBacklog } from './backlog-reader';
import type { Backlog } from '../shared/backlog-model';
import type { BacklogLoadResult } from '../shared/ipc-contract';
import { backlogChanged, isRelevantChange } from '../shared/backlog-watch';

/** Coalesce a burst of `fs.watch` events into one re-read after this quiet gap. */
const DEFAULT_DEBOUNCE_MS = 200;

interface WatchEntry {
  projectPath: string;
  watcher: FSWatcher;
  onChange: (result: BacklogLoadResult) => void;
  /** The last backlog we observed, to diff against (suppresses redundant pushes). */
  last: Backlog | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BacklogWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly debounceMs: number;

  constructor(opts: { debounceMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Start (or replace) the watcher for `key`, pointed at `<projectPath>/issues/`.
   * Re-reads and pushes via `onChange` whenever the directory's `.md` files
   * change. Replacing an existing key closes its previous watcher first, so a
   * Window that switches Projects never leaks the old one.
   */
  watch(
    key: string,
    projectPath: string,
    onChange: (result: BacklogLoadResult) => void,
  ): void {
    this.unwatch(key); // idempotent: replacing a key never leaves two watchers

    const issuesDir = join(projectPath, 'issues');
    let watcher: FSWatcher;
    try {
      // persistent:false — the watcher must not by itself keep the process
      // alive (Electron's own loop does); it still delivers events while the
      // app runs, and lets test processes exit cleanly.
      watcher = watch(issuesDir, { persistent: false });
    } catch {
      // Directory missing/unreadable: the initial load already surfaced the
      // error to the user; nothing to watch, so simply don't register.
      return;
    }

    const entry: WatchEntry = {
      projectPath,
      watcher,
      onChange,
      last: null,
      timer: null,
    };
    this.entries.set(key, entry);

    watcher.on('change', (_eventType, filename) => {
      const name = filename === null ? null : filename.toString();
      if (!isRelevantChange(name)) return;
      this.schedule(key);
    });
    // A watcher-level error (e.g. the dir was removed) shouldn't crash main.
    watcher.on('error', () => this.unwatch(key));

    // Seed `last` with the current on-disk state (without pushing — the caller
    // already loaded it) so the first real change diffs correctly.
    void this.seed(entry);
  }

  /** Stop and forget the watcher for `key`. Safe to call for an unknown key. */
  unwatch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.entries.delete(key);
  }

  /** Close every watcher — call when the last Window goes away / on quit. */
  closeAll(): void {
    for (const key of [...this.entries.keys()]) this.unwatch(key);
  }

  /** How many watchers are currently open (for tests / leak assertions). */
  get size(): number {
    return this.entries.size;
  }

  private schedule(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.reload(key);
    }, this.debounceMs);
  }

  private async seed(entry: WatchEntry): Promise<void> {
    try {
      entry.last = await readBacklog(entry.projectPath);
    } catch {
      entry.last = null;
    }
  }

  private async reload(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return; // unwatched while the timer was pending

    const result = await this.read(entry.projectPath);

    // Only notify when the Map-visible state actually changed.
    if (backlogChanged(entry.last, result.backlog)) {
      entry.last = result.backlog;
      // The watcher may have been closed during the async read.
      if (this.entries.has(key)) entry.onChange(result);
    } else {
      entry.last = result.backlog;
    }
  }

  private async read(projectPath: string): Promise<BacklogLoadResult> {
    try {
      const backlog = await readBacklog(projectPath);
      return { projectPath, backlog, error: null };
    } catch (err) {
      return {
        projectPath,
        backlog: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
