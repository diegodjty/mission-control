/**
 * Electron main process — the single backend/coordinator.
 *
 * Boots the app, opens one Project Window (renderer), and wires the IPC
 * Contract to the PTY Session Manager so keystrokes and output round-trip
 * between xterm.js (renderer) and node-pty (here in main).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { PtySessionManager } from './pty-session-manager';
import { readBacklog } from './backlog-reader';
import { BacklogWatcher } from './backlog-watcher';
import { applyIsolation, readIsolatedIssueStatus } from './git-worktree-adapter';
import { mergeRuns } from './run-merge';
import {
  IpcChannel,
  type BacklogLoadRequest,
  type BacklogLoadResult,
  type BacklogWatchRequest,
  type IsolationApplyRequest,
  type IssueStatusObserveRequest,
  type IssueStatusObserveResult,
  type MergeRunsRequest,
  type ProjectActionResult,
  type ProjectListResult,
  type ProjectOpenRequest,
  type ProjectSwitchRequest,
  type ProjectTransitionRequest,
  type ProjectView,
  type PtyKillMessage,
  type PtyResizeMessage,
  type PtySpawnRequest,
  type PtyWriteMessage,
  type WindowOpenRequest,
  type WindowOpenResult,
} from '../shared/ipc-contract';
import {
  emptyRegistry,
  registerProject,
  claimProject,
  switchActiveProject,
  transitionStage,
  closeWindow,
  findProject,
  normalizeRepoPath,
  type ProjectRegistry,
  type RegistryResult,
} from '../shared/project-registry';

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
    async (_event, req: IssueStatusObserveRequest): Promise<IssueStatusObserveResult> => ({
      status: await readIsolatedIssueStatus(req.projectPath, req.slug),
    }),
  );

  // Isolation lifecycle (ADR-0002): the Git/Worktree Adapter reconciles the
  // active Run set to solo-on-main or a worktree-per-Run, and hands back each
  // Run's cwd for the PTY spawn below.
  ipcMain.handle(IpcChannel.IsolationApply, (_event, req: IsolationApplyRequest) =>
    applyIsolation(req.projectPath, req.runs),
  );

  // Merge (ADR-0002): human-triggered only. Integrates the finished parallel
  // Runs' `afk/NN-slug` branches into main via afk-merge.sh, then cleans up the
  // worktrees. Never invoked automatically — the renderer calls this in direct
  // response to the user clicking Merge.
  ipcMain.handle(IpcChannel.MergeRuns, (_event, req: MergeRunsRequest) =>
    mergeRuns(req.projectPath, req.slugs),
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

  ipcMain.handle(
    IpcChannel.WindowOpen,
    (_event, req: WindowOpenRequest): WindowOpenResult => {
      createWindow(req.repoPath ? normalizeRepoPath(req.repoPath) : undefined);
      return { ok: true };
    },
  );
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  backlogWatcher.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptyManager.killAll();
  backlogWatcher.closeAll();
});
