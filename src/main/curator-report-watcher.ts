/**
 * Curator Report Watcher — the background service behind the curator-report
 * attention items (issue 151).
 *
 * Watches ONE global directory, `~/Workbench/tools/curator-reports/` (the
 * memory-curator skill's weekly output — outside any single project's
 * workbench dir, so this watcher is independent of the per-project
 * `AttentionWatcher`). A change debounces into a re-read of every `.md` file
 * (the curator's `.log` files are never reports) and a re-derivation through
 * the pure `deriveCuratorReportItems`, filtered against the caller's seen-set;
 * the item list is pushed via `onChange` only when it actually differs.
 *
 * READ-ONLY BY CONTRACT: this service never writes anything. Electron-free
 * (plain callback, real directories) so it is exercised against real temp
 * dirs in tests, like the Planning/Attention Watchers beside it.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deriveCuratorReportItems,
  type AttentionItem,
  type CuratorReportFile,
} from '../shared/attention-hub-model';

const DEFAULT_DEBOUNCE_MS = 200;

export interface CuratorReportWatcherOptions {
  /** Absolute path to `~/Workbench/tools/curator-reports`. */
  dir: string;
  /** Receives the derived (unseen-only) item list whenever it changes. */
  onChange: (items: AttentionItem[]) => void;
  /** The current seen-report-name set (issue 151) — read fresh each derive. */
  seenFor: () => ReadonlySet<string>;
  /** Debounce gap in ms (tests shrink it). */
  debounceMs?: number;
}

export class CuratorReportWatcher {
  private readonly dir: string;
  private readonly onChange: (items: AttentionItem[]) => void;
  private readonly seenFor: () => ReadonlySet<string>;
  private readonly debounceMs: number;

  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPushed: string | null = null;
  private latest: AttentionItem[] = [];
  private closed = false;

  constructor(opts: CuratorReportWatcherOptions) {
    this.dir = opts.dir;
    this.onChange = opts.onChange;
    this.seenFor = opts.seenFor;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The current derived item list (what a fresh renderer pulls). */
  get items(): AttentionItem[] {
    return this.latest;
  }

  /** Start watching; pushes the initial scan immediately. */
  start(): void {
    try {
      // persistent:false — must not by itself keep the process alive.
      this.watcher = watch(this.dir, { persistent: false });
      this.watcher.on('change', () => this.schedule());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // dir missing/unreadable — the scan simply sees nothing
    }
    void this.rescan();
  }

  /** Re-derive now — no fs change required (a report was just marked seen). */
  rederive(): void {
    if (this.closed) return;
    void this.rescan();
  }

  /** Stop watching and forget state. Call on app quit. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rescan();
    }, this.debounceMs);
  }

  private async rescan(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    const files: CuratorReportFile[] = [];
    for (const name of names) {
      if (!/\.md$/i.test(name)) continue;
      const content = await readFile(join(this.dir, name), 'utf8').catch(() => null);
      if (content !== null) files.push({ name, content });
    }
    if (this.closed) return;

    const items = deriveCuratorReportItems(files, this.seenFor());
    const serialized = JSON.stringify(items);
    if (serialized === this.lastPushed) return;
    this.lastPushed = serialized;
    this.latest = items;
    this.onChange(items);
  }
}
