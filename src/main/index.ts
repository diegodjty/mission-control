/**
 * Electron main process — the single backend/coordinator.
 *
 * Boots the app, opens one Project Window (renderer), and wires the IPC
 * Contract to the PTY Session Manager so keystrokes and output round-trip
 * between xterm.js (renderer) and node-pty (here in main).
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PtySessionManager } from './pty-session-manager';
import { AttentionLastSeenStore } from './attention-last-seen';
import { AttentionWatcher } from './attention-watcher';
import { readBacklogAt } from './backlog-reader';
import { BacklogWatcher } from './backlog-watcher';
import { resolveProjectIdentity } from './project-resolver';
import {
  applyIsolation,
  commitFinishedMain,
  commitFinishedWorktree,
  detectDefaultBranch,
  discardWorktree,
  isMidMerge,
  readIsolatedIssueStatus,
  readIssueStatusAt,
  scanAfkBranches,
  worktreePathFor,
} from './git-worktree-adapter';
import { mergeRuns, abortMerge } from './run-merge';
import {
  probeMergeTreeSupport,
  readPreviewStamp,
  simulateSequence,
} from './merge-preview-adapter';
import { createPreviewCoordinator } from './merge-preview-coordinator';
import { scanReposWithPreviews } from './merge-preview-scan';
import { GIT_FLOOR_NOTE } from '../shared/git-version';
import { RunLogStore } from './run-log-store';
import { ReceiptWatcher } from './receipt-watcher';
import { PlanningWatcher } from './planning-watcher';
import { commitWorkbenchPaths, commitWorkbenchProject } from './workbench-git';
import { createWorkbenchProject } from './onboarding';
import { listWorkbenchProjectNames } from './workbench-projects';
import { registerAppearedRepo } from './register-repo';
import { deleteIssueFile, readIssueText, writeIssueText } from './issue-file-store';
import { readCoreMemory, writeDrainJournal } from './memory-files';
import {
  buildProjectGrid,
  buildQuickFixIssue,
  localDateStamp,
  nextIssueNumber,
  padIssueNumber,
  quickFixFileName,
  sortLauncherProjects,
  type ProjectCardSignals,
} from '../shared/launcher-model';
import { removeRegistryProject } from '../shared/workbench-model';
import { isAllowedPlanningDoc } from '../shared/planning-model';
import {
  claimEventsBetween,
  receiptRunEvent,
  statusSnapshot,
  workbenchCommitMessage,
  type WorkbenchRunEvent,
} from '../shared/workbench-run-events';
import type { IssueStatus } from '../shared/backlog-model';
import type { AfkBranchFacts } from '../shared/worktree-scan';
import {
  IpcChannel,
  type AttentionMarkSeenResult,
  type AttentionSnapshot,
  type AfkScanRequest,
  type AfkScanResult,
  type AfkDiscardRequest,
  type AfkDiscardResult,
  type BacklogLoadRequest,
  type BacklogLoadResult,
  type BacklogWatchRequest,
  type DrainJournalRequest,
  type DrainJournalResult,
  type IsolationApplyRequest,
  type IsolationApplyResult,
  type IssueFileDeleteRequest,
  type IssueFileEditRequest,
  type IssueFileReadRequest,
  type IssueFileReadResult,
  type IssueFileWriteResult,
  type IssueStatusObserveRequest,
  type IssueStatusObserveResult,
  type LauncherListResult,
  type LauncherProject,
  type OnboardingCreateRequest,
  type OnboardingCreateResult,
  type ProjectGridResult,
  type ProjectRemoveRequest,
  type ProjectRemoveResult,
  type RepoRegisterRequest,
  type RepoRegisterResult,
  type PlanningDocReadRequest,
  type PlanningDocReadResult,
  type PlanningWatchRequest,
  type QuickFixCreateRequest,
  type QuickFixCreateResult,
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
  openProjectForWindow,
  activeProjectKeyFor,
  switchActiveProject,
  transitionStage,
  closeWindow,
  normalizeProjectKey,
  checkProjectOwnership,
  findProject,
  type ProjectRegistry,
  type RegistryResult,
} from '../shared/project-registry';
import type { ProjectIdentity } from '../shared/project-identity';
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

// Resolved Project identities (issue 71, ADR-0015), keyed by the normalized
// project key. Every opened handle — a repo path OR a workbench project dir —
// is resolved to ONE identity before it reaches the ownership registry, so two
// aliases of one Project always collapse to one key. The identity carries the
// resolved roots (issues, completions) and the default repo the git-flavored
// handlers below act on.
const projectIdentities = new Map<string, ProjectIdentity>();

/** The resolved identity for a project key, or null (defensive fallback). */
function identityFor(projectKey: string): ProjectIdentity | null {
  return projectIdentities.get(normalizeProjectKey(projectKey)) ?? null;
}

/** The resolved issues root for a project key (legacy shape when unknown). */
function issuesRootFor(projectKey: string): string {
  return identityFor(projectKey)?.issuesRoot ?? join(normalizeProjectKey(projectKey), 'issues');
}

/**
 * The git repo the project's repo-flavored operations (scan, commit, worktree,
 * merge, Run cwd) target when the request names none: the identity's default
 * repo — for a legacy Project that IS the key, so behavior is unchanged.
 */
function gitRepoFor(projectKey: string): string {
  return identityFor(projectKey)?.defaultRepoPath ?? normalizeProjectKey(projectKey);
}

/**
 * The git repo one repo-flavored request targets (issue 72): the request's
 * explicit `repoPath` when it names one of the Project's member repos, else
 * the default repo. Clamped to the identity's known repos so a stale/foreign
 * renderer path can never point a git mutation outside the Project.
 */
function requestRepoFor(projectKey: string, repoPath: string | undefined): string {
  const fallback = gitRepoFor(projectKey);
  if (repoPath === undefined || repoPath === '') return fallback;
  const identity = identityFor(projectKey);
  if (identity === null) return fallback;
  const requested = normalizeProjectKey(repoPath);
  if (requested === identity.defaultRepoPath || identity.repoPaths.includes(requested)) {
    return requested;
  }
  return fallback;
}

/**
 * Can a Run target host git worktrees (issue 94, ADR-0017)? A real member repo
 * can; a **repo-less** project's workspace root — the `defaultRepoPath` fallback
 * when the project declares no repos — cannot: it is not a git repo, so a
 * `git init` there would nest repos and worktrees can't be cut from it. A group
 * keyed on such a target serializes solo on the shared workspace-root tree
 * instead. Legacy and repo-backed Projects always report `true`, so their
 * isolation is byte-identical to before.
 */
