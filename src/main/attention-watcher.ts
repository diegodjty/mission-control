/**
 * Attention Watcher — the background service behind the cross-project Inbox
 * (issue 79, ADR-0016; extends ADR-0006's watch-don't-poll discipline).
 *
 * Reads `~/Workbench/registry.md` and, for EVERY `status: active` project —
 * open in a Window or not — lightly watches its workbench project directory
 * (`issues/`, `completions/`, `memory/`, `HUMAN-SETUP.md`) with one recursive
 * `fs.watch` per project. A relevant change debounces into one re-read through
 * the attention reader and one re-derivation through the pure attention model
 * (issue 78); the aggregated cross-project item list is pushed via `onChange`
 * only when it actually differs. No polling, no timers except the debounce.
 *
 * The registry itself is watched too: adding/activating a project attaches its
 * watcher (and derives once), deactivating/removing detaches it and drops its
 * items — no restart. Reconciliation is incremental: projects that persist
 * keep their watcher and their derived state.
 *
 * READ-ONLY BY CONTRACT: this service never writes, creates, or commits
 * anything in any workbench (the briefing's last-seen stamp lives in app
 * userData — the `lastSeenFor` callback is the caller's, issue 80). Items are
 * informational; acting on one goes through the normal open/claim flows, so
 * ownership (ADR-0004) is untouched.
 *
 * Electron-free on purpose (plain callback, real directories) so it is
 * exercised against real temp workbenches in tests, like the Backlog and
 * Receipt Watchers it sits beside.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { readAttentionInput } from './attention-reader';
import {
  deriveAttention,
  type AttentionItem,
  type AttentionResult,
} from '../shared/attention-model';
import type { AttentionSnapshot } from '../shared/ipc-contract';
import { parseRegistry } from '../shared/workbench-model';

/** Coalesce a burst of `fs.watch` events into one re-derive after this gap. */
const DEFAULT_DEBOUNCE_MS = 200;

interface ProjectWatch {
  /** The recursive watcher on the project dir; null when attach failed (the
   * dir may not exist yet — a later registry reconcile retries). */
  watcher: FSWatcher | null;
  /** Pending debounce timer for this project's re-derive. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The last derivation for this project (null until the first completes). */
  result: AttentionResult | null;
}

export interface AttentionWatcherOptions {
  /** The workbench root (normally `~/Workbench`). */
  workbenchRoot: string;
  /** Receives the aggregated cross-project snapshot whenever it changes. */
  onChange: (snapshot: AttentionSnapshot) => void;
  /** Debounce gap in ms (tests shrink it). */
  debounceMs?: number;
  /**
   * The caller's briefing last-seen stamp per project (ISO-8601), or null when
   * this app has never looked. Lives in app userData (issue 80) — never here.
   */
  lastSeenFor?: (project: string) => string | null;
}

/** Is a project-relative changed path one the attention model reads from? */
export function isAttentionRelevant(rel: string | null): boolean {
  if (rel === null) return true; // platform gave no name — re-derive to be safe
  const norm = rel.split(sep).join('/');
  if (norm === '.git' || norm.startsWith('.git/')) return false;
  return (
    norm === 'HUMAN-SETUP.md' ||
    norm === 'issues' ||
    norm.startsWith('issues/') ||
    norm === 'completions' ||
    norm.startsWith('completions/') ||
    norm === 'memory' ||
    norm.startsWith('memory/')
  );
}

export class AttentionWatcher {
  private readonly workbenchRoot: string;
  private readonly onChange: (snapshot: AttentionSnapshot) => void;
  private readonly debounceMs: number;
  private readonly lastSeenFor: (project: string) => string | null;

  private readonly projects = new Map<string, ProjectWatch>();
  private registryWatcher: FSWatcher | null = null;
  private registryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialized JSON of the last pushed snapshot (suppresses no-op pushes). */
  private lastPushed: string;
  private latest: AttentionSnapshot;
  private closed = false;

  constructor(opts: AttentionWatcherOptions) {
    this.workbenchRoot = opts.workbenchRoot;
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.lastSeenFor = opts.lastSeenFor ?? (() => null);
    this.latest = { workbenchRoot: this.workbenchRoot, items: [], notes: [] };
    this.lastPushed = JSON.stringify(this.latest);
  }

  /**
   * Attach the registry watch and reconcile the initial project set. Safe when
   * the workbench root doesn't exist — the service simply stays inert (an
   * all-legacy machine has no workbench and gets an empty Inbox).
   */
  start(): void {
    try {
      // persistent:false — the watcher must not by itself keep the process
      // alive (Electron's loop does). Watch the ROOT dir, not registry.md
      // itself: editors replace files on save, and a file-watch dies with the
      // old inode while a dir-watch keeps reporting the name.
      this.registryWatcher = watch(this.workbenchRoot, { persistent: false });
      this.registryWatcher.on('change', (_eventType, filename) => {
        const name = filename === null ? null : filename.toString();
        if (name !== null && name !== 'registry.md') return;
        this.scheduleReconcile();
      });
      this.registryWatcher.on('error', () => {
        this.registryWatcher?.close();
        this.registryWatcher = null;
      });
    } catch {
      this.registryWatcher = null; // no workbench root — nothing to watch
    }
    void this.reconcile();
  }

