/**
 * IPC Contract — the typed message set between the Electron main process and
 * the renderer(s). This is the ONLY vocabulary the renderer uses to reach the
 * PTY Session Manager; the renderer never touches node-pty directly.
 *
 * Shared by main, preload, and renderer, so it must stay free of node/electron
 * runtime imports (types only).
 */
import type { Backlog, IssueStatus } from './backlog-model';
import type { CompletionRecord, RunOutcome } from './completion-parser';
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
   * renderer → main (invoke): auto-commit a finished SOLO Run's work on `main`
   * (issue 25) so "finished" uniformly means "committed" and a solo Run never
   * leaves `main` dirty to block the next parallel Merge preflight. Only commits
   * on the done transition; idempotent. Resolves to a MainCommitResult.
   */
  MainCommit: 'main:commit',
  /**
   * renderer → main (invoke): auto-commit a finished ISOLATED Run's worktree onto
   * its `afk/NN-slug` branch (issue 15/30). Driven EVENT-driven off the on-disk
   * scan — once, on the finished transition (worktree `done`, branch tip not) —
   * NOT on every status-read tick, so the status read stays a pure read and a
   * drain isn't spawning a commit per tick. Idempotent. Resolves to a
   * WorktreeCommitResult.
   */
  WorktreeCommit: 'worktree:commit',
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
   * renderer → main (invoke): abort an in-progress (conflicted) merge on `main`
   * left behind by a partial `afk-merge.sh` run (issue 24) — runs `git merge
   * --abort` to return `main` to a clean, non-mid-merge state (slugs that merged
   * cleanly before the conflict stay merged). Human-triggered. Resolves to a
   * MergeAbortResult.
   */
  MergeAbort: 'merge:abort',
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
  /**
   * renderer → main (invoke): load a Project's persisted Run log (issue 34) so
   * the Execution view's Run-log feed survives closing Panes and app restarts.
   * Resolves to a RunLogLoadResult.
   */
  RunLogLoad: 'runlog:load',
  /**
   * renderer → main (send): watch a Project's `issues/completions/` for Receipt
   * files (issue 56, ADR-0013) — the checkout's for solo Runs plus each live
   * parallel Run's worktree copy (named by `worktreeSlugs`; main derives the
   * worktree paths it owns). Re-sent whenever the worktree set changes; main
   * reconciles the watched roots.
   */
  ReceiptWatch: 'receipt:watch',
  /**
   * main → renderer (send): a genuinely-new Receipt was ingested at the capture
   * edge (parsed, debounced, deduped by issue + `finished`) and persisted to
   * the Run log. The renderer upserts it into the SAME feed pipeline
   * scroll-captured records enter (noise floor, lifecycle derivation, Run-log
   * card) — no bespoke path.
   */
  ReceiptCaptured: 'receipt:captured',
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
  /**
   * The resolved cwd the session runs in. Legacy: the Project repo (solo) or
   * the Run's worktree (parallel). Workbench (issue 72): the issue's TARGET
   * repo — its `repo:` key resolved through the project CONFIG, else the
   * default repo — or a worktree of it under same-repo concurrency.
   */
  projectPath: string;
  /**
   * Present exactly for a workbench Project's Run (issue 72, ADR-0015): the
   * explicit workbench paths the spawn prompt must carry — the issues root
   * (where the Worker finds/flips its issue and reads CONFIG.md beside it)
   * and the completions root its absolute Receipt path lives under. Absent
   * for a legacy Project: the prompt stays byte-identical to today's.
   */
  workbench?: {
    issuesRoot: string;
    completionsRoot: string;
  } | null;
}

/**
 * A Dispatcher target: the one Project a conversational orchestrator `claude`
 * session drives a drain for (issue 35, ADR-0010). Spawned WHEN A DRAIN STARTS
 * (a single manual Run stays a bare Pane), one per Project, in the Project repo
 * (cwd). Absent for a Run or a plain shell Pane.
 */
export interface DispatcherTarget {
  /** The Project repo path the orchestrator session runs in (its cwd). */
  projectPath: string;
  /** The active PRD path (seed context), or null when none is set. */
  activePrd: string | null;
}