function isIsolatableTarget(projectKey: string, repo: string): boolean {
  const identity = identityFor(projectKey);
  if (identity === null) return true;
  // A project with real member repos isolates as always; only a repo-less
  // project (no repos, default resolved to the workspace root) is unisolatable.
  if (identity.repoPaths.length > 0) return true;
  return repo !== identity.defaultRepoPath;
}

/**
 * The declared `repos:` keys whose directory does NOT yet exist on disk
 * (ADR-0017 planned-first, issue 96): a repo may be declared before it's
 * created. This is the fs half of the `planned` resolution outcome — the pure
 * `repoForIssue` grays/holds a `repo:` naming one of these keys. A key drops
 * out the instant its directory appears (a scaffold Run creates it, issue 95
 * registers it), so the Map's planned → real transition needs no extra
 * plumbing beyond the next ProjectView recompute. Legacy Projects have no
 * repos map, so this is always empty for them.
 */
function plannedRepoKeysFor(identity: ProjectIdentity | null): string[] {
  if (identity === null || identity.kind !== 'workbench') return [];
  return Object.entries(identity.repos)
    .filter(([, path]) => path.length === 0 || !existsSync(path))
    .map(([key]) => key);
}

/**
 * Every member repo a workbench Project's scan must cover (issue 72): the
 * CONFIG's repos (deduped), else just the default repo. Legacy: the repo.
 */
function scanReposFor(projectKey: string): string[] {
  const identity = identityFor(projectKey);
  if (identity === null) return [gitRepoFor(projectKey)];
  const repos = identity.repoPaths.length > 0 ? identity.repoPaths : [identity.defaultRepoPath];
  return [...new Set(repos)];
}

// --- Workbench auto-commit (issue 72, ADR-0015) ----------------------------
// MC auto-commits the WORKBENCH repo after each Run event — claim observed
// (backlog watcher diff), park / done + Receipt / blocked (Receipt ingest) —
// with `<project>: issue NN <event>` messages. Pure decisions (which events,
// which message) live in shared/workbench-run-events; the git side effect in
// workbench-git. Serialized through the repo serializer on the PROJECT key so
// a backlog-driven and a Receipt-driven commit never race in one repo. Code
// repos never receive these commits; legacy Projects never enter here.

/** The last-observed per-issue statuses per project key (claim-diff state). */
const workbenchStatusSnapshots = new Map<string, Map<number, IssueStatus>>();

function commitWorkbenchEvents(projectKey: string, events: WorkbenchRunEvent[]): void {
  const identity = identityFor(projectKey);
  if (identity === null || identity.kind !== 'workbench' || events.length === 0) return;
  for (const event of events) {
    const message = workbenchCommitMessage(identity.label, event);
    // Quiet by design: an idempotent no-op or a failed commit must never
    // interrupt a Run. The commit outcome is observable in the workbench log.
    void repoSerializer
      .run(normalizeProjectKey(identity.key), () =>
        commitWorkbenchProject(identity.key, message),
      )
      .catch(() => {});
  }
}

// Per-repo serializer (issue 31): even the single owning Window can fire
// overlapping repo-mutating IPC calls (a drain applying isolation while a
// finished Run auto-commits, a Merge racing a scan-driven commit). Git
// worktree/branch mutations on one repo aren't concurrency-safe, so every
// mutating handler runs its git work through this — same-repo work serializes,
// different repos still run in parallel.
const repoSerializer = createRepoSerializer();

// Merge previews (issue 104, ADR-0018). The git-version floor is probed ONCE at
// backend start; until it resolves, previews stay off (no badges, no note) so we
// never flash a misleading "git too old" note on a machine that in fact supports
// it. `done` gates the note; `supported` gates the badges.
let previewProbe: { done: boolean; supported: boolean } = { done: false, supported: false };
void probeMergeTreeSupport()
  .then((supported) => {
    previewProbe = { done: true, supported };
  })
  .catch(() => {
    previewProbe = { done: true, supported: false };
  });

// The per-repo verdict cache + coalesced recompute scheduler. It queues its
// recomputes through the SHARED `repoSerializer`, so a background simulation
// never races a real Merge / worktree-commit on the same repo (ADR-0018).
const previewCoordinator = createPreviewCoordinator({
  serializer: repoSerializer,
  isSupported: () => previewProbe.supported,
  simulate: (repoPath, stamp) => simulateSequence(repoPath, stamp),
});

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
  projectKey: string,
): string | null {
  const check = checkProjectOwnership(registry, projectKey, String(event.sender.id));
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
  return registry.projects.map((p) => {
    const identity = identityFor(p.key);
    return {
      key: p.key,
      kind: identity?.kind ?? 'legacy',
      label: identity?.label ?? p.key.split('/').filter(Boolean).pop() ?? p.key,
      issuesRoot: issuesRootFor(p.key),
      completionsRoot:
        identity?.completionsRoot ??
        join(normalizeProjectKey(p.key), 'issues', 'completions'),
      defaultRepoPath: gitRepoFor(p.key),
      repos: identity?.repos ?? {},
      plannedRepoKeys: plannedRepoKeysFor(identity),
      stage: p.stage,
      ownership:
        p.ownerWindowId === null ? 'free' : p.ownerWindowId === windowId ? 'you' : 'other',
    };
  });
}

/**
 * The key of the Project a Window actively manages right now, or null.
 * Delegates to the pure `activeProjectKeyFor`, whose answer is unambiguous
 * because every ownership flow (open/switch/close) keeps a Window on at most
 * ONE Project (issue 87) — never a "first of several owned" guess (issue 88).
 */
function activeKeyFor(windowId: string): string | null {
  return activeProjectKeyFor(registry, windowId);
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
    activeProjectKey: activeKeyFor(windowId),
    projects: projectViewsFor(windowId),
  };
}

/** Broadcast a PTY event to every open Window; each Pane filters by sessionId. */
function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// Live Run sessions per workbench project (issue 118). The single backend
// spawns every Run PTY, so it is the ONE place with the global "how many Runs
// are live in each Project" picture the run-coordinator / Dispatcher drive —
// the home grid's "N running" liveness and its attention-float ordering read
// from here. Keyed sessionId → workbench project dir name (matching the
// attention watch's `project` and the launcher gather's `dirName`); a Run maps
// to its project via the workbench issues root its target carries. Non-Run and
// legacy spawns never enter, so they contribute zero to every card.
const runSessionProject = new Map<string, string>();

/** Live-Run count per workbench project dir name, tallied from the session map. */
function liveRunsByProject(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dirName of runSessionProject.values()) {
    counts.set(dirName, (counts.get(dirName) ?? 0) + 1);
  }
  return counts;
}