  /** The current aggregated snapshot (what a fresh renderer pulls). */
  get snapshot(): AttentionSnapshot {
    return this.latest;
  }

  /** How many project watches are live (for tests / leak assertions). */
  get size(): number {
    return this.projects.size;
  }

  /** The watched project directory names, ascending. */
  get watchedProjects(): string[] {
    return [...this.projects.keys()].sort();
  }

  /**
   * Re-derive every watched project now — no fs change required. Used when a
   * derivation INPUT that lives outside the workbench changed: the briefing's
   * last-seen stamps advanced on an Inbox view (issue 80), so already-seen
   * journal entries must drop out of the next aggregate.
   */
  rederiveAll(): void {
    if (this.closed) return;
    for (const project of this.projects.keys()) void this.derive(project);
  }

  /** Tear everything down — timers and watchers. Call on app quit. */
  close(): void {
    this.closed = true;
    if (this.registryTimer) clearTimeout(this.registryTimer);
    this.registryTimer = null;
    this.registryWatcher?.close();
    this.registryWatcher = null;
    for (const entry of this.projects.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher?.close();
    }
    this.projects.clear();
  }

  // --- registry: which projects to watch ----------------------------------

  private scheduleReconcile(): void {
    if (this.closed) return;
    if (this.registryTimer) clearTimeout(this.registryTimer);
    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      void this.reconcile();
    }, this.debounceMs);
  }

  /**
   * Re-read the registry and reconcile the watch set: every project with at
   * least one `status: active` entry is watched; everything else is not.
   * Incremental — surviving projects keep their watcher and derived state.
   */
  private async reconcile(): Promise<void> {
    const content = await readFile(join(this.workbenchRoot, 'registry.md'), 'utf8').catch(
      () => '',
    );
    if (this.closed) return;

    // A project is active when ANY of its registry entries (one per member
    // repo) is active. Dedupe: several repos map to one workbench project.
    const active = new Set<string>();
    for (const entry of parseRegistry(content).entries) {
      if (entry.active) active.add(entry.project);
    }

    let removedAny = false;
    for (const [project, entry] of [...this.projects]) {
      if (active.has(project)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher?.close();
      this.projects.delete(project);
      removedAny = true;
    }

    for (const project of active) {
      const existing = this.projects.get(project);
      if (existing) {
        // The project dir may not have existed when we first tried — retry.
        if (existing.watcher === null) existing.watcher = this.attach(project);
        continue;
      }
      const entry: ProjectWatch = { watcher: this.attach(project), timer: null, result: null };
      this.projects.set(project, entry);
      void this.derive(project); // initial derivation — items already on disk count
    }

    // A removed project's items must disappear even though no derive ran.
    if (removedAny) this.push();
  }

  /** One recursive watcher over the project dir; null when it can't attach. */
  private attach(project: string): FSWatcher | null {
    let watcher: FSWatcher;
    try {
      watcher = watch(join(this.workbenchRoot, project), {
        recursive: true,
        persistent: false,
      });
    } catch {
      return null;
    }
    watcher.on('change', (_eventType, filename) => {
      const rel = filename === null ? null : filename.toString();
      if (!isAttentionRelevant(rel)) return;
      this.schedule(project);
    });
    // A watcher-level error (dir removed mid-watch) must not crash main; the
    // next registry reconcile retries the attach if the project persists.
    watcher.on('error', () => {
      watcher.close();
      const entry = this.projects.get(project);
      if (entry && entry.watcher === watcher) entry.watcher = null;
    });
    return watcher;
  }

  // --- deriving: change → debounce → read → pure model → push --------------

  private schedule(project: string): void {
    const entry = this.projects.get(project);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.derive(project);
    }, this.debounceMs);
  }

  private async derive(project: string): Promise<void> {
    const input = await readAttentionInput(
      this.workbenchRoot,
      project,
      this.lastSeenFor(project),
    );
    // The project may have been deactivated (or the service closed) while the
    // read ran — a stale derivation must not resurrect its entry.
    const entry = this.projects.get(project);
    if (!entry || this.closed) return;
    entry.result = deriveAttention(input);
    this.push();
  }

  /** Re-aggregate every project's items and push only on a real change. */
  private push(): void {
    const items: AttentionItem[] = [];
    const notes: string[] = [];
    for (const project of [...this.projects.keys()].sort()) {
      const result = this.projects.get(project)?.result;
      if (!result) continue;
      items.push(...result.items);
      notes.push(...result.notes.map((n) => `${project}: ${n}`));
    }
    const next: AttentionSnapshot = { workbenchRoot: this.workbenchRoot, items, notes };
    const serialized = JSON.stringify(next);
    if (serialized === this.lastPushed) return;
    this.lastPushed = serialized;
    this.latest = next;
    this.onChange(next);
  }
}
