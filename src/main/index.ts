/**
 * Electron main process — the single backend/coordinator.
 *
 * Boots the app, opens one Project Window (renderer), and wires the IPC
 * Contract to the PTY Session Manager so keystrokes and output round-trip
 * between xterm.js (renderer) and node-pty (here in main).
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PtySessionManager } from './pty-session-manager';
import { readBacklog } from './backlog-reader';
import { BacklogWatcher } from './backlog-watcher';
import {
  applyIsolation,
  commitFinishedMain,
  commitFinishedWorktree,
  discardWorktree,
  isMidMerge,
  readIsolatedIssueStatus,
  scanAfkBranches,
  worktreePathFor,
} from './git-worktree-adapter';
import { mergeRuns, abortMerge } from './run-merge';
import { RunLogStore } from './run-log-store';
import { ReceiptWatcher } from './receipt-watcher';
import {
  IpcChannel,
  type AfkScanRequest,
  type AfkScanResult,
  type AfkDiscardRequest,
  type AfkDiscardResult,
  type BacklogLoadRequest,
  type BacklogLoadResult,
  type BacklogWatchRequest,
  type IsolationApplyRequest,
  type IsolationApplyResult,
  type IssueStatusObserveRequest,
  type IssueStatusObserveResult,
  type MainCommitRequest,
  type MainCommitResult,
  type WorktreeCommitRequest,
  type WorktreeCommitResult,
  type MergeRunsRequest,
  type MergeRunsResult,
  type MergeAbortRequest,
  type MergeAbortResult,
  type ProjectActionResult,
  type ProjectListResult,
  type ProjectOpenRequest,
  type ProjectSwitchRequest,
  type ProjectTransitionRequest,
  type ProjectPickFolderResult,
  type ProjectView,
  type ReceiptWatchRequest,
  type RunLogLoadRequest,
  type RunLogLoadResult,
  type PtyKillMessage,
  type PtyResizeMessage,
  type PtySpawnRequest,
  type PtyWriteMessage,
  type WindowOpenRequest,
  type WindowOpenResult,
} from '../shared/ipc-contract';
import {
  resolvePickedFolder,
  resolvePickerDefaultPath,
} from '../shared/folder-picker';
import {
  emptyRegistry,
  registerProject,
  claimProject,
  switchActiveProject,
  transitionStage,
  closeWindow,
  findProject,
  normalizeRepoPath,
  checkRepoOwnership,
  type ProjectRegistry,
  type RegistryResult,
} from '../shared/project-registry';
import { createRepoSerializer } from '../shared/repo-serializer';

// electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file otherwise.
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// --- The single backend's Project registry (ADR-0004) ----------------------
// ONE registry value for the whole app; each Window is identified by its
// webContents id. Ownership here is what stops two Windows double-managing a
// repo. A repo the opener queued for a freshly-created Window to auto-open is
// held in `pendingOpen`, keyed by the new Window's webContents id. It is
// PEEKED (not consumed) by ProjectList so a racing/duplicate list read — a
// React StrictMode double-mount or the registry-changed listener — can't
// silently drink the target before the bootstrap acts on it (issue 14). The
// entry is cleared only once the Window actually opens a Project (ProjectOpen)
// or the Window closes.
let registry: ProjectRegistry = emptyRegistry();
const pendingOpen = new Map<number, string>();

// Per-repo serializer (issue 31): even the single owning Window can fire
// overlapping repo-mutating IPC calls (a drain applying isolation while a
// finished Run auto-commits, a Merge racing a scan-driven commit). Git
// worktree/branch mutations on one repo aren't concurrency-safe, so every
// mutating handler runs its git work through this — same-repo work serializes,
// different repos still run in parallel.
const repoSerializer = createRepoSerializer();

/**
 * Action-time ownership guard (issue 31): the worktree/merge/observe handlers
 * all act on a renderer-supplied `projectPath`. Before acting, confirm the
 * CALLING Window (its webContents id) currently owns that repo in the live
 * registry — a stale renderer path, or a Window caught mid-release, must not
 * drive a worktree mutation or Merge on a repo it no longer owns. Returns the
 * rejection message, or null when the Window may proceed.
 */
function ownershipError(
  event: IpcMainInvokeEvent,
  projectPath: string,
): string | null {
  const check = checkRepoOwnership(registry, projectPath, String(event.sender.id));
  return check.ok ? null : check.error;
}

// The last folder chosen through the native Browse… chooser (issue 19), so the
// next open of the picker starts where the user last was instead of at $HOME
// every time. Null until the user picks one; a cancel never updates it.
let lastPickedFolder: string | null = null;

