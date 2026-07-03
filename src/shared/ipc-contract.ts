/**
 * IPC Contract — the typed message set between the Electron main process and
 * the renderer(s). This is the ONLY vocabulary the renderer uses to reach the
 * PTY Session Manager; the renderer never touches node-pty directly.
 *
 * Shared by main, preload, and renderer, so it must stay free of node/electron
 * runtime imports (types only).
 */
import type { Backlog, IssueStatus } from './backlog-model';
import type { IsolationRun } from './isolation-policy';
import type { PipelineStage } from './project-registry';
import type { AfkBranchFacts } from './worktree-scan';

/** Channel names. Grouped by direction for clarity. */
export const IpcChannel = {
  /** renderer → main (invoke): read a Project's backlog off disk. */
  BacklogLoad: 'backlog:load',
  /** renderer → main (send): watch a Project's `issues/` dir for live changes. */
  BacklogWatch: 'backlog:watch',
  /** main → renderer (send): the watched backlog changed on disk (re-read). */
  BacklogChanged: 'backlog:changed',
  /**
   * renderer → main (invoke): observe an isolated Run's issue status from its
   * OWN worktree/branch (issue 13) — where a parallel Run's `done` flip lands,
   * invisible to the main-checkout watcher. Resolves to an
   * IssueStatusObserveResult.
   */
  IssueStatusObserve: 'issue:status-observe',
  /**
   * renderer → main (invoke): scan the Project's on-disk `afk/` branches +
   * worktrees (issue 16) so the Map can show in-flight/finished-unmerged Runs
   * and the Merge affordance can be derived from disk — surviving closing every
   * Pane. Resolves to an AfkScanResult.
   */
  AfkScan: 'afk:scan',
  /**
   * renderer → main (invoke): discard a STRANDED isolated Run (issue 22) —
   * force-remove its worktree and delete its `afk/NN-slug` branch — so a
   * blocked/stopped/commit-failed Run that can never merge stops blocking the
   * batch. Resolves to an AfkDiscardResult.
   */
  AfkDiscard: 'afk:discard',
  /** renderer → main (invoke): spawn a PTY, resolves to a SpawnResult. */
  PtySpawn: 'pty:spawn',
  /** renderer → main (send): write user keystrokes into a PTY. */
  PtyWrite: 'pty:write',
  /** renderer → main (send): the terminal was resized. */
  PtyResize: 'pty:resize',
  /** renderer → main (send): kill a PTY. */
  PtyKill: 'pty:kill',
  /** main → renderer (send): bytes produced by a PTY. */
  PtyData: 'pty:data',
  /** main → renderer (send): a PTY exited. */
  PtyExit: 'pty:exit',
  /**
   * renderer → main (invoke): reconcile isolation for the current active Run
   * set — create/remove worktrees, toggle parallel mode — and resolve each
   * Run's cwd. Resolves to an IsolationApplyResult.
   */
  IsolationApply: 'isolation:apply',
  /**
   * renderer → main (invoke): human-triggered Merge of finished parallel Runs
   * (issue 08). Runs `afk-merge.sh` to integrate the given `afk/NN-slug`
   * branches into `main`, then cleans up their worktrees. Resolves to a
   * MergeRunsResult. Never runs automatically (ADR-0002).
   */
  MergeRuns: 'merge:runs',
  /**
   * renderer → main (invoke): open (register-if-needed + claim) a Project repo
   * in the CALLING Window. Rejected — with a clear message — if another Window
   * already manages that repo (ADR-0004's "no double-managing a repo"). Also
   * used on Window bootstrap to pick up a repo the opener queued. Resolves to a
   * ProjectActionResult.
   */
  ProjectOpen: 'project:open',
  /**
   * renderer → main (invoke): switch the calling Window's active Project to a
   * different registered repo (releases the old, claims the new — atomically).
   * Rejected if the target is owned by another Window. Resolves to a
   * ProjectActionResult.
   */
  ProjectSwitch: 'project:switch',
  /**
   * renderer → main (invoke): move a Project along the pipeline (planning →
   * backlog → executing → merge-qa, or one step back). Rejected on an illegal
   * (non-adjacent) transition. Resolves to a ProjectActionResult.
   */
  ProjectTransition: 'project:transition',
  /**
   * renderer → main (invoke): the calling Window's current registry view — the
   * registered Projects (with ownership from this Window's perspective), the
   * repo this Window actively manages, and any repo the opener queued for a
   * freshly-created Window to auto-open. Resolves to a ProjectListResult.
   */
  ProjectList: 'project:list',
  /**
   * renderer → main (invoke): open the native OS directory chooser (Electron
   * `dialog.showOpenDialog({ properties: ['openDirectory'] })`, issue 19) so the
   * user can Browse… for a Project folder instead of pasting a path. Resolves to
   * a ProjectPickFolderResult whose `path` is the chosen directory, or null when
   * the dialog was cancelled (a clean no-op).
   */
  ProjectPickFolder: 'project:pick-folder',
  /**
   * renderer → main (invoke): open a NEW Project Window onto the same single
   * backend (ADR-0004 — no second process/port). The new Window auto-opens the
   * given repo (if any) on bootstrap. Resolves to a WindowOpenResult.
   */
  WindowOpen: 'window:open',
  /**
   * main → renderer (broadcast to every Window): the Project registry changed
   * (a Window opened/closed/switched a repo, or a stage moved) — re-fetch via
   * ProjectList so each Window's switcher reflects live ownership.
   */
  ProjectRegistryChanged: 'project:registry-changed',
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

/** Opaque identifier for one live PTY session. */
export type SessionId = string;

/**
 * A Run target: the one issue a Pane should spawn a fresh `claude`
 * afk-issue-runner session against, in the Project's repo (cwd). Absent for a
 * plain walking-skeleton shell Pane (issue 01).
 */
export interface RunTarget {
  /** Numeric issue id (for status tracking against the backlog). */
  issueId: number;
  /** Issue file name, e.g. `03-run-issue-in-pane.md` (scopes the prompt). */
  issueFileName: string;
  /** Issue title, for the Pane banner. */
  issueTitle: string;
  /** The Project repo path the session runs in (its cwd). Solo mode: `main`. */
  projectPath: string;
}

export interface PtySpawnRequest {
  cols: number;
  rows: number;
  /**
   * When present, spawn a fresh interactive `claude` session scoped to this
   * issue (in `projectPath`) instead of a plain shell. This is a Run (issue 03).
   */
  run?: RunTarget;
}

export interface PtySpawnResult {
  sessionId: SessionId;
  /** The executable that was actually spawned (useful for the UI banner). */
  file: string;
}

export interface PtyWriteMessage {
  sessionId: SessionId;
  data: string;
}

export interface PtyResizeMessage {
  sessionId: SessionId;
  cols: number;
  rows: number;
}

export interface PtyKillMessage {
  sessionId: SessionId;
}

export interface PtyDataMessage {
  sessionId: SessionId;
  data: string;
}

export interface PtyExitMessage {
  sessionId: SessionId;
  exitCode: number;
  signal?: number;
}

export interface BacklogLoadRequest {
  /** Repo path to read. Omit/empty to use the backend's own cwd (dev default). */
  projectPath?: string;
}

export interface BacklogLoadResult {
  /** The path that was actually read (resolved from the request). */
  projectPath: string;
  /** The structured backlog, or null when reading failed. */
  backlog: Backlog | null;
  /** A human-readable error (e.g. no `issues/` dir), or null on success. */
  error: string | null;
}

export interface BacklogWatchRequest {
  /** The resolved repo path to watch for live `issues/` changes. */
  projectPath: string;
}

/**
 * Pushed to the renderer whenever the watched Project's `issues/` files change
 * on disk (a Run flipping a status, a hand-edit, an added/removed issue). Same
 * shape as a load result so the renderer applies it identically.
 */
export type BacklogChangedMessage = BacklogLoadResult;

export interface IssueStatusObserveRequest {
  /** The Project repo path (`main` checkout — the worktree base derives from it). */
  projectPath: string;
  /** The `NN-slug` of the isolated Run whose `afk/NN-slug` branch to observe. */
  slug: string;
}

export interface IssueStatusObserveResult {
  /** The issue's status as observed in the Run's worktree/branch, or null. */
  status: IssueStatus | null;
  /**
   * The auto-commit failure message when a finished Run's commit could not be
   * made (issue 22, corr-5), else null. Surfaced so the UI can show a distinct
   * "commit failed" state instead of the Run reading "running" forever.
   */
  commitError: string | null;
}

export interface AfkScanRequest {
  /** The Project repo path (`main` checkout); the scan reads its `afk/` branches. */
  projectPath: string;
}

export interface AfkScanResult {
  /** On-disk facts per `afk/NN-slug` branch, ascending by issue id (issue 16). */
  branches: AfkBranchFacts[];
}

export interface AfkDiscardRequest {
  /** The Project repo path (`main` checkout); the worktree base derives from it. */
  projectPath: string;
  /** The `NN-slug` of the stranded Run whose worktree + `afk/` branch to discard. */
  slug: string;
}

export interface AfkDiscardResult {
  /** True when the worktree + branch were discarded (or were already gone). */
  ok: boolean;
  /** A human-readable error when the discard failed, else null. */
  error: string | null;
}

export interface IsolationApplyRequest {
  /** The Project repo path (`main` checkout). */
  projectPath: string;
  /** The Runs that currently need isolation (running / not-yet-merged). */
  runs: IsolationRun[];
}

/** One Run's resolved placement after reconciling isolation on disk. */
export interface ResolvedPlacement {
  issueId: number;
  slug: string;
  /** Absolute cwd the Run's Pane should spawn in: a worktree, or `main`. */
  cwd: string;
  /** The `afk/NN-slug` branch when isolated, or null when working on `main`. */
  branch: string | null;
}

export interface IsolationApplyResult {
  /** True when parallel mode is (now) enabled. */
  parallel: boolean;
  /** Placement per Run, ascending by issueId. */
  placements: ResolvedPlacement[];
}

export interface MergeRunsRequest {
  /** The Project repo path (`main` checkout). */
  projectPath: string;
  /** The `NN-slug`s whose `afk/NN-slug` branches to merge into `main`. */
  slugs: string[];
}

/** The outcome of a human-triggered Merge (issue 08). */
export interface MergeRunsResult {
  /** True when every branch merged cleanly and worktrees were cleaned up. */
  ok: boolean;
  /** True when the merge stopped on a conflict a human must resolve. */
  conflicted: boolean;
  /** The slugs that were merged into `main` (empty on failure/conflict). */
  merged: string[];
  /** A short human-readable summary for the Map. */
  message: string;
  /** The full `afk-merge.sh` output (stdout+stderr) for the UI to show. */
  output: string;
}

/**
 * One Project as seen from a particular Window: its repo path and pipeline
 * stage, plus who owns it *relative to the asking Window* — `you` (this
 * Window), `other` (a different Window; not switchable-to), or `free`.
 */
export interface ProjectView {
  repoPath: string;
  stage: PipelineStage;
  ownership: 'you' | 'other' | 'free';
}

/** The calling Window's view of the Project registry. */
export interface ProjectListResult {
  /** Every registered Project, ascending by path, tagged with ownership. */
  projects: ProjectView[];
  /** The repo this Window actively manages, or null if none yet. */
  activeRepoPath: string | null;
  /**
   * A repo the opener queued for this (freshly-created) Window to auto-open on
   * bootstrap, consumed on read; null once consumed or for a normal Window.
   */
  pendingOpen: string | null;
}

/** The outcome of a Project op (open/switch/transition) for the calling Window. */
export interface ProjectActionResult {
  /** True when the op succeeded. */
  ok: boolean;
  /** A clear, user-facing message when `ok` is false; null on success. */
  error: string | null;
  /** The Window's active repo after the op (unchanged on failure), or null. */
  activeRepoPath: string | null;
  /** The refreshed Project list from this Window's perspective. */
  projects: ProjectView[];
}

export interface ProjectOpenRequest {
  /** The repo path to open in the calling Window. */
  repoPath: string;
  /** Initial pipeline stage when the Project is registered for the first time. */
  initialStage?: PipelineStage;
}

export interface ProjectSwitchRequest {
  /** The already-registered repo to switch the calling Window to. */
  repoPath: string;
}

export interface ProjectTransitionRequest {
  /** The Project to move. */
  repoPath: string;
  /** The stage to move it to (must be adjacent to its current stage). */
  toStage: PipelineStage;
}

/** The outcome of the native folder chooser (issue 19). */
export interface ProjectPickFolderResult {
  /**
   * The directory the user chose, or null when the dialog was cancelled (no
   * folder picked). The renderer treats null as a no-op — no empty-path open.
   */
  path: string | null;
}

export interface WindowOpenRequest {
  /** A repo the new Window should auto-open on bootstrap, if any. */
  repoPath?: string;
}

export interface WindowOpenResult {
  /** True once the new Window was created. */
  ok: boolean;
}

/**
 * The surface preload exposes on `window.mc`. Declared here so main, preload,
 * and renderer all agree on one shape.
 */
export interface MissionControlApi {
  loadBacklog(req: BacklogLoadRequest): Promise<BacklogLoadResult>;
  /** Start (or re-point) the live file-watch for the given Project path. */
  watchBacklog(req: BacklogWatchRequest): void;
  /** Subscribe to live backlog changes; returns an unsubscribe function. */
  onBacklogChanged(listener: (msg: BacklogChangedMessage) => void): () => void;
  /**
   * Observe an isolated Run's issue status from its own worktree/branch (issue
   * 13), so a `done` flip that landed off the main checkout is still detected.
   */
  observeIssueStatus(
    req: IssueStatusObserveRequest,
  ): Promise<IssueStatusObserveResult>;
  /**
   * Scan the Project's on-disk `afk/` branches/worktrees (issue 16) so the Map
   * reflects in-flight/finished-unmerged Runs and the Merge affordance survives
   * closing every Pane.
   */
  scanAfkRuns(req: AfkScanRequest): Promise<AfkScanResult>;
  /**
   * Discard a stranded isolated Run (issue 22): force-remove its worktree and
   * delete its `afk/NN-slug` branch so it stops blocking the batch.
   */
  discardAfkRun(req: AfkDiscardRequest): Promise<AfkDiscardResult>;
  /**
   * Reconcile isolation for the current active Run set and get each Run's
   * resolved cwd (worktree in parallel mode, `main` when solo).
   */
  applyIsolation(req: IsolationApplyRequest): Promise<IsolationApplyResult>;
  /**
   * Human-triggered Merge of finished parallel Runs: integrate their
   * `afk/NN-slug` branches into `main` and clean up the worktrees (issue 08).
   */
  mergeRuns(req: MergeRunsRequest): Promise<MergeRunsResult>;
  /** Open (register-if-needed + claim) a Project repo in this Window. */
  openProject(req: ProjectOpenRequest): Promise<ProjectActionResult>;
  /** Switch this Window's active Project to another registered repo. */
  switchProject(req: ProjectSwitchRequest): Promise<ProjectActionResult>;
  /** Move a Project along the pipeline (one adjacent stage). */
  transitionProject(req: ProjectTransitionRequest): Promise<ProjectActionResult>;
  /** This Window's view of the Project registry (+ any queued auto-open). */
  listProjects(): Promise<ProjectListResult>;
  /**
   * Open the native OS folder chooser to Browse… for a Project repo (issue 19).
   * Resolves with the chosen path, or null when the dialog was cancelled.
   */
  pickProjectFolder(): Promise<ProjectPickFolderResult>;
  /** Open a new Project Window onto the same backend (optionally on a repo). */
  openWindow(req: WindowOpenRequest): Promise<WindowOpenResult>;
  /** Subscribe to registry changes across Windows; returns an unsubscribe fn. */
  onProjectRegistryChanged(listener: () => void): () => void;
  spawnPty(req: PtySpawnRequest): Promise<PtySpawnResult>;
  writePty(msg: PtyWriteMessage): void;
  resizePty(msg: PtyResizeMessage): void;
  killPty(msg: PtyKillMessage): void;
  onPtyData(listener: (msg: PtyDataMessage) => void): () => void;
  onPtyExit(listener: (msg: PtyExitMessage) => void): () => void;
}

declare global {
  interface Window {
    mc: MissionControlApi;
  }
}