// One PTY Session Manager for the app. With many Windows on one backend, PTY
// output is broadcast to every Window and each Pane reacts only to its own
// sessionId — so a session started in one Window still round-trips correctly.
const ptyManager = new PtySessionManager({
  onData: (msg) => broadcast(IpcChannel.PtyData, msg),
  onExit: (msg) => {
    broadcast(IpcChannel.PtyExit, msg);
    // A finished Run frees a live slot — re-shape the home grid (issue 118) via
    // the EXISTING registry-changed subscription, so "N running" and the
    // attention-float update live even when the exit isn't accompanied by a
    // backlog flip (e.g. a Run the user stopped, leaving its issue `wip`).
    if (runSessionProject.delete(msg.sessionId)) broadcastRegistryChanged();
  },
});

// One Backlog Watcher for the app; keyed per renderer WebContents so a Window
// that closes (or re-points at another Project) never leaks a watcher.
const backlogWatcher = new BacklogWatcher();

// The durable Run log (issue 34, ADR-0009): per-Project Completion-block records
// under the app's userData dir, so the Execution view's feed survives closing
// Panes and app restarts. Instantiated in `whenReady` (needs `app.getPath`).
let runLogStore: RunLogStore;

// The cross-project attention watch (issue 79, ADR-0016): ONE app-level
// background service — not per-Window — that watches every `status: active`
// registry project's workbench dirs (open in a Window or not), re-derives the
// pure attention model on change, and broadcasts the aggregated list to every
// Window. Read-only by contract: it never writes or commits to any workbench.
// Instantiated in `whenReady`; torn down on quit (NOT on window-all-closed —
// on macOS the app outlives its Windows, and the Inbox must keep watching).
let attentionWatcher: AttentionWatcher | null = null;

// The workbench root the attention watch (and Inbox click-through) keys on.
const WORKBENCH_ROOT = join(homedir(), 'Workbench');

// The briefing's last-seen stamps (issue 80, ADR-0016): app-level state in
// userData — reading the Inbox must never create workbench commits. Loaded in
// `whenReady` BEFORE the attention watcher starts, so its `lastSeenFor` hook
// answers from memory, synchronously.
let attentionLastSeen: AttentionLastSeenStore;

// The Receipt capture edge (issue 56, ADR-0013): watches each Project's
// `issues/completions/` (checkout + live worktrees) for Worker Receipts, keyed
// per renderer WebContents like the Backlog Watcher, so a closing Window never
// leaks a watch.
const receiptWatcher = new ReceiptWatcher();

// The Planning view's live doc watch (issue 83, ADR-0016): per-renderer, over
// the project's planning roots (workbench PRDs + issues, repo CONTEXT/ADRs).
// Read-only by contract — it stats and reads docs, never writes.
const planningWatcher = new PlanningWatcher();

// Per-Project dedupe memory for the Receipt edge: record id (issue + finished)
// → fingerprint of the ingested content, or null for ids seeded from the
// persisted Run log (an MC restart must not re-feed Receipts already captured
// in an earlier session — ADR-0013). Cached as a promise per normalised repo
// path so concurrent watch requests share ONE seeding read and one live map.
const receiptSeenByProject = new Map<string, Promise<Map<string, string | null>>>();