function createWindow(repoToOpen?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'Mission Control',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (repoToOpen) pendingOpen.set(win.webContents.id, repoToOpen);

  loadRenderer(win);

  // When a Window closes, free every repo it managed so another Window can open
  // them, and broadcast so open Windows refresh their switcher.
  win.on('closed', () => {
    registry = closeWindow(registry, String(win.webContents.id));
    pendingOpen.delete(win.webContents.id);
    broadcastRegistryChanged();
  });

  return win;
}

/** Broadcast a registry change to every open Window. */
function broadcastRegistryChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(IpcChannel.ProjectRegistryChanged);
    }
  }
}

/** Project list from a given Window's perspective (ownership relative to it). */
function projectViewsFor(windowId: string): ProjectView[] {
  return registry.projects.map((p) => ({
    repoPath: p.repoPath,
    stage: p.stage,
    ownership:
      p.ownerWindowId === null ? 'free' : p.ownerWindowId === windowId ? 'you' : 'other',
  }));
}

/** The repo a Window actively manages right now, or null. */
function activeRepoFor(windowId: string): string | null {
  return registry.projects.find((p) => p.ownerWindowId === windowId)?.repoPath ?? null;
}

/** Turn a pure RegistryResult into the Window-relative action result + broadcast. */
function applyResult(result: RegistryResult, windowId: string): ProjectActionResult {
  if (result.ok) {
    registry = result.registry;
    broadcastRegistryChanged();
  }
  return {
    ok: result.ok,
    error: result.error,
    activeRepoPath: activeRepoFor(windowId),
    projects: projectViewsFor(windowId),
  };
}

/** Broadcast a PTY event to every open Window; each Pane filters by sessionId. */
function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// One PTY Session Manager for the app. With many Windows on one backend, PTY
// output is broadcast to every Window and each Pane reacts only to its own
// sessionId — so a session started in one Window still round-trips correctly.
const ptyManager = new PtySessionManager({
  onData: (msg) => broadcast(IpcChannel.PtyData, msg),
  onExit: (msg) => broadcast(IpcChannel.PtyExit, msg),
});

// One Backlog Watcher for the app; keyed per renderer WebContents so a Window
// that closes (or re-points at another Project) never leaks a watcher.
const backlogWatcher = new BacklogWatcher();

// The durable Run log (issue 34, ADR-0009): per-Project Completion-block records
// under the app's userData dir, so the Execution view's feed survives closing
// Panes and app restarts. Instantiated in `whenReady` (needs `app.getPath`).
let runLogStore: RunLogStore;

// The Receipt capture edge (issue 56, ADR-0013): watches each Project's
// `issues/completions/` (checkout + live worktrees) for Worker Receipts, keyed
// per renderer WebContents like the Backlog Watcher, so a closing Window never
// leaks a watch.
const receiptWatcher = new ReceiptWatcher();

// Per-Project dedupe memory for the Receipt edge: record id (issue + finished)
// → fingerprint of the ingested content, or null for ids seeded from the
// persisted Run log (an MC restart must not re-feed Receipts already captured
// in an earlier session — ADR-0013). Cached as a promise per normalised repo
// path so concurrent watch requests share ONE seeding read and one live map.
const receiptSeenByProject = new Map<string, Promise<Map<string, string | null>>>();

function seenReceiptsFor(projectPath: string): Promise<Map<string, string | null>> {
  const key = normalizeRepoPath(projectPath);
  let promise = receiptSeenByProject.get(key);
  if (!promise) {
    promise = runLogStore
      .read(projectPath)
      .then((records) => {
        const seen = new Map<string, string | null>();
        for (const rec of records) {
          if (rec.id.startsWith('receipt:')) seen.set(rec.id, null);
        }
        return seen;
      })
      .catch(() => new Map<string, string | null>());
    receiptSeenByProject.set(key, promise);
  }
  return promise;
}