export interface PtySpawnRequest {
  cols: number;
  rows: number;
  /**
   * When present, spawn a fresh interactive `claude` session scoped to this
   * issue (in `projectPath`) instead of a plain shell. This is a Run (issue 03).
   */
  run?: RunTarget;
  /**
   * When present, spawn the Dispatcher orchestrator `claude` session for this
   * Project (issue 35) instead of a Run or a plain shell. Mutually exclusive
   * with `run`.
   */
  dispatcher?: DispatcherTarget;
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
  /**
   * The Project key (workbench project dir or legacy repo path) whose resolved
   * issues root to read. Omit/empty to use the backend's own cwd (dev default).
   */
  projectPath?: string;
}

export interface BacklogLoadResult {
  /** The Project key the read was for (echoed so pushes can be matched). */
  projectPath: string;
  /** The structured backlog, or null when reading failed. */
  backlog: Backlog | null;
  /** A human-readable error (e.g. no `issues/` dir), or null on success. */
  error: string | null;
}

export interface BacklogWatchRequest {
  /**
   * The Project key whose resolved issues root to watch for live changes —
   * in-workbench or in-repo, the watcher follows the identity (issue 71).
   */
  projectPath: string;
}

/**
 * Pushed to the renderer whenever the watched Project's `issues/` files change
 * on disk (a Run flipping a status, a hand-edit, an added/removed issue). Same
 * shape as a load result so the renderer applies it identically.
 */
export type BacklogChangedMessage = BacklogLoadResult;

