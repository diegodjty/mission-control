/**
 * IPC Contract — the typed message set between the Electron main process and
 * the renderer(s). This is the ONLY vocabulary the renderer uses to reach the
 * PTY Session Manager; the renderer never touches node-pty directly.
 *
 * Shared by main, preload, and renderer, so it must stay free of node/electron
 * runtime imports (types only).
 */
import type { AttentionItem } from './attention-hub-model';
import type { Backlog, IssueStatus } from './backlog-model';
import type { PlanningDoc } from './planning-model';
import type { CompletionRecord, RunOutcome } from './completion-parser';
import type { IsolationRun } from './isolation-policy';
import type { PipelineStage } from './project-registry';
import type { AfkBranchFacts } from './worktree-scan';
import type { BranchPreview } from './merge-preview';

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
   * main → renderer (broadcast): a headless Run's claude **session id** was
   * captured from its stream-json output (issue 139, ADR-0001 amendment) — the
   * `system`/`init` event's `session_id`. Carries the MC-internal spawn
   * `sessionId` (for the Feed to self-filter) and the parsed `claudeSessionId`,
   * which the renderer persists on the Run for resume/take-over. A headless Run's
   * exit still arrives on `PtyExit`; its raw stream is buffered in main for
   * peek/debug only and is NEVER a capture input (ADR-0013 untouched).
   */
  RunSessionCaptured: 'run:session-captured',
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
  /**
   * renderer → main (invoke): write ONE dated drain-journal entry into the
   * workbench project's `memory/journal/` (issue 73, ADR-0015) when a drain
   * ends (any stop reason), assembled from THIS drain's Run-log records by the
   * pure builder and auto-committed via the issue-72 workbench commit path.
   * Inert (a quiet no-op) for a legacy Project — no memory dir exists there.
   * Resolves to a DrainJournalResult.
   */
  DrainJournal: 'drain:journal',
  /**
   * renderer → main (invoke): the current aggregated cross-project attention
   * snapshot (issue 79, ADR-0016) — what the background workbench watch has
   * derived so far — so a freshly opened Window doesn't wait for the next
   * change. Resolves to an AttentionSnapshot.
   */
  AttentionList: 'attention:list',
  /**
   * main → renderer (broadcast to every Window): the aggregated cross-project
   * attention list changed (issue 79). The background service watches EVERY
   * `status: active` registry project's workbench dirs — open in a Window or
   * not — re-derives on change (debounced, ADR-0006), and pushes only when
   * the result actually differs. Informational only: items never claim or
   * write anything; acting on one goes through the normal open flows.
   */
  AttentionChanged: 'attention:changed',
  /**
   * renderer → main (invoke): the Inbox was viewed (issue 80, ADR-0016) —
   * advance every watched project's briefing last-seen stamp to now, persist
   * it in app userData (never workbench data — viewing the Inbox must not
   * create commits), and re-derive so already-seen journal entries drop out
   * of the next snapshot. Resolves to an AttentionMarkSeenResult.
   */
  AttentionMarkSeen: 'attention:mark-seen',
  /**
   * main → renderer (send, to ONE Window): a native OS notification was
   * clicked (issue 138) — focus this Window and land on the named Project's
   * attention surface (the same click-through the Inbox performs, issue 80).
   * Sent only to the Window the notification adapter focused, so exactly one
   * Window navigates. Carries the workbench root + project dir name + optional
   * issue to select.
   */
  NavigateAttention: 'attention:navigate',
  /**
   * renderer → main (invoke): the Launcher's project list (issue 81,
   * ADR-0016) — every `status: active` workbench-registry project with its
   * truthful backlog counts and last-activity stamp, most recent first, for
   * the Continue / Quick fix / Just talk actions. A read-only aggregation
   * (like the attention watch): listing never claims or writes anything.
   * Resolves to a LauncherListResult.
   */
  LauncherList: 'launcher:list',
  /**
   * renderer → main (invoke): the project-first home grid (issue 115,
   * ADR-0019) — every workbench project shaped into a `ProjectCardView` (its
   * `LauncherProject` signals + the card model's display labels), in grid
   * order. A read-only aggregation PARALLEL to `LauncherList`; listing never
   * claims or writes. Pushed live off the existing registry + backlog
   * subscriptions (no new watcher). Resolves to a ProjectGridResult.
   */
  ProjectGrid: 'project:grid',
  /**
   * renderer → main (invoke): the Launcher's Quick fix (issue 81, ADR-0016)
   * — turn one sentence into a well-formed STANDALONE issue (`## Source`, no
   * Parent, next free number) in the chosen project's workbench backlog, and
   * auto-commit the workbench via the existing issue-72 commit path. Resolves
   * to a QuickFixCreateResult.
   */
  QuickFixCreate: 'quickfix:create',
  /**
   * renderer → main (invoke): read ONE issue file's raw text (frontmatter +
   * body) for the Map's Edit affordance (issue 89, ADR-0016 finding). Reads
   * fresh off disk at edit-open so the editor never seeds from a stale push.
   * Restricted to plain `NN-slug.md` names inside the Project's resolved
   * issues root — never an arbitrary-file read. Resolves to an
   * IssueFileReadResult.
   */
  IssueFileRead: 'issue:read-file',
  /**
   * renderer → main (invoke): save one issue file's full replacement text
   * (issue 89). Validated through the real backlog parser's rules BEFORE the
   * write — a parse-breaking save is refused with the reason; a valid one is
   * written verbatim (byte-what-was-typed) and, for a workbench Project,
   * auto-committed (`<project>: issue NN edited`). Resolves to an
   * IssueFileWriteResult.
   */
  IssueFileEdit: 'issue:edit-file',
  /**
   * renderer → main (invoke): delete one issue file after the UI's confirm
   * (issue 89). Refused for `wip` issues — the flip is a claim; someone owns
   * it — based on the CURRENT on-disk status, not the renderer's view. For a
   * workbench Project the delete is auto-committed (`<project>: issue NN
   * deleted`). Resolves to an IssueFileWriteResult.
   */
  IssueFileDelete: 'issue:delete-file',
  /**
   * renderer → main (send): watch a project's planning roots (issue 83,
   * ADR-0016) — the workbench project dir (top-level PRDs + `issues/`) and
   * the repo's `CONTEXT.md` + `docs/adr/` — for the Planning view's live
   * preview. An empty `workbenchDir` stops the calling Window's watch.
   */
  PlanningWatch: 'planning:watch',
  /**
   * main → renderer (send): the watched planning doc set changed (a doc was
   * written/added/removed) — the ordered list, most-recently-changed first.
   * Also pushed once, immediately, when the watch starts.
   */
  PlanningChanged: 'planning:changed',
  /**
   * renderer → main (invoke): read ONE watched planning document for the
   * preview (issue 83). Restricted to the calling Window's watched planning
   * roots — never an arbitrary-file read. Resolves to a PlanningDocReadResult.
   */
  PlanningDocRead: 'planning:read-doc',
  /**
   * renderer → main (invoke): the Launcher's New project flow (issue 82,
   * ADR-0016; repo-less projects, issue 93 / ADR-0017) — validate a project
   * name + workspace root + ZERO or more repo drafts against the workbench and,
   * unless `dryRun`, perform the ADR-0015 setup: project dir (CONFIG with
   * workspace_root, empty issues/+completions/, memory skeleton with empty
   * CORE.md), active registry entries (one per repo — none for a repo-less
   * project), ONE boring workbench commit. Refusals (collisions,
   * already-registered repos) name every problem; non-git paths and an
   * existing non-empty workspace root warn but are allowed. Resolves to an
   * OnboardingCreateResult.
   */
  OnboardingCreate: 'onboarding:create',
  /**
   * renderer → main (invoke): the Launcher's Remove project (issue 92) — drop
   * every `registry.md` entry mapping to the chosen workbench project, so the
   * Launcher, the attention watch, and session resolution stop seeing it. The
   * inverse of onboarding's registry append, and deliberately NON-destructive:
   * the workbench project directory (issues, Receipts, memory) and the code
   * repos stay on disk untouched; the registry rewrite is auto-committed, so
   * workbench git history can restore the entries. Refused while the project
   * is open in a Window (close or switch away first). Resolves to a
   * ProjectRemoveResult.
   */
  ProjectRemove: 'project:remove',
  /**
   * renderer → main (invoke): the self-heal confirm (issue 95, ADR-0017) —
   * register a git repo that appeared under a project's workspace root, from
   * its Inbox `new-repo-candidate` item. Reuses the ADR-0015 registration path:
   * adds the repo to the project's CONFIG `repos:` map (promoted to
   * `default_repo` when the project was repo-less), appends one active
   * `registry.md` entry, and lands ONE boring workbench commit. Refuses (a
   * taken key, a path already a member or already registered) without writing.
   * Resolves to a RepoRegisterResult.
   */
  RepoRegister: 'repo:register',
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
  /**
   * Spawn this Run HEADLESS (issue 139, ADR-0001 amendment): `claude -p
   * --output-format stream-json --verbose` as a plain child process (no pty),
   * watched via a read-only Feed, instead of an interactive Pane. Set by the
   * drain for every drain Run (from this slice on, drain Runs are headless);
   * absent/false for a manual single Run, which keeps its interactive Pane. The
   * Worker seed (prompt, CORE.md, Receipt path) is byte-identical either way.
   */
  headless?: boolean;
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