function registerIpc(): void {
  ipcMain.handle(
    IpcChannel.BacklogLoad,
    async (_event, req: BacklogLoadRequest): Promise<BacklogLoadResult> => {
      const projectPath = req.projectPath?.trim() || process.cwd();
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
    },
  );

  ipcMain.on(IpcChannel.BacklogWatch, (event, req: BacklogWatchRequest) => {
    const sender = event.sender;
    const key = String(sender.id);
    backlogWatcher.watch(key, req.projectPath, (result) => {
      if (!sender.isDestroyed()) sender.send(IpcChannel.BacklogChanged, result);
    });
    // Close this Window's watcher when its renderer goes away, so watchers
    // never outlive the Window that needed them.
    sender.once('destroyed', () => backlogWatcher.unwatch(key));
  });

  // Observe an isolated Run's completion from its own worktree/branch (issue
  // 13): a parallel Run flips its issue to `done` inside its worktree, which
  // the main-checkout backlog watcher never sees. The renderer feeds this
  // worktree-observed status into the pure run-state selector for isolated Runs.
  ipcMain.handle(
    IpcChannel.IssueStatusObserve,
    async (event, req: IssueStatusObserveRequest): Promise<IssueStatusObserveResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { status: null, commitError: denied };
      return readIsolatedIssueStatus(req.projectPath, req.slug);
    },
  );

  // Auto-commit a finished SOLO Run's work on `main` (issue 25): the symmetric
  // counterpart of the isolated auto-commit above. A solo Run's agent flips its
  // issue to `done` and leaves the files + flip uncommitted on `main`; nothing
  // else commits them, so `main` stays dirty and the next parallel Merge fails
  // its clean-tree preflight. MC commits — only on the done transition,
  // idempotent — so "finished" uniformly means "committed".
  ipcMain.handle(
    IpcChannel.MainCommit,
    async (event, req: MainCommitRequest): Promise<MainCommitResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { committed: false, error: denied };
      return repoSerializer.run(normalizeRepoPath(req.projectPath), () =>
        commitFinishedMain(req.projectPath, req.slug),
      );
    },
  );

  // Auto-commit a finished ISOLATED Run's worktree onto its `afk/` branch (issue
  // 15/30). The renderer fires this ONCE on the finished transition it observes
  // from the on-disk scan (worktree `done`, branch tip not) — event-driven, not
  // on every status-read tick — so the status read is a pure read and a drain no
  // longer spawns a commit per tick. `commitFinishedWorktree` is idempotent, so a
  // stray re-fire is a no-op; a genuine failure is returned for the UI to surface.
  ipcMain.handle(
    IpcChannel.WorktreeCommit,
    async (event, req: WorktreeCommitRequest): Promise<WorktreeCommitResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { committed: false, error: denied };
      return repoSerializer.run(normalizeRepoPath(req.projectPath), () =>
        commitFinishedWorktree(req.projectPath, req.slug),
      );
    },
  );

  // On-disk `afk/` scan (issue 16): the ground truth for which issues have an
  // in-flight or finished-but-unmerged isolated Run. Driven independently of the
  // renderer's in-memory tracked Runs, so the Map's progress indicators and the
  // Merge affordance survive closing every Pane.
  ipcMain.handle(
    IpcChannel.AfkScan,
    async (event, req: AfkScanRequest): Promise<AfkScanResult> => {
      // A Window that doesn't own this repo gets an empty scan — it must not
      // derive a Merge affordance or block drains off a repo it doesn't drive.
      if (ownershipError(event, req.projectPath)) return { branches: [], midMerge: false };
      return {
        branches: await scanAfkBranches(req.projectPath),
        // Also report whether `main` is left mid-merge by a partial merge conflict
        // (issue 24) so the renderer can block a new drain/Run and offer an Abort.
        midMerge: await isMidMerge(req.projectPath),
      };
    },
  );

  // Discard a stranded isolated Run (issue 22): force-remove its worktree and
  // delete its `afk/NN-slug` branch. Human-triggered only (the user clicks
  // Discard on a stranded/commit-failed Run), so a blocked/stopped Run that can
  // never merge stops suppressing the batch. Errors are returned, not thrown, so
  // the renderer can show them without crashing the poll.
  ipcMain.handle(
    IpcChannel.AfkDiscard,
    async (event, req: AfkDiscardRequest): Promise<AfkDiscardResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { ok: false, error: denied };
      return repoSerializer.run(normalizeRepoPath(req.projectPath), async () => {
        try {
          await discardWorktree(req.projectPath, req.slug);
          return { ok: true, error: null };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
    },
  );

  // Isolation lifecycle (ADR-0002): the Git/Worktree Adapter reconciles the
  // active Run set to solo-on-main or a worktree-per-Run, and hands back each
  // Run's cwd for the PTY spawn below.
  ipcMain.handle(
    IpcChannel.IsolationApply,
    (event, req: IsolationApplyRequest): Promise<IsolationApplyResult> => {
      // Reject a non-owner: a stale renderer must not create/tear down worktrees
      // on a repo the real owner is driving. Empty placements ⇒ no mutation.
      if (ownershipError(event, req.projectPath)) {
        return Promise.resolve({ parallel: false, placements: [] });
      }
      return repoSerializer.run(normalizeRepoPath(req.projectPath), () =>
        applyIsolation(req.projectPath, req.runs),
      );
    },
  );

  // Merge (ADR-0002): human-triggered only. Integrates the finished parallel
  // Runs' `afk/NN-slug` branches into main via afk-merge.sh, then cleans up the
  // worktrees. Never invoked automatically — the renderer calls this in direct
  // response to the user clicking Merge.
  ipcMain.handle(
    IpcChannel.MergeRuns,
    (event, req: MergeRunsRequest): Promise<MergeRunsResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) {
        return Promise.resolve({
          ok: false,
          conflicted: false,
          merged: [],
          message: denied,
          output: '',
        });
      }
      return repoSerializer.run(normalizeRepoPath(req.projectPath), () =>
        mergeRuns(req.projectPath, req.slugs),
      );
    },
  );

  // Abort an in-progress merge left on `main` by a partial conflict (issue 24):
  // `git merge --abort` back to a clean, non-mid-merge `main` so a non-git user
  // isn't stranded and a new drain/Run is unblocked. Human-triggered only.
  ipcMain.handle(
    IpcChannel.MergeAbort,
    (event, req: MergeAbortRequest): Promise<MergeAbortResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return Promise.resolve({ ok: false, error: denied });
      return repoSerializer.run(normalizeRepoPath(req.projectPath), () =>
        abortMerge(req.projectPath),
      );
    },
  );

  ipcMain.handle(IpcChannel.PtySpawn, (_event, req: PtySpawnRequest) =>
    ptyManager.spawn(req),
  );

  ipcMain.on(IpcChannel.PtyWrite, (_event, msg: PtyWriteMessage) => {
    ptyManager.write(msg.sessionId, msg.data);
  });

  ipcMain.on(IpcChannel.PtyResize, (_event, msg: PtyResizeMessage) => {
    ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
  });

  ipcMain.on(IpcChannel.PtyKill, (_event, msg: PtyKillMessage) => {
    ptyManager.kill(msg.sessionId);
  });

  // --- Project registry (ADR-0004) ---------------------------------------
  // The single backend arbitrates which Window manages which repo. Ownership
  // is keyed on the calling Window's webContents id, so the same pure registry
  // that unit tests exercise decides here — the handlers only translate.

  ipcMain.handle(
    IpcChannel.ProjectOpen,
    (event, req: ProjectOpenRequest): ProjectActionResult => {
      const windowId = String(event.sender.id);
      // The Window is now driving its own Project choice, so any queued auto-open
      // target for it has served its purpose — drop it so a later list read
      // can't re-trigger it (issue 14).
      pendingOpen.delete(event.sender.id);
      // A Project must be opened by an explicit path. We do NOT fall back to the
      // backend cwd here (issue 14): silently claiming the app's own repo is
      // exactly the phantom-claim bug. An empty path fails registration below
      // with a clear message; opening mission-control's own repo requires the
      // user to type that path.
      const key = normalizeRepoPath(req.repoPath);
      // Register the repo the first time we see it; then claim it for this
      // Window. Claiming is what rejects a second Window on the same repo.
      if (!findProject(registry, key)) {
        const reg = registerProject(registry, key, req.initialStage);
        if (!reg.ok) return applyResult(reg, windowId);
        registry = reg.registry;
      }
      return applyResult(claimProject(registry, key, windowId), windowId);
    },
  );

  ipcMain.handle(
    IpcChannel.ProjectSwitch,
    (event, req: ProjectSwitchRequest): ProjectActionResult =>
      applyResult(
        switchActiveProject(registry, String(event.sender.id), req.repoPath),
        String(event.sender.id),
      ),
  );

  ipcMain.handle(
    IpcChannel.ProjectTransition,
    (event, req: ProjectTransitionRequest): ProjectActionResult =>
      applyResult(
        transitionStage(registry, req.repoPath, req.toStage),
        String(event.sender.id),
      ),
  );

  ipcMain.handle(IpcChannel.ProjectList, (event): ProjectListResult => {
    const windowId = String(event.sender.id);
    // Peek the queued target — do NOT delete it here. Multiple list reads race
    // on a Window's bootstrap (StrictMode double-mount + the registry-changed
    // listener); deleting on read let a duplicate read drink the pending path
    // and the bootstrap then fell back to the app's own cwd (issue 14). The
    // pending entry is cleared when the Window actually opens a Project, or when
    // it closes — so every racing read sees the same target until it's acted on.
    return {
      projects: projectViewsFor(windowId),
      activeRepoPath: activeRepoFor(windowId),
      pendingOpen: pendingOpen.get(event.sender.id) ?? null,
    };
  });

  // Native folder chooser (issue 19): Browse… for a Project repo instead of
  // pasting a path. A thin shell over Electron's `dialog.showOpenDialog` — all
  // decisions (which path was chosen / cancel = no-op, where to start) live in
  // the unit-tested pure `folder-picker` module. The dialog is parented to the
  // calling Window so it's modal to it. Cancel → `path: null`; the renderer then
  // does nothing, so no empty-path open ever happens.
  ipcMain.handle(
    IpcChannel.ProjectPickFolder,
    async (event): Promise<ProjectPickFolderResult> => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const defaultPath = resolvePickerDefaultPath(lastPickedFolder, homedir());
      const result = await (parent
        ? dialog.showOpenDialog(parent, {
            title: 'Choose a Project folder',
            properties: ['openDirectory'],
            defaultPath,
          })
        : dialog.showOpenDialog({
            title: 'Choose a Project folder',
            properties: ['openDirectory'],
            defaultPath,
          }));
      const path = resolvePickedFolder(result);
      // Remember a real choice so the next Browse… starts there; a cancel
      // (null) leaves the last location untouched.
      if (path) lastPickedFolder = path;
      return { path };
    },
  );

  ipcMain.handle(
    IpcChannel.WindowOpen,
    (_event, req: WindowOpenRequest): WindowOpenResult => {
      createWindow(req.repoPath ? normalizeRepoPath(req.repoPath) : undefined);
      return { ok: true };
    },
  );

  // NOTE (issue 57, ADR-0013): there is deliberately NO handler that parses a
  // Run's buffered PTY output into a completion record. Receipts (the watch
  // below) are the SOLE capture input; the tail buffer survives in the PTY
  // Session Manager for human peek/debug only.

  // Load a Project's persisted Run log for the Execution view feed (issue 34).
  // A non-owner gets an empty log rather than another Window's history.
  ipcMain.handle(
    IpcChannel.RunLogLoad,
    async (event, req: RunLogLoadRequest): Promise<RunLogLoadResult> => {
      if (ownershipError(event, req.projectPath)) return { records: [] };
      return { records: await runLogStore.read(req.projectPath) };
    },
  );

  // Receipt capture edge (issue 56, ADR-0013): watch the Project's
  // `issues/completions/` — the checkout's, plus each live worktree's copy (the
  // renderer names the worktree slugs; the paths are main's own convention) —
  // and, for each genuinely-new Receipt (debounced, deduped by issue +
  // `finished`), persist it to the Run log and push it to the owning Window.
  // From there it enters the EXISTING feed pipeline (noise floor, lifecycle
  // derivation, Run-log card) exactly where scroll-captured records enter.
  // A non-owner must not watch (or write the log for) a repo it doesn't drive.
  ipcMain.on(IpcChannel.ReceiptWatch, (event, req: ReceiptWatchRequest) => {
    const sender = event.sender;
    const key = String(sender.id);
    if (ownershipError(event, req.projectPath)) {
      receiptWatcher.unwatch(key);
      return;
    }
    const roots = [
      join(req.projectPath, 'issues'),
      ...req.worktreeSlugs.map((slug) => join(worktreePathFor(req.projectPath, slug), 'issues')),
    ];
    void seenReceiptsFor(req.projectPath).then((seen) => {
      // The Window may have gone away while the seed read ran.
      if (sender.isDestroyed()) return;
      receiptWatcher.watch(key, roots, seen, (record) => {
        // Persist first (the durable Run log is the record of truth, ADR-0009);
        // a failed append still surfaces the record live rather than dropping it.
        void runLogStore.append(req.projectPath, record).catch(() => {});
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.ReceiptCaptured, { projectPath: req.projectPath, record });
        }
      });
    });
    // Close this Window's Receipt watch when its renderer goes away, so
    // watchers never outlive the Window that needed them.
    sender.once('destroyed', () => receiptWatcher.unwatch(key));
  });
}

app.whenReady().then(() => {
  runLogStore = new RunLogStore(app.getPath('userData'));
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  backlogWatcher.closeAll();
  receiptWatcher.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptyManager.killAll();
  backlogWatcher.closeAll();
  receiptWatcher.closeAll();
});