export interface IssueStatusObserveRequest {
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
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

export interface MainCommitRequest {
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
  /** The Project repo path (`main` checkout) where the solo Run did its work. */
  projectPath: string;
  /** The `NN-slug` of the finished solo Run, used for the commit message. */
  slug: string;
}

export interface MainCommitResult {
  /** True when a new commit landed on `main` this call (false ⇒ nothing to do). */
  committed: boolean;
  /**
   * The git error message when the commit was ATTEMPTED and failed, else null —
   * so a failed auto-commit is surfaced rather than silently leaving `main` dirty.
   */
  error: string | null;
  /**
   * Stray Receipts (dirty files under `issues/completions/` that are NOT this
   * Run's own) adopted — auto-committed under a dedicated `chore: adopt stray
   * Receipt(s)` message — before the run commit (issue 62, ADR-0013). The Run's
   * own Receipt stays in the run commit (issue 59). Empty/absent when none.
   */
  adopted?: string[];
}

export interface WorktreeCommitRequest {
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
  /** The Project repo path (`main` checkout); the worktree base derives from it. */
  projectPath: string;
  /** The `NN-slug` of the finished isolated Run whose worktree to commit. */
  slug: string;
}

export interface WorktreeCommitResult {
  /** True when a new commit landed on the `afk/NN-slug` branch this call. */
  committed: boolean;
  /**
   * The git error message when the commit was ATTEMPTED and failed, else null —
   * so a failed auto-commit is surfaced (a "commit failed" state) rather than
   * swallowed, exactly as the old status-read path reported it.
   */
  error: string | null;
}

export interface AfkScanRequest {
  /** The Project repo path (`main` checkout); the scan reads its `afk/` branches. */
  projectPath: string;
}

export interface AfkScanResult {
  /** On-disk facts per `afk/NN-slug` branch, ascending by issue id (issue 16). */
  branches: AfkBranchFacts[];
  /**
   * True when `main` is left mid-merge — a partial `afk-merge.sh` run committed
   * some slugs then hit a conflict, so `main` has a conflicted index / MERGE_HEAD
   * (issue 24). Polled alongside the branch scan so the UI can block a new
   * drain/Run and offer an Abort until it is resolved.
   */
  midMerge: boolean;
}

export interface AfkDiscardRequest {
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
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
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
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
  /**
   * The slugs that were merged into `main`. On a clean run, all of them; on a
   * PARTIAL conflict (issue 24) the slugs that merged cleanly BEFORE the conflict
   * — these are genuinely on `main` even though the overall run failed, so the
   * report can say "A merged, B conflicted" instead of the wrong "nothing merged".
   */
  merged: string[];
  /**
   * True when the run left `main` mid-merge — a conflict stopped it with a
   * conflicted index / MERGE_HEAD in place (issue 24). Distinguishes a partial
   * conflict (main dirty, needs resolve/abort) from a preflight refusal (main
   * untouched). Only meaningful when `conflicted` is true.
   */
  midMerge?: boolean;
  /** On a conflict, the files git reported conflicting (issue 24). */
  conflictingFiles?: string[];
  /**
   * Stray Receipts (dirty files under `issues/completions/` on `main`) that were
   * ADOPTED — auto-committed under a dedicated `chore: adopt stray Receipt(s)`
   * message — before the merge preflight ran (issue 62, ADR-0013). A misplaced
   * Worker Receipt is a known, repairable artifact; only unknown dirt outside
   * that set still halts the preflight. Empty/absent when nothing was adopted.
   */
  adopted?: string[];
  /** A short human-readable summary for the Map. */
  message: string;
  /** The full `afk-merge.sh` output (stdout+stderr) for the UI to show. */
  output: string;
}

export interface MergeAbortRequest {
  /**
   * The CODE REPO this operation targets (issue 72): a workbench Project's
   * Runs may live in different member repos, so the git-flavored handlers
   * can no longer assume the project default. Absent (legacy callers, or a
   * workbench Run in the default repo when unspecified) ⇒ main falls back to
   * the identity's default repo — byte-identical to today.
   */
  repoPath?: string;
  /** The Project repo path (`main` checkout) to run `git merge --abort` in. */
  projectPath: string;
}

/** The outcome of aborting an in-progress merge on `main` (issue 24). */
export interface MergeAbortResult {
  /** True when `main` is now clean (aborted, or there was nothing to abort). */
  ok: boolean;
  /** A human-readable error when the abort failed, else null. */
  error: string | null;
}

/**
 * One Project as seen from a particular Window (issue 71, ADR-0015): its
 * resolved identity — a workbench entry referencing one or more repos, or a
 * legacy repo — its pipeline stage, plus who owns it *relative to the asking
 * Window* — `you` (this Window), `other` (a different Window; not
 * switchable-to), or `free`.
 */
export interface ProjectView {
  /**
   * The Project's identity and ownership key: the workbench project directory
   * for a workbench Project, the repo path for a legacy one. This — never a
   * raw repo path — is what every per-Project IPC request names.
   */
  key: string;
  /** Which layout the identity resolved through. */
  kind: 'workbench' | 'legacy';
  /** Compact display name (workbench project name / repo basename). */
  label: string;
  /** Where this Project's issue files live (in-workbench or in-repo). */
  issuesRoot: string;
  /**
   * Where this Project's Receipts land (issue 72): the workbench completions
   * root, or — legacy — `<repo>/issues/completions`.
   */
  completionsRoot: string;
  /**
   * The repo a Run without a `repo:` key targets: the workbench CONFIG's
   * default repo, or — legacy — the repo itself.
   */
  defaultRepoPath: string;
  /**
   * The CONFIG's `repos:` map, tilde-expanded (issue 72) — what an issue's
   * `repo:` key resolves through. Empty for a legacy Project.
   */
  repos: Record<string, string>;
  stage: PipelineStage;
  ownership: 'you' | 'other' | 'free';
}

/** The calling Window's view of the Project registry. */
export interface ProjectListResult {
  /** Every registered Project, ascending by key, tagged with ownership. */
  projects: ProjectView[];
  /** The key of the Project this Window actively manages, or null if none yet. */
  activeProjectKey: string | null;
  /**
   * A path the opener queued for this (freshly-created) Window to auto-open on
   * bootstrap (resolved to an identity when opened), consumed once acted on;
   * null once consumed or for a normal Window.
   */
  pendingOpen: string | null;
}

/** The outcome of a Project op (open/switch/transition) for the calling Window. */
export interface ProjectActionResult {
  /** True when the op succeeded. */
  ok: boolean;
  /** A clear, user-facing message when `ok` is false; null on success. */
  error: string | null;
  /** The Window's active Project key after the op (unchanged on failure), or null. */
  activeProjectKey: string | null;
  /** The refreshed Project list from this Window's perspective. */
  projects: ProjectView[];
}

export interface ProjectOpenRequest {
  /**
   * The handle to open in the calling Window: a repo path OR a workbench
   * project directory. Main resolves it (explicit dir → registry lookup →
   * legacy, ADR-0015) to one canonical Project identity, so either alias of
   * the same Project lands on the same ownership key.
   */
  path: string;
  /** Initial pipeline stage when the Project is registered for the first time. */
  initialStage?: PipelineStage;
}

export interface ProjectSwitchRequest {
  /** The already-registered Project (by key) to switch the calling Window to. */
  key: string;
}

export interface ProjectTransitionRequest {
  /** The Project (by key) to move. */
  key: string;
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
  /**
   * A path (repo or workbench dir) the new Window should auto-open on
   * bootstrap, if any. Resolved to a Project identity when the Window opens it.
   */
  path?: string;
}

export interface WindowOpenResult {
  /** True once the new Window was created. */
  ok: boolean;
}

/**
 * One persisted Run-log entry (issue 34; ADR-0013): the parsed Completion-block
 * fields plus the capture metadata the feed/store need. Records enter ONLY via
 * the Receipt capture edge (issue 56/57), so `id` is the edge's stable
 * `receipt:<NN-slug>:<finished>` identity — a superseding ingest replaces its
 * earlier version and each Run gets exactly one card. (Logs persisted before
 * ADR-0013 may still hold legacy scroll-captured records whose id was the PTY
 * session id; they load fine but are not Receipts.) Shared here so main
 * (persist), preload, and renderer (feed) agree on one shape.
 */
export interface RunLogRecord extends CompletionRecord {
  /** Stable per-Run id (the PTY session id). */
  id: string;
  /** ISO-8601 timestamp of when the block was captured. */
  capturedAt: string;
  /** The `NN-slug` of the Run's issue, when known. */
  slug: string | null;
  /** The issue title, for the card header. */
  title: string | null;
}

/** Re-export the parser's outcome enum so consumers need one import. */
export type { RunOutcome };

export interface RunLogLoadRequest {
  /** The Project repo path whose persisted Run log to read. */
  projectPath: string;
}

export interface RunLogLoadResult {
  /** The Project's Run-log records, newest first. */
  records: RunLogRecord[];
}

export interface ReceiptWatchRequest {
  /** The Project repo path whose `issues/completions/` to watch. */
  projectPath: string;
  /**
   * The `NN-slug`s of Runs currently living in worktrees, so main also watches
   * each worktree's own `issues/completions/` copy (a parallel Run's Receipt
   * lands there, invisible to the checkout watch, and must surface live —
   * before any Merge). Main derives the worktree paths; it owns them.
   */
  worktreeSlugs: string[];
}

/**
 * Pushed to the renderer when the Receipt capture edge ingests a genuinely-new
 * Receipt (issue 56): already parsed, debounced (no truncated half-writes) and
 * deduped (issue + `finished`), and already persisted to the Run log on disk.
 */
export interface ReceiptCapturedMessage {
  /** The Project the Receipt belongs to (the watch request's path). */
  projectPath: string;
  /** The parsed record, in the exact shape the Run-log feed consumes. */
  record: RunLogRecord;
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
   * Auto-commit a finished solo Run's work on `main` (issue 25) so `main` stays
   * clean and mergeable. Only commits on the done transition; idempotent.
   */
  commitFinishedMain(req: MainCommitRequest): Promise<MainCommitResult>;
  /**
   * Auto-commit a finished isolated Run's worktree onto its `afk/` branch (issue
   * 15/30), event-driven off the scan on the finished transition — once, not per
   * status tick. Idempotent.
   */
  commitFinishedWorktree(
    req: WorktreeCommitRequest,
  ): Promise<WorktreeCommitResult>;
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
  /**
   * Abort an in-progress (conflicted) merge left on `main` by a partial merge
   * (issue 24): `git merge --abort` back to a clean, non-mid-merge `main`.
   */
  abortMerge(req: MergeAbortRequest): Promise<MergeAbortResult>;
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
  /** Load a Project's persisted Run log for the Execution view feed (issue 34). */
  loadRunLog(req: RunLogLoadRequest): Promise<RunLogLoadResult>;
  /**
   * Start (or re-point) the Receipt watch for a Project (issue 56): the
   * checkout's `issues/completions/` plus each named worktree's copy.
   */
  watchReceipts(req: ReceiptWatchRequest): void;
  /** Subscribe to ingested Receipts; returns an unsubscribe function. */
  onReceiptCaptured(listener: (msg: ReceiptCapturedMessage) => void): () => void;
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