/**
 * A "Just talk" target (issue 81, ADR-0016): one warm bare `claude` session —
 * no issue claimed, nothing tracked — in a project's default repo (or any
 * bare folder). For a workbench project, main reads its `memory/CORE.md` at
 * the spawn edge and injects it as the labeled context section (issue 73);
 * a bare folder spawns with no initial prompt at all.
 */
export interface TalkTarget {
  /** Absolute cwd for the session: the project's default repo / bare folder. */
  cwd: string;
  /**
   * The workbench project root (`~/Workbench/<project>`) when talking to a
   * workbench project — where `memory/CORE.md` is read from. Null for a bare
   * folder or a legacy project: nothing is injected.
   */
  workbenchProjectRoot: string | null;
  /**
   * True for a Planning session (issue 101): the spawn carries an explicit
   * Workbench artifact destination in its prompt so `/to-prd` / `/to-issues`
   * write into the Workbench, not the session's cwd. Absent/false for a plain
   * "Just talk" session, which stays bare and untracked.
   */
  planning?: boolean;
  /** Compact display label for the Pane header. */
  label: string;
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
  /**
   * When present, spawn a warm bare "Just talk" `claude` session (issue 81).
   * Mutually exclusive with `run` and `dispatcher`.
   */
  talk?: TalkTarget;
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

/**
 * A headless Run's claude session id, captured from its stream-json output
 * (issue 139). Broadcast once per Run, when the leading `system`/`init` event
 * (or the first event carrying a `session_id`) is parsed.
 */
export interface RunSessionCapturedMessage {
  /** The MC-internal spawn session id (routes this to the right Feed). */
  sessionId: SessionId;
  /** The claude session id parsed from the stream (for resume/take-over). */
  claudeSessionId: string;
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
  /**
   * The human clicked through the protected-branch warning for this landing
   * (issue 113): proceed even though the target is a protected branch
   * (`main`/`master`). Absent/false ⇒ the guard WITHHOLDS the commit and returns
   * `protectedBranch` so the drain can raise the warning gate.
   */
  confirmProtectedLand?: boolean;
}

export interface MainCommitResult {
  /** True when a new commit landed on `main` this call (false ⇒ nothing to do). */
  committed: boolean;
  /**
   * The protected branch this commit was WITHHELD from pending confirmation
   * (issue 113) — set only when the target is protected (`main`/`master`) and the
   * request did not carry `confirmProtectedLand`. Nothing was committed; the drain
   * raises the "big warning" gate and, on approval, re-invokes with confirmation.
   * Null/absent when not withheld.
   */
  protectedBranch?: string | null;
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
  /**
   * Per-branch merge-preview verdicts (issues 104, 105 & 106, ADR-0018), computed
   * in the background and read from the coordinator's cache on this scan (the scan
   * never computes). Every finished-unmerged branch per repo carries a verdict
   * from the FULL sequential merge in merge order (`clean` / `conflicts (files…)`
   * / `blocked behind NN` / `won't merge — adds install artifacts` /
   * `recalculating`); the sequence stops at the first predicted conflict, so
   * branches after it read `blocked behind NN`, and a branch that would introduce
   * ignored install artifacts badges the artifact verdict per offender (issue 106,
   * superseding its textual verdict). A mid-merge repo instead badges every branch
   * `suspended` ("merge in progress", issue 107) — no verdict is computed while a
   * partial merge is unresolved. Empty only when previews are unavailable (git <
   * 2.38).
   */
  previews: BranchPreview[];
  /**
   * The single passive note shown when merge previews are unavailable because
   * git is below the 2.38 floor (ADR-0018 degradation), else null. Never
   * accompanied by badges.
   */
  previewNote: string | null;
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
  /**
   * The human clicked through the protected-branch warning for this merge
   * (issue 113): integrate even though the target (the repo's checked-out branch)
   * is protected (`main`/`master`). Absent/false ⇒ the guard WITHHOLDS the merge
   * and returns `protectedBranch` so the drain can raise the warning gate.
   */
  confirmProtectedLand?: boolean;
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
  /**
   * The protected branch this merge was WITHHELD from pending confirmation
   * (issue 113) — set only when the target is protected (`main`/`master`) and the
   * request did not carry `confirmProtectedLand`. Nothing was merged; the drain
   * raises the "big warning" gate and, on approval, re-invokes with confirmation.
   * Null/absent when not withheld.
   */
  protectedBranch?: string | null;
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
  /**
   * Declared `repos:` keys whose directory does not yet exist on disk (ADR-0017
   * planned-first, issue 96): a repo may be declared before it's created. The
   * Map grays a planned repo and its `repo:`-targeting issues; a drain holds
   * those issues rather than erroring them. A key drops out once its directory
   * appears (and is registered — issue 95). Empty for a legacy Project and for
   * a workbench Project whose declared repos all exist.
   */
  plannedRepoKeys: string[];
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
 * A drain ended (any stop reason) — write its journal entry into the
 * workbench project's `memory/journal/` (issue 73, ADR-0015).
 */
export interface DrainJournalRequest {
  /** The Project key whose drain ended. */
  projectPath: string;
  /** The drain's stated stop reason (Coordinator message / user stop). */
  reason: string;
  /** THIS drain's Run-log records (the delta since the drain started). */
  records: RunLogRecord[];
  /** One-line notable events: stray adoptions, finished-without-receipt. */
  notables: string[];
}

export interface DrainJournalResult {
  /** True when a journal entry landed on disk (workbench Projects only). */
  written: boolean;
  /** The absolute path of the entry, when written. */
  path: string | null;
  /** The failure when the write was attempted and failed; null otherwise. */
  error: string | null;
}

/**
 * The aggregated cross-project attention state (issue 79, ADR-0016): every
 * active workbench project's items from the pure attention model (issue 78),
 * grouped by project (projects ascending; each project's items in the model's
 * deterministic order). Pushed on change and pullable on demand. Derived
 * read-only from workbench artifacts — displaying or ignoring it never writes.
 */
export interface AttentionSnapshot {
  /**
   * The workbench root the items' `project` names live under (issue 80):
   * `<workbenchRoot>/<item.project>` is the directory click-through hands to
   * the normal `openProject` flow, so the renderer never guesses a path.
   */
  workbenchRoot: string;
  /** Every active project's attention items, in stable aggregate order. */
  items: AttentionItem[];
  /** `<project>: <note>` lines about malformed artifacts that derived no item. */
  notes: string[];
}

/** The stamps after an Inbox view advanced them (issue 80). */
export interface AttentionMarkSeenResult {
  /** Project directory name → ISO-8601 last-seen stamp, as now persisted. */
  lastSeen: Record<string, string>;
}

/**
 * Sent to one Window when a native OS notification is clicked (issue 138): open
 * (or switch to) the named Project through the normal click-through flow and
 * land on its attention surface. Shaped so the renderer resolves the project
 * path exactly as the Inbox does (`workbenchProjectPath(workbenchRoot, project)`).
 */
export interface NavigateAttentionMessage {
  /** The workbench root the `project` dir name lives under. */
  workbenchRoot: string;
  /** The workbench project directory name to open/focus. */
  project: string;
  /** The issue to select on the Project's attention surface, or null. */
  issueId: number | null;
}

/**
 * One project as the Launcher's Continue / Quick fix / Just talk actions see
 * it (issue 81, ADR-0016): an active workbench-registry project — open in a
 * Window or not — with its resolved handles and truthful backlog counts.
 */
export interface LauncherProject {
  /** The workbench directory name (matches attention items' `project`). */
  dirName: string;
  /** Compact display name. */
  label: string;
  /** The workbench project root — the handle the open/Continue flow uses. */
  workbenchDir: string;
  /** The repo a Run without a `repo:` key targets (Just talk's cwd). */
  defaultRepoPath: string;
  /** Where the project's `NN-slug.md` issue files live. */
  issuesRoot: string;
  /** Where the project's Receipts land. */
  completionsRoot: string;
  /** The backlog's status counts, read fresh off disk. */
  counts: { open: number; wip: number; done: number };
  /** ISO-8601 of the most recent issue/Receipt file change, or null. */
  lastActivity: string | null;
}

export interface LauncherListResult {
  /** Active workbench projects, most recently active first. */
  projects: LauncherProject[];
}

/**
 * One Project as the project-first home grid's CARD sees it (issue 115,
 * ADR-0019): a SUPERSET of `LauncherProject` — every raw signal it already
 * carries (identity handles, backlog counts, last-activity) — plus the display
 * labels the pure card model shapes. This slice adds only the `open·wip·done`
 * tally line and a relative last-activity label; issue 118 extends the shape
 * with HITL / liveness / pipeline-stage fields (and attention-float ordering)
 * WITHOUT a new type, so the aggregator and renderer never reshape.
 */
export interface ProjectCardView extends LauncherProject {
  /** The `open · wip · done` tally line (card model — every count, even zero). */
  countsLabel: string;
  /** A relative last-activity label, e.g. "5m ago" / "no activity yet". */
  activityLabel: string;
  /**
   * Live-Run count (issue 118) — powers the "N running" liveness and the
   * attention-float ordering's top tier.
   */
  liveRuns: number;
  /**
   * Parked HITL count (issue 118) — the attention-float ordering's second tier.
   */
  parkedHitl: number;
  /**
   * Needs-you count (issue 125) — this Project's actionable attention items,
   * from `attention-hub-model`. The card's needs-you badge (no badge at zero),
   * and the SAME number the rail badge and the attention surface read for this
   * Project, so the three can never disagree.
   */
  needsYou: number;
  /**
   * The liveness label (issue 118): `"N running"` when a Run is live, else a
   * relative last-activity time, or `"not started"` for a repo-less Project
   * with an empty backlog.
   */
  livenessLabel: string;
  /** The pipeline stage (issue 118) — raw, for any consumer that needs it. */
  stage: PipelineStage;
  /** The pipeline-stage badge label (issue 118), e.g. "Planning" / "Executing". */
  stageLabel: string;
}

export interface ProjectGridResult {
  /** Every home-grid card, in grid order (most recently active first). */
  cards: ProjectCardView[];
}

export interface QuickFixCreateRequest {
  /** The chosen project's workbench root (`~/Workbench/<project>`). */
  workbenchDir: string;
  /** The user's one sentence describing the fix. */
  sentence: string;
}

export interface QuickFixCreateResult {
  /** True when the issue file landed in the workbench backlog. */
  ok: boolean;
  /** A user-facing reason when `ok` is false; null on success. */
  error: string | null;
  /** The created issue's number, on success. */
  issueId: number | null;
  /** The created issue's `NN-slug.md` file name, on success. */
  fileName: string | null;
  /** The created issue's title (its heading text), on success. */
  title: string | null;
}

export interface ProjectRemoveRequest {
  /** The workbench directory name of the project to remove (`dirName`). */
  dirName: string;
}

export interface ProjectRemoveResult {
  /** True when the project's registry entries were removed. */
  ok: boolean;
  /** A user-facing reason when `ok` is false; null on success. */
  error: string | null;
  /**
   * Set when the removal itself succeeded but the workbench auto-commit did
   * not — the registry on disk is already correct; commit it by hand.
   */
  warning: string | null;
}

export interface RepoRegisterRequest {
  /** The workbench project directory name the repo joins. */
  project: string;
  /** The appeared repo's absolute path (from the Inbox candidate). */
  repoPath: string;
  /** The short `repos:` key to register it under (the candidate's suggestion). */
  key: string;
}

export interface RepoRegisterResult {
  /** True when the repo was registered (CONFIG + registry written + committed). */
  ok: boolean;
  /** Refusal reasons when `ok` is false (a taken key, an already-registered path). */
  errors: string[];
  /**
   * Set when the write succeeded but the workbench auto-commit did not — the
   * repo is registered on disk; commit it by hand.
   */
  warning: string | null;
  /** The key actually registered, on success. */
  key: string | null;
}

export interface IssueFileReadRequest {
  /** The Project key whose resolved issues root holds the file. */
  projectPath: string;
  /** The plain `NN-slug.md` file name (no directories). */
  fileName: string;
}

export interface IssueFileReadResult {
  /** The file name echoed back, so a stale response can be discarded. */
  fileName: string;
  /** The raw file text (frontmatter + body), or null when unreadable. */
  content: string | null;
  /** Why reading failed, else null. */
  error: string | null;
}

export interface IssueFileEditRequest {
  /** The Project key whose resolved issues root holds the file. */
  projectPath: string;
  /** The plain `NN-slug.md` file name (no directories). */
  fileName: string;
  /** The FULL replacement text, written verbatim when it validates. */
  content: string;
}

export interface IssueFileDeleteRequest {
  /** The Project key whose resolved issues root holds the file. */
  projectPath: string;
  /** The plain `NN-slug.md` file name (no directories). */
  fileName: string;
}

/** The outcome of an issue-file edit or delete (issue 89). */
export interface IssueFileWriteResult {
  /** True when the write/delete landed on disk. */
  ok: boolean;
  /** The refusal (parse-breaking save, wip delete) or fs failure, else null. */
  error: string | null;
}

/**
 * Watch (or, with an empty `workbenchDir`, stop watching) a project's planning
 * roots for the Planning view's live doc preview (issue 83, ADR-0016).
 */
export interface PlanningWatchRequest {
  /** The workbench project root (`~/Workbench/<project>`); '' = unwatch. */
  workbenchDir: string;
  /** The project's default code repo (`CONTEXT.md` / `docs/adr/` live here). */
  repoPath: string;
}

/** Pushed whenever the watched planning doc set changes (and once on watch). */
export interface PlanningChangedMessage {
  /** The workbench root the watch was started for (matches pushes to views). */
  workbenchDir: string;
  /** The watched docs, most-recently-changed first. */
  docs: PlanningDoc[];
}

export interface PlanningDocReadRequest {
  /** Absolute path of the doc to read — must be within the watched roots. */
  path: string;
}

export interface PlanningDocReadResult {
  /** The requested path, echoed so a stale response can be discarded. */
  path: string;
  /** The document text, or null when it could not be read. */
  content: string | null;
  /** Why reading failed (unwatched path / fs error), else null. */
  error: string | null;
}

/** One repo row of the New project form: a short key + a path (issue 82). */
export interface OnboardingRepoDraft {
  /** The CONFIG `repos:` map key (no spaces/colons). */
  key: string;
  /** The code-repo path as entered (absolute or `~/`-prefixed). */
  path: string;
}

export interface OnboardingCreateRequest {
  /** The project display name; slugged into the workbench directory name. */
  name: string;
  /**
   * Zero or more repo drafts; the FIRST becomes `default_repo`. Empty is valid
   * — a repo-less project (ADR-0017): just a name + workspace root, no repos.
   */
  repos: OnboardingRepoDraft[];
  /**
   * The workspace root the user entered, or empty/absent for the default
   * `~/Developer/<name>` (ADR-0017) — where the project's code lives/will live.
   */
  workspaceRoot?: string;
  /** Validate only — report errors/warnings, write nothing. */
  dryRun?: boolean;
}

export interface OnboardingCreateResult {
  /** True when the plan holds (and, unless dryRun, everything was written). */
  ok: boolean;
  /** Refusal reasons — every problem named, not just the first. */
  errors: string[];
  /** Non-blocking notes (non-git / missing path) — warn, then allow. */
  warnings: string[];
  /** The workbench directory name, when the plan holds. */
  dirName: string | null;
  /** The absolute workbench project root, when the plan holds. */
  workbenchDir: string | null;
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
  /**
   * Write a finished drain's journal entry into the workbench project's
   * `memory/journal/` (issue 73) — one dated entry per drain, auto-committed.
   * A quiet no-op for legacy Projects.
   */
  writeDrainJournal(req: DrainJournalRequest): Promise<DrainJournalResult>;
  /** The current aggregated cross-project attention snapshot (issue 79). */
  listAttention(): Promise<AttentionSnapshot>;
  /** Subscribe to attention-list changes; returns an unsubscribe function. */
  onAttentionChanged(listener: (msg: AttentionSnapshot) => void): () => void;
  /**
   * The Inbox was viewed (issue 80): advance the briefing's last-seen stamps
   * (app userData) and re-derive, so seen journal entries stop surfacing.
   */
  markAttentionSeen(): Promise<AttentionMarkSeenResult>;
  /**
   * Subscribe to OS-notification click-throughs (issue 138): fired on the
   * focused Window when the human clicks a native notification, so the renderer
   * opens the named Project's attention surface. Returns an unsubscribe function.
   */
  onNavigateAttention(listener: (msg: NavigateAttentionMessage) => void): () => void;
  /**
   * The Launcher's project list (issue 81): every active workbench-registry
   * project with truthful backlog counts, most recently active first.
   */
  listLauncherProjects(): Promise<LauncherListResult>;
  /**
   * The project-first home grid (issue 115): every workbench project as a
   * `ProjectCardView` (signals + card-model labels), in grid order. Parallel
   * to `listLauncherProjects`; clicking a card switches the Window in place to
   * that project's Map.
   */
  listProjectCards(): Promise<ProjectGridResult>;
  /**
   * The Launcher's Quick fix (issue 81): one sentence → a standalone issue in
   * the chosen workbench backlog, auto-committed.
   */
  createQuickFix(req: QuickFixCreateRequest): Promise<QuickFixCreateResult>;
  /**
   * The Launcher's New project flow (issue 82): validate (dryRun) or perform
   * the ADR-0015 project setup + registry entries + one workbench commit.
   */
  createProject(req: OnboardingCreateRequest): Promise<OnboardingCreateResult>;
  /**
   * The Launcher's Remove project (issue 92): drop the project's registry
   * entries (workbench dir and repos stay on disk), auto-committed. Refused
   * while the project is open in a Window.
   */
  removeProject(req: ProjectRemoveRequest): Promise<ProjectRemoveResult>;
  /**
   * Self-heal confirm (issue 95, ADR-0017): register a repo that appeared under
   * a project's workspace root, from its Inbox `new-repo-candidate` item — adds
   * the CONFIG `repos:` entry + a registry line, auto-committed.
   */
  registerRepo(req: RepoRegisterRequest): Promise<RepoRegisterResult>;
  /**
   * Read one issue file's raw text for the Map's editor (issue 89) — fresh
   * off disk, restricted to the Project's issues root.
   */
  readIssueFile(req: IssueFileReadRequest): Promise<IssueFileReadResult>;
  /**
   * Save one issue file's full replacement text (issue 89): parser-validated
   * before the write, written verbatim, workbench auto-committed.
   */
  editIssueFile(req: IssueFileEditRequest): Promise<IssueFileWriteResult>;
  /**
   * Delete one issue file (issue 89): refused for `wip` (someone owns it),
   * workbench auto-committed.
   */
  deleteIssueFile(req: IssueFileDeleteRequest): Promise<IssueFileWriteResult>;
  /**
   * Start (or, with an empty `workbenchDir`, stop) the Planning view's live
   * doc watch over the project's planning roots (issue 83).
   */
  watchPlanning(req: PlanningWatchRequest): void;
  /** Subscribe to planning doc-set changes; returns an unsubscribe function. */
  onPlanningChanged(listener: (msg: PlanningChangedMessage) => void): () => void;
  /** Read one watched planning document for the read-only preview (issue 83). */
  readPlanningDoc(req: PlanningDocReadRequest): Promise<PlanningDocReadResult>;
  spawnPty(req: PtySpawnRequest): Promise<PtySpawnResult>;
  writePty(msg: PtyWriteMessage): void;
  resizePty(msg: PtyResizeMessage): void;
  killPty(msg: PtyKillMessage): void;
  onPtyData(listener: (msg: PtyDataMessage) => void): () => void;
  onPtyExit(listener: (msg: PtyExitMessage) => void): () => void;
  /**
   * Subscribe to headless Runs' captured claude session ids (issue 139): fired
   * when a headless Run's stream-json yields its `session_id`. The renderer's
   * Feed self-filters by the internal `sessionId` and persists the
   * `claudeSessionId` on the Run. Returns an unsubscribe function.
   */
  onRunSessionCaptured(listener: (msg: RunSessionCapturedMessage) => void): () => void;
}

declare global {
  interface Window {
    mc: MissionControlApi;
  }
}