function seenReceiptsFor(projectPath: string): Promise<Map<string, string | null>> {
  const key = normalizeProjectKey(projectPath);
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
      // The request names the Project KEY; the identity says where its issue
      // files actually live (in-workbench or in-repo — issue 71). The key is
      // echoed back so the renderer matches pushes to the Project it shows.
      const projectPath = req.projectPath?.trim() || process.cwd();
      try {
        const backlog = await readBacklogAt(issuesRootFor(projectPath));
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
    const projectKey = normalizeProjectKey(req.projectPath);
    const issuesRoot = issuesRootFor(req.projectPath);
    const isWorkbench = identityFor(req.projectPath)?.kind === 'workbench';
    // Seed the workbench claim-diff snapshot from the CURRENT on-disk state
    // (issue 72): an MC (re)start over an already-claimed backlog must observe
    // no events. Only the first watch of a project seeds; later re-points keep
    // the running diff state.
    if (isWorkbench && !workbenchStatusSnapshots.has(projectKey)) {
      void readBacklogAt(issuesRoot)
        .then((backlog) => {
          // A change push may have installed a FRESHER snapshot while this
          // seed read ran — never overwrite it with the older state.
          if (!workbenchStatusSnapshots.has(projectKey)) {
            workbenchStatusSnapshots.set(projectKey, statusSnapshot(backlog));
          }
        })
        .catch(() => {});
    }
    // Watch the Project's RESOLVED issues root (issue 71) — the watcher keys
    // on the Project identity, not on a repo path.
    backlogWatcher.watch(
      key,
      { projectPath: req.projectPath, issuesRoot },
      (result) => {
        // Workbench auto-commit on claim observed (issue 72): diff the pushed
        // backlog against the last snapshot; each fresh `wip` is one claim
        // event → one `<project>: issue NN claim` commit. Diff-based, so a
        // re-observation of unchanged statuses commits nothing. An error push
        // (backlog null) keeps the old snapshot — never mistaken for change.
        if (isWorkbench && result.backlog !== null) {
          const next = statusSnapshot(result.backlog);
          const prev = workbenchStatusSnapshots.get(projectKey) ?? null;
          workbenchStatusSnapshots.set(projectKey, next);
          commitWorkbenchEvents(req.projectPath, claimEventsBetween(prev, next));
        }
        if (!sender.isDestroyed()) sender.send(IpcChannel.BacklogChanged, result);
      },
    );
    // Close this Window's watcher when its renderer goes away, so watchers
    // never outlive the Window that needed them.
    sender.once('destroyed', () => backlogWatcher.unwatch(key));
  });

  // --- Issue-file Edit / Delete (issue 89, ADR-0016 finding) ---------------
  // The Map's one write exception: issue FILES. Decisions (what a valid save
  // is, why a delete is refused) live in the pure shared/issue-file-ops; the
  // fs work in main/issue-file-store. Like QuickFixCreate these are not
  // ownership-gated: writing/deleting a backlog file is exactly what a human
  // hand-edit in the workbench would be, and the owning Window's backlog
  // watch picks the change up like any other. Workbench projects get one
  // boring auto-commit per operation (`<project>: issue NN edited/deleted`)
  // through the same serialized commit path as every other Run event; legacy
  // projects leave the change uncommitted, as usual.
  const commitIssueFileOp = (projectKey: string, fileName: string, verb: string): void => {
    const identity = identityFor(projectKey);
    if (identity === null || identity.kind !== 'workbench') return;
    const num = /^(\d+)-/.exec(fileName)?.[1] ?? fileName;
    void repoSerializer
      .run(normalizeProjectKey(identity.key), () =>
        commitWorkbenchProject(identity.key, `${identity.label}: issue ${num} ${verb}`),
      )
      .catch(() => {});
  };

  ipcMain.handle(
    IpcChannel.IssueFileRead,
    async (_event, req: IssueFileReadRequest): Promise<IssueFileReadResult> => {
      const fileName = req?.fileName ?? '';
      const outcome = await readIssueText(issuesRootFor(req.projectPath), fileName);
      return { fileName, content: outcome.content, error: outcome.error };
    },
  );

  ipcMain.handle(
    IpcChannel.IssueFileEdit,
    async (_event, req: IssueFileEditRequest): Promise<IssueFileWriteResult> => {
      const outcome = await writeIssueText(
        issuesRootFor(req.projectPath),
        req?.fileName ?? '',
        req?.content ?? '',
      );
      if (outcome.ok) commitIssueFileOp(req.projectPath, req.fileName, 'edited');
      return outcome;
    },
  );

  ipcMain.handle(
    IpcChannel.IssueFileDelete,
    async (_event, req: IssueFileDeleteRequest): Promise<IssueFileWriteResult> => {
      const outcome = await deleteIssueFile(issuesRootFor(req.projectPath), req?.fileName ?? '');
      if (outcome.ok) commitIssueFileOp(req.projectPath, req.fileName, 'deleted');
      return outcome;
    },
  );

  // Observe an isolated Run's completion from its own worktree/branch (issue
  // 13): a parallel Run flips its issue to `done` inside its worktree, which
  // the main-checkout backlog watcher never sees. The renderer feeds this
  // worktree-observed status into the pure run-state selector for isolated Runs.
  ipcMain.handle(
    IpcChannel.IssueStatusObserve,
    async (event, req: IssueStatusObserveRequest): Promise<IssueStatusObserveResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { status: null, commitError: denied };
      return readIsolatedIssueStatus(requestRepoFor(req.projectPath, req.repoPath), req.slug);
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
      const repo = requestRepoFor(req.projectPath, req.repoPath);
      const identity = identityFor(req.projectPath);
      // A workbench Project's claim surface is the WORKBENCH (issue 72): the
      // `done` flip lands there, not in the code repo — read it there and
      // hand it to the adapter, and BYPASS the stray-Receipt adoption (no
      // Receipt ever belongs in a workbench Project's code repo).
      const workbenchOpts =
        identity?.kind === 'workbench'
          ? {
              statusOverride: await readIssueStatusAt(identity.issuesRoot, req.slug),
              adoptStrays: false,
            }
          : {};
      // Protected-branch guard (issue 113): the solo auto-commit lands on the
      // repo's current branch, so if that is `main`/`master` the commit is
      // withheld until the human confirms — the drain raises the "big warning".
      const commitOpts = {
        ...workbenchOpts,
        protectedBranchGuard: { confirmed: req.confirmProtectedLand ?? false },
      };
      return repoSerializer.run(normalizeProjectKey(repo), () =>
        commitFinishedMain(repo, req.slug, commitOpts),
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
      const repo = requestRepoFor(req.projectPath, req.repoPath);
      const identity = identityFor(req.projectPath);
      // Workbench (issue 72): the agent's `done` flip lives in the workbench,
      // not the worktree's own `issues/` — read the claim surface instead.
      const workbenchOpts =
        identity?.kind === 'workbench'
          ? { statusOverride: await readIssueStatusAt(identity.issuesRoot, req.slug) }
          : {};
      return repoSerializer.run(normalizeProjectKey(repo), () =>
        commitFinishedWorktree(repo, req.slug, workbenchOpts),
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
      if (ownershipError(event, req.projectPath)) {
        return { branches: [], midMerge: false, previews: [], previewNote: null };
      }
      const identity = identityFor(req.projectPath);
      // A workbench Project's scan spans EVERY member repo (issue 72) —
      // isolation is per repo, so in-flight/finished-unmerged Runs may live in
      // any of them — with the issue-status facts read from the workbench
      // claim surface. Legacy: the one repo, in-repo reads, unchanged. The
      // per-repo preview orchestration — independent caches, per-repo mid-merge
      // suspension, and legacy⇔workbench badge parity — lives in
      // `scanReposWithPreviews` (issue 108, ADR-0018) so it is unit-testable;
      // every git/coordinator touch below is injected as a dep. Previews are a
      // CACHE READ against the coordinator (the scan never computes) that queues
      // at most one coalesced recompute per repo through the shared serializer.
      const scanOpts =
        identity?.kind === 'workbench' ? { workbenchIssuesRoot: identity.issuesRoot } : {};
      const scan = await scanReposWithPreviews(scanReposFor(req.projectPath), {
        scanBranches: async (repo) =>
          (await scanAfkBranches(repo, scanOpts)).map(
            (b): AfkBranchFacts => ({ ...b, repoPath: repo }),
          ),
        isMidMerge,
        previewSupported: previewProbe.supported,
        detectDefaultBranch,
        readStamp: readPreviewStamp,
        readPreviews: (input) => previewCoordinator.read(input),
        serializerKeyFor: normalizeProjectKey,
      });
      return {
        branches: scan.branches,
        midMerge: scan.midMerge,
        previews: scan.previews,
        // One passive note (ADR-0018), only once the probe has run AND git is
        // below the floor — never a flash before the probe resolves.
        previewNote: previewProbe.done && !previewProbe.supported ? GIT_FLOOR_NOTE : null,
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
      const repo = requestRepoFor(req.projectPath, req.repoPath);
      return repoSerializer.run(normalizeProjectKey(repo), async () => {
        try {
          await discardWorktree(repo, req.slug);
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
    async (event, req: IsolationApplyRequest): Promise<IsolationApplyResult> => {
      // Reject a non-owner: a stale renderer must not create/tear down worktrees
      // on a repo the real owner is driving. Empty placements ⇒ no mutation.
      if (ownershipError(event, req.projectPath)) {
        return { parallel: false, placements: [] };
      }
      // Isolation keys on concurrency PER REPO (issue 72, ADR-0015): group the
      // Runs by the repo each targets (a Run without one falls into the
      // Project default — every legacy Run, byte-identical to today) and
      // reconcile each repo independently. Two concurrent Runs in different
      // repos are each solo in their own repo — no worktrees; 2+ in one repo
      // isolate exactly as always. Same-repo work serializes; different repos
      // reconcile in parallel.
      const defaultRepo = gitRepoFor(req.projectPath);
      const byRepo = new Map<string, typeof req.runs>();
      for (const run of req.runs) {
        const repo = requestRepoFor(req.projectPath, run.repoPath) || defaultRepo;
        const group = byRepo.get(repo);
        if (group) group.push(run);
        else byRepo.set(repo, [run]);
      }
      if (byRepo.size === 0) {
        // No Runs at all: reconcile the default repo to its solo ground state,
        // exactly as the single-repo path always did.
        return repoSerializer.run(normalizeProjectKey(defaultRepo), () =>
          applyIsolation(defaultRepo, [], {
            isolatable: isIsolatableTarget(req.projectPath, defaultRepo),
          }),
        );
      }
      const results = await Promise.all(
        [...byRepo.entries()].map(([repo, runs]) =>
          repoSerializer.run(normalizeProjectKey(repo), () =>
            applyIsolation(repo, runs, {
              // A repo-less project's workspace-root target can't host worktrees
              // (ADR-0017) — the group serializes solo instead of failing on a
              // `git worktree` against a non-git directory.
              isolatable: isIsolatableTarget(req.projectPath, repo),
            }),
          ),
        ),
      );
      return {
        parallel: results.some((r) => r.parallel),
        placements: results
          .flatMap((r) => r.placements)
          .sort((a, b) => a.issueId - b.issueId),
      };
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
      const repo = requestRepoFor(req.projectPath, req.repoPath);
      const identity = identityFor(req.projectPath);
      // Merge stays PER REPO (issue 72): a workbench Project's request names
      // which member repo's branches to integrate. Its stray-Receipt adoption
      // is BYPASSED (Receipts never live in a workbench Project's code repo —
      // dirt there is unknown state and keeps the truthful preflight halt),
      // and the merged-worktree sweep reads the workbench claim surface.
      const mergeOpts = {
        ...(identity?.kind === 'workbench'
          ? { adoptStrays: false, workbenchIssuesRoot: identity.issuesRoot }
          : {}),
        // Protected-branch guard (issue 113): a merge whose target is the repo's
        // checked-out `main`/`master` is withheld until the human confirms the
        // "big warning" — applies to the autonomous drain merge AND this same
        // handler's user-initiated Merge (both route through here).
        protectedBranchGuard: { confirmed: req.confirmProtectedLand ?? false },
      };
      return repoSerializer.run(normalizeProjectKey(repo), () =>
        mergeRuns(repo, req.slugs, mergeOpts),
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
      const repo = requestRepoFor(req.projectPath, req.repoPath);
      return repoSerializer.run(normalizeProjectKey(repo), () =>
        abortMerge(repo),
      );
    },
  );

  ipcMain.handle(IpcChannel.PtySpawn, async (_event, req: PtySpawnRequest) => {
    // Memory injection (issue 73, ADR-0015): a workbench Project's Worker
    // prompt and Dispatcher seed carry the project's curated `memory/CORE.md`,
    // read here at the edge (the renderer never holds file content). The pure
    // prompt builders cap and label it; a missing/empty CORE — and every
    // legacy or plain-shell spawn — injects nothing and spawns exactly as
    // before. The memory root is the workbench project dir's `memory/`,
    // beside the issues root the Run already carries.
    let memoryCore: string | null = null;
    // A Planning session's explicit Workbench artifact destination (issue 101):
    // set only for a planning talk on a workbench project, so /to-prd and
    // /to-issues write into the Workbench instead of the session's cwd.
    let talkDest: { issuesRoot: string; projectRoot: string } | null = null;
    if (req.run?.workbench) {
      memoryCore = await readCoreMemory(join(dirname(req.run.workbench.issuesRoot), 'memory'));
    } else if (req.dispatcher) {
      const identity = identityFor(req.dispatcher.projectPath);
      if (identity?.kind === 'workbench') {
        memoryCore = await readCoreMemory(join(identity.key, 'memory'));
      }
    } else if (req.talk?.workbenchProjectRoot) {
      // A talk Pane on a workbench project (issue 81): same CORE.md injection as
      // a Run/Dispatcher; a bare folder passes null and spawns with no prompt.
      const projectRoot = req.talk.workbenchProjectRoot;
      memoryCore = await readCoreMemory(join(projectRoot, 'memory'));
      if (req.talk.planning === true) {
        talkDest = { issuesRoot: join(projectRoot, 'issues'), projectRoot };
      }
    }
    const result = ptyManager.spawn(req, { memoryCore, talkDest });
    // Track a Run's live session per workbench project (issue 118) so the home
    // grid's "N running" liveness and attention-float reflect it immediately.
    // Only a Run with an explicit workbench (ADR-0015) maps to a card; the dir
    // name is the issues root's parent (`~/Workbench/<dir>/issues` → `<dir>`).
    // The registry-changed broadcast re-shapes any open home grid live.
    if (req.run?.workbench) {
      runSessionProject.set(result.sessionId, basename(dirname(req.run.workbench.issuesRoot)));
      broadcastRegistryChanged();
    }
    return result;
  });

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
    async (event, req: ProjectOpenRequest): Promise<ProjectActionResult> => {
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
      const opened = normalizeProjectKey(req.path);
      if (opened === '') {
        return applyResult(registerProject(registry, '', req.initialStage), windowId);
      }
      // Resolve the opened handle — a repo path or a workbench project dir —
      // to ONE canonical identity (issue 71, ADR-0015). Both aliases of a
      // workbench Project land on the same key here, BEFORE ownership is
      // decided, so no Project can be double-owned under two names.
      const identity = await resolveProjectIdentity(opened);
      projectIdentities.set(identity.key, identity);
      // Register the Project the first time we see it, then land the Window on
      // it with switch (release-then-claim) semantics — the whole decision is
      // the pure `openProjectForWindow`. A bare claim here was issue 87's
      // stale-switch: a Window that already owned another Project ended up
      // owning both, and its active Project (selector, Map, watchers) never
      // moved to the one just clicked. Owned-by-another-Window is still
      // rejected inside, exactly as before.
      return applyResult(
        openProjectForWindow(registry, identity.key, windowId, req.initialStage),
        windowId,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.ProjectSwitch,
    (event, req: ProjectSwitchRequest): ProjectActionResult =>
      applyResult(
        switchActiveProject(registry, String(event.sender.id), req.key),
        String(event.sender.id),
      ),
  );

  ipcMain.handle(
    IpcChannel.ProjectTransition,
    (event, req: ProjectTransitionRequest): ProjectActionResult =>
      applyResult(
        transitionStage(registry, req.key, req.toStage),
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
      activeProjectKey: activeKeyFor(windowId),
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
      // Queue the raw path; the new Window's bootstrap opens it through
      // ProjectOpen, where identity resolution happens exactly once.
      createWindow(req.path ? normalizeProjectKey(req.path) : undefined);
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
    // WHERE Receipts land (issue 72, ADR-0015): a workbench Project's
    // Receipts live in `~/Workbench/<project>/completions/` — ONE watch root
    // (the project root; the watcher looks for `completions/*.md` beneath it),
    // no per-worktree Receipt roots, whatever repo or worktree the Worker ran
    // in. A legacy Project keeps today's roots exactly: the repo checkout's
    // `issues/` plus each live worktree's copy.
    const identity = identityFor(req.projectPath);
    const isWorkbench = identity?.kind === 'workbench';
    const runRepo = gitRepoFor(req.projectPath);
    const roots = isWorkbench
      ? [identity!.key]
      : [
          join(runRepo, 'issues'),
          ...req.worktreeSlugs.map((slug) => join(worktreePathFor(runRepo, slug), 'issues')),
        ];
    void seenReceiptsFor(req.projectPath).then((seen) => {
      // The Window may have gone away while the seed read ran.
      if (sender.isDestroyed()) return;
      receiptWatcher.watch(key, roots, seen, (record) => {
        // Persist first (the durable Run log is the record of truth, ADR-0009);
        // a failed append still surfaces the record live rather than dropping it.
        void runLogStore.append(req.projectPath, record).catch(() => {});
        // Workbench auto-commit on the Receipt-declared Run event (issue 72):
        // done (flip + Receipt as ONE commit), park, or blocked. Deduped by
        // the ingest edge (issue + finished), so a re-scan re-fires nothing.
        if (isWorkbench) {
          const runEvent = receiptRunEvent(record.issueId, record.outcome);
          if (runEvent !== null) commitWorkbenchEvents(req.projectPath, [runEvent]);
        }
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.ReceiptCaptured, { projectPath: req.projectPath, record });
        }
      });
    });
    // Close this Window's Receipt watch when its renderer goes away, so
    // watchers never outlive the Window that needed them.
    sender.once('destroyed', () => receiptWatcher.unwatch(key));
  });

  // The current aggregated attention snapshot (issue 79): a pull for freshly
  // opened Windows; live updates arrive on the AttentionChanged broadcast.
  // Not ownership-gated on purpose — the Inbox is a cross-project, read-only
  // surface every Window shows (acting on an item goes through open/claim).
  ipcMain.handle(
    IpcChannel.AttentionList,
    (): AttentionSnapshot =>
      attentionWatcher?.snapshot ?? { workbenchRoot: WORKBENCH_ROOT, items: [], notes: [] },
  );

  // The Inbox was viewed (issue 80): advance every watched project's briefing
  // last-seen stamp to now, persist in app userData, and re-derive so already-
  // seen journal entries drop out of the next snapshot. Not ownership-gated
  // (the Inbox is a cross-project surface every Window shows) and — by the
  // same read-only contract as the watch itself — this writes NOTHING to any
  // workbench: the stamp is app-level state.
  ipcMain.handle(IpcChannel.AttentionMarkSeen, async (): Promise<AttentionMarkSeenResult> => {
    const projects = attentionWatcher?.watchedProjects ?? [];
    const lastSeen = await attentionLastSeen.markAll(projects, new Date().toISOString());
    attentionWatcher?.rederiveAll();
    return { lastSeen };
  });

  // Drain journal (issue 73, ADR-0015): when a drain ends (any stop reason),
  // ONE dated summary entry lands in the workbench project's `memory/journal/`
  // — every Run with its declared outcome, doc-drift flags, notable events —
  // built by the pure `shared/workbench-memory` from THIS drain's Run-log
  // records, written once (no clobber; a second drain the same day gets its
  // own file), then auto-committed via the issue-72 workbench commit path.
  // A legacy Project has no memory dir: the call is a quiet no-op.
  ipcMain.handle(
    IpcChannel.DrainJournal,
    async (event, req: DrainJournalRequest): Promise<DrainJournalResult> => {
      const denied = ownershipError(event, req.projectPath);
      if (denied) return { written: false, path: null, error: denied };
      const identity = identityFor(req.projectPath);
      if (identity === null || identity.kind !== 'workbench') {
        return { written: false, path: null, error: null };
      }
      const outcome = await writeDrainJournal({
        memoryRoot: join(identity.key, 'memory'),
        endedAt: new Date().toISOString(),
        reason: req.reason,
        records: req.records,
        notables: req.notables,
      });
      if (outcome.written && outcome.fileName !== null) {
        // Same quiet, serialized commit discipline as the Run-event commits:
        // an idempotent no-op or a failed commit must never surface as a
        // drain error — the outcome is observable in the workbench log.
        void repoSerializer
          .run(normalizeProjectKey(identity.key), () =>
            commitWorkbenchProject(
              identity.key,
              `${identity.label}: drain journal ${outcome.fileName}`,
            ),
          )
          .catch(() => {});
      }
      return { written: outcome.written, path: outcome.path, error: outcome.error };
    },
  );

  // --- Launcher (issue 81, ADR-0016) ----------------------------------------

  /** Read a file's text, or null when missing/unreadable — never throw. */
  const readOrNull = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  };

  /** The most recent file mtime across the given dirs (ISO), or null. */
  const latestActivityIso = async (dirs: string[]): Promise<string | null> => {
    let latest: number | null = null;
    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          try {
            const s = await stat(join(dir, entry.name));
            if (latest === null || s.mtimeMs > latest) latest = s.mtimeMs;
          } catch {
            // A file racing deletion just doesn't count.
          }
        }
      } catch {
        // A project may not have this dir yet (empty backlog) — fine.
      }
    }
    return latest === null ? null : new Date(latest).toISOString();
  };

  // Gather every workbench project — a `status: active` registry project OR a
  // repo-less project directory (a CONFIG.md with an empty repos map; ADR-0017
  // defers its registration, so it has no registry entry — issue 99) — open in
  // a Window or not, with truthful backlog counts and a last-activity stamp,
  // most recent first. Read-only: gathering never claims, writes, or commits.
  // Shared by the Launcher's Continue list (LauncherList) and the project-first
  // home grid (ProjectGrid, issue 115) so both see the same signals.
  const gatherLauncherProjects = async (): Promise<LauncherProject[]> => {
    const names = await listWorkbenchProjectNames(WORKBENCH_ROOT);
    const projects = await Promise.all(
      names.map(async (name): Promise<LauncherProject> => {
        // The same identity resolution the open flow uses (issue 71), aimed at
        // the workbench dir — so Continue/Quick fix/Just talk act on exactly
        // the handles a normal open would resolve.
        const identity = await resolveProjectIdentity(join(WORKBENCH_ROOT, name));
        const counts = { open: 0, wip: 0, done: 0 };
        try {
          const backlog = await readBacklogAt(identity.issuesRoot);
          for (const issue of backlog.issues) counts[issue.status] += 1;
        } catch {
          // No issues dir yet (a fresh project) — truthful zero counts.
        }
        return {
          dirName: name,
          label: identity.label,
          workbenchDir: identity.key,
          defaultRepoPath: identity.defaultRepoPath,
          issuesRoot: identity.issuesRoot,
          completionsRoot: identity.completionsRoot,
          counts,
          lastActivity: await latestActivityIso([identity.issuesRoot, identity.completionsRoot]),
        };
      }),
    );
    return sortLauncherProjects(projects);
  };

  // The Launcher's Continue project list (issue 81) — the gathered signals as-is.
  ipcMain.handle(IpcChannel.LauncherList, async (): Promise<LauncherListResult> => {
    return { projects: await gatherLauncherProjects() };
  });

  // The project-first home grid (issue 115/118, ADR-0019): the portfolio
  // aggregator — a thin adapter. It gathers each Project's `LauncherProject`
  // signals (backlog counts + last-activity) and JOINS the full-card signals
  // issue 118 adds — parked HITL from the SAME watch that feeds the Inbox, the
  // live-Run count from the run-session tally, and per-Project stage (registry)
  // + repo-less (identity) — then delegates ALL shaping and ordering to the pure
  // card model (`buildProjectGrid`). Read-only, parallel to LauncherList; the
  // renderer keeps it live off the existing registry + backlog + attention
  // subscriptions (no new watcher here).
  ipcMain.handle(IpcChannel.ProjectGrid, async (): Promise<ProjectGridResult> => {
    const projects = await gatherLauncherProjects();
    // Parked HITL per project — count `hitl-park` items (grouped by their
    // workbench project dir name) from the background attention watch's snapshot,
    // the same source the Inbox reads. No snapshot yet ⇒ zero everywhere.
    const parked = new Map<string, number>();
    for (const item of attentionWatcher?.snapshot.items ?? []) {
      if (item.kind === 'hitl-park') parked.set(item.project, (parked.get(item.project) ?? 0) + 1);
    }
    const live = liveRunsByProject();
    // Repo-less per project — a repo-less Project (ADR-0017) has no member repos.
    // Resolved once here (the same resolution the gather uses) so `signalsFor`
    // stays synchronous for the pure model.
    const repoless = new Map<string, boolean>();
    await Promise.all(
      projects.map(async (p) => {
        try {
          const identity = await resolveProjectIdentity(p.workbenchDir);
          repoless.set(p.workbenchDir, identity.repoPaths.length === 0);
        } catch {
          repoless.set(p.workbenchDir, false);
        }
      }),
    );
    const signalsFor = (p: LauncherProject): ProjectCardSignals => ({
      liveRuns: live.get(p.dirName) ?? 0,
      parkedHitl: parked.get(p.dirName) ?? 0,
      // Stage lives in the in-memory registry (ADR-0004), populated for Projects
      // opened in a Window; an unopened card shows the app's default stage.
      stage: findProject(registry, p.workbenchDir)?.stage ?? 'backlog',
      repoless: repoless.get(p.workbenchDir) ?? false,
    });
    return { cards: buildProjectGrid(projects, signalsFor, new Date()) };
  });

  // Quick fix (issue 81): one sentence → a well-formed standalone issue in the
  // chosen project's workbench backlog, auto-committed via the existing
  // issue-72 workbench commit path. Not ownership-gated: the backlog is the
  // workbench claim surface — writing an `open` issue there is exactly what a
  // human hand-adding a file would do, and the owning Window's backlog watch
  // picks it up like any other change.
  ipcMain.handle(
    IpcChannel.QuickFixCreate,
    async (_event, req: QuickFixCreateRequest): Promise<QuickFixCreateResult> => {
      const fail = (error: string): QuickFixCreateResult => ({
        ok: false,
        error,
        issueId: null,
        fileName: null,
        title: null,
      });
      const sentence = (req.sentence ?? '').replace(/\s+/g, ' ').trim();
      if (sentence.length === 0) return fail('Type one sentence describing the fix.');
      try {
        const identity = await resolveProjectIdentity(normalizeProjectKey(req.workbenchDir));
        if (identity.kind !== 'workbench') {
          return fail(
            'Quick fix writes to a workbench backlog — this project has none (ADR-0015).',
          );
        }
        await mkdir(identity.issuesRoot, { recursive: true });
        // `wx` never clobbers: a number race (another writer taking the same
        // NN) surfaces as EEXIST and we re-list and re-number.
        for (let attempt = 0; attempt < 5; attempt++) {
          const existing = await readdir(identity.issuesRoot);
          const id = nextIssueNumber(existing);
          const fileName = quickFixFileName(id, sentence);
          const content = buildQuickFixIssue({
            id,
            sentence,
            // The user's LOCAL calendar day (issue 88) — a UTC slice stamped
            // an evening quick fix with tomorrow's date.
            date: localDateStamp(new Date()),
          });
          try {
            await writeFile(join(identity.issuesRoot, fileName), content, {
              encoding: 'utf8',
              flag: 'wx',
            });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
          }
          // The existing workbench auto-commit path (issue 72): serialized on
          // the project key so it can't race a Run-event commit; quiet on
          // failure — the backlog write itself already succeeded.
          const num = padIssueNumber(id);
          void repoSerializer
            .run(normalizeProjectKey(identity.key), () =>
              commitWorkbenchProject(identity.key, `${identity.label}: issue ${num} quick fix`),
            )
            .catch(() => {});
          return {
            ok: true,
            error: null,
            issueId: id,
            fileName,
            title: `${num} — ${sentence}`,
          };
        }
        return fail('Could not find a free issue number (concurrent writers?) — try again.');
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // New project (issue 82, ADR-0016): the Launcher's guided onboarding. All
  // validation lives in the pure onboarding model; the edge work (project
  // skeleton, registry append, ONE boring workbench commit) in
  // `main/onboarding.ts`. Not ownership-gated — creating a project claims
  // nothing; the Window lands on it through the normal open flow afterward.
  ipcMain.handle(
    IpcChannel.OnboardingCreate,
    async (_event, req: OnboardingCreateRequest): Promise<OnboardingCreateResult> => {
      const outcome = await createWorkbenchProject({
        workbenchRoot: WORKBENCH_ROOT,
        homeDir: homedir(),
        name: req?.name ?? '',
        repos: Array.isArray(req?.repos) ? req.repos : [],
        workspaceRoot: req?.workspaceRoot,
        dryRun: req?.dryRun === true,
      });
      return {
        ok: outcome.ok,
        errors: outcome.errors,
        warnings: outcome.warnings,
        dirName: outcome.dirName,
        workbenchDir: outcome.workbenchDir,
      };
    },
  );

  // Remove project (issue 92): the inverse of onboarding's registry append —
  // drop every registry.md entry mapping to the chosen workbench project, so
  // the Launcher, the attention watch, and session resolution stop seeing it.
  // Deliberately NON-destructive: the workbench project dir (issues, Receipts,
  // memory) and the code repos stay on disk untouched, and the auto-committed
  // rewrite means workbench git history can restore the entries. Refused while
  // any Window has the project open — close or switch away first, so a live
  // Map/watcher set never has its project pulled out from under it.
  ipcMain.handle(
    IpcChannel.ProjectRemove,
    async (_event, req: ProjectRemoveRequest): Promise<ProjectRemoveResult> => {
      const fail = (error: string): ProjectRemoveResult => ({ ok: false, error, warning: null });
      const dirName = (req?.dirName ?? '').trim();
      if (dirName.length === 0) return fail('No project named.');
      // The registry's `project:` field is a plain directory name — refuse
      // anything path-shaped rather than resolve it.
      if (dirName.includes('/') || dirName === '.' || dirName === '..') {
        return fail(`Not a workbench project name: ${dirName}`);
      }
      try {
        // The same alias collapse the open flow uses (issue 71): if THIS
        // project — under any of its handles — is open in a Window, refuse.
        const identity = await resolveProjectIdentity(join(WORKBENCH_ROOT, dirName));
        const live = findProject(registry, identity.key);
        if (live !== undefined && live.ownerWindowId !== null) {
          return fail(
            `${identity.label} is open in a Window — close it (or switch that Window to another project) before removing it.`,
          );
        }

        const registryPath = join(WORKBENCH_ROOT, 'registry.md');
        const content = await readOrNull(registryPath);
        if (content === null) {
          return fail(`No registry at ${registryPath} — nothing to remove.`);
        }
        const removal = removeRegistryProject(content, dirName);
        if (removal.removed === 0) {
          return fail(`No registry entries map to "${dirName}" — nothing to remove.`);
        }
        await writeFile(registryPath, removal.content, 'utf8');

        // ONE boring commit scoped to registry.md — sibling projects' dirt
        // never rides along. A commit failure is surfaced, never undone: the
        // registry on disk is already correct (same posture as onboarding).
        const commit = await commitWorkbenchPaths(
          WORKBENCH_ROOT,
          ['registry.md'],
          `${dirName}: project removed from registry`,
        );
        return {
          ok: true,
          error: null,
          warning:
            commit.error === null
              ? null
              : `Workbench commit failed (${commit.error}) — the registry is updated; commit ~/Workbench manually.`,
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Self-heal confirm (issue 95, ADR-0017): register a repo that appeared under
  // a project's workspace root, acting on its Inbox `new-repo-candidate` item.
  // All validation lives in the pure planner; the edge (main/register-repo.ts)
  // reads CONFIG + registry, writes the repos entry + registry line, and lands
  // ONE boring workbench commit — reusing the ADR-0015 registration path. Like
  // onboarding, NOT ownership-gated: registering claims nothing; the appeared
  // repo just becomes resolvable for the project's future Runs.
  ipcMain.handle(
    IpcChannel.RepoRegister,
    async (_event, req: RepoRegisterRequest): Promise<RepoRegisterResult> => {
      const outcome = await registerAppearedRepo({
        workbenchRoot: WORKBENCH_ROOT,
        homeDir: homedir(),
        project: req?.project ?? '',
        repoPath: req?.repoPath ?? '',
        key: req?.key ?? '',
      });
      // A successful self-heal genuinely changed the registry — broadcast so
      // every Window re-reads (issue 115): the project-first home grid (and the
      // switcher) picks the newly registered repo up with no manual refresh,
      // the same way the open/switch/close flows already notify.
      if (outcome.ok) broadcastRegistryChanged();
      return {
        ok: outcome.ok,
        errors: outcome.errors,
        warning: outcome.warnings[0] ?? null,
        key: outcome.key,
      };
    },
  );

  // The Planning view's live doc watch (issue 83, ADR-0016): keyed per
  // renderer like the Backlog watch; the workbench PRDs + issues and the
  // repo's CONTEXT.md + docs/adr are watched, and the ordered doc list is
  // pushed on real change (and once immediately). An empty workbenchDir stops
  // the calling Window's watch (the Planning view was closed).
  ipcMain.on(IpcChannel.PlanningWatch, (event, req: PlanningWatchRequest) => {
    const sender = event.sender;
    const key = String(sender.id);
    const workbenchDir = req?.workbenchDir?.trim() ?? '';
    if (workbenchDir === '') {
      planningWatcher.unwatch(key);
      return;
    }
    planningWatcher.watch(
      key,
      { workbenchDir, repoPath: req?.repoPath?.trim() ?? '' },
      (docs) => {
        if (!sender.isDestroyed())
          sender.send(IpcChannel.PlanningChanged, { workbenchDir, docs });
      },
    );
    sender.once('destroyed', () => planningWatcher.unwatch(key));
  });

  // Read ONE watched planning doc for the preview (issue 83). Allowlisted
  // against the calling Window's live watch roots via the pure
  // `isAllowedPlanningDoc` — the preview channel is not an arbitrary-file read.
  ipcMain.handle(
    IpcChannel.PlanningDocRead,
    async (event, req: PlanningDocReadRequest): Promise<PlanningDocReadResult> => {
      const path = req?.path ?? '';
      const roots = planningWatcher.rootsFor(String(event.sender.id));
      if (roots === null || !isAllowedPlanningDoc(roots, path)) {
        return { path, content: null, error: 'Not a watched planning document.' };
      }
      try {
        return { path, content: await readFile(path, 'utf8'), error: null };
      } catch (err) {
        return {
          path,
          content: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

app.whenReady().then(async () => {
  runLogStore = new RunLogStore(app.getPath('userData'));
  // The briefing's last-seen stamps load BEFORE the watcher starts, so the
  // first derivation already filters against them (issue 80).
  attentionLastSeen = new AttentionLastSeenStore(app.getPath('userData'));
  await attentionLastSeen.load();
  // Background cross-project attention watch (issue 79): starts with the app,
  // independent of any Window, and stays inert when ~/Workbench doesn't exist.
  attentionWatcher = new AttentionWatcher({
    workbenchRoot: WORKBENCH_ROOT,
    onChange: (snapshot) => broadcast(IpcChannel.AttentionChanged, snapshot),
    lastSeenFor: (project) => attentionLastSeen.get(project),
    // For the self-heal detector's `~/`-path expansion (issue 95, ADR-0017).
    homeDir: homedir(),
  });
  attentionWatcher.start();
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
  planningWatcher.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptyManager.killAll();
  backlogWatcher.closeAll();
  receiptWatcher.closeAll();
  planningWatcher.closeAll();
  // The attention watch closes on QUIT only — it deliberately survives
  // window-all-closed (macOS keeps the app alive; the Inbox keeps watching).
  attentionWatcher?.close();
  attentionWatcher = null;
});
