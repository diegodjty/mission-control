/**
 * Project Registry — the pure decision core of ADR-0004's "one backend, many
 * Windows" model.
 *
 * The single main-process backend owns a registry of **Projects**: each a repo
 * path (its identity), a **pipeline stage** (`planning → backlog → executing →
 * merge-qa`), and — at most — one **Window** currently managing it. This module
 * holds two decisions and nothing else:
 *
 *   1. **Stage transitions** — which moves along the pipeline are legal
 *      (`canTransition` / `transitionStage`).
 *   2. **Repo ownership** — a repo may be managed by at most ONE Window at a
 *      time, so a second Window trying to open/manage a repo another Window
 *      already owns is rejected with a clear message (`claimProject` /
 *      `switchActiveProject`). This is what stops two Windows double-managing a
 *      repo and stomping each other's worktrees/merges (ADR-0004).
 *
 * It is PURE (no Electron, no fs, no BrowserWindow): every function takes a
 * registry value and returns a new one, never mutating the input, so the
 * decisions are unit-testable in isolation (see PRD "Testing Decisions"). The
 * main process holds one live `ProjectRegistry` value and maps real Windows to
 * `windowId`s; this module just decides. Path canonicalisation that needs the
 * filesystem (symlink resolution) is the caller's job — `normalizeRepoPath`
 * here only normalises the textual form (trim, strip trailing slashes) so two
 * spellings of the same path share one identity.
 */

/** The Mission Control pipeline stages, in order (PRD: planning → merge/QA). */
export const PIPELINE_STAGES = ['planning', 'backlog', 'executing', 'merge-qa'] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Opaque id for one Window (the main process maps this to a BrowserWindow). */
export type WindowId = string;

/** One Project in the registry. `repoPath` (normalized) is its identity. */
export interface Project {
  /** Canonical repo path — the Project's identity. Normalized. */
  repoPath: string;
  /** Where this Project sits in the pipeline. */
  stage: PipelineStage;
  /** The Window currently managing it, or null when no Window has it open. */
  ownerWindowId: WindowId | null;
}

/** The whole registry: the set of Projects the single backend owns. */
export interface ProjectRegistry {
  /** Projects keyed by `repoPath`, ascending by path for determinism. */
  readonly projects: readonly Project[];
}

/**
 * The outcome of a registry operation. On failure the `registry` is returned
 * **unchanged** and `error` explains why (in words fit to show a user); on
 * success `error` is null and `project` is the affected Project.
 */
export interface RegistryResult {
  ok: boolean;
  /** The new registry (unchanged from the input on failure). */
  registry: ProjectRegistry;
  /** A clear, user-facing message when `ok` is false; null on success. */
  error: string | null;
  /** The affected Project on success; null on failure. */
  project: Project | null;
}

/** An empty registry — the backend's starting state. */
export function emptyRegistry(): ProjectRegistry {
  return { projects: [] };
}

/**
 * Normalize a repo path to its textual identity: trim surrounding whitespace
 * and strip trailing slashes (but never reduce a root `/` to empty). This does
 * NOT touch the filesystem — symlink/realpath canonicalisation is the caller's
 * responsibility before it reaches the registry.
 */
export function normalizeRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** Find a Project by (un-normalized) repo path, or undefined. */
export function findProject(
  registry: ProjectRegistry,
  repoPath: string,
): Project | undefined {
  const key = normalizeRepoPath(repoPath);
  return registry.projects.find((p) => p.repoPath === key);
}

/** Keep the projects list ascending by path so results are deterministic. */
function sortedProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Replace (or insert) a Project by path, returning a new sorted list. */
function upsert(projects: readonly Project[], next: Project): Project[] {
  const without = projects.filter((p) => p.repoPath !== next.repoPath);
  return sortedProjects([...without, next]);
}

function ok(registry: ProjectRegistry, project: Project): RegistryResult {
  return { ok: true, registry, error: null, project };
}

function fail(registry: ProjectRegistry, error: string): RegistryResult {
  return { ok: false, registry, error, project: null };
}

/**
 * Index of a stage in the pipeline, or -1 if it isn't a known stage.
 */
function stageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

/**
 * Is a move from `from` to `to` a legal pipeline transition? Legal iff the two
 * stages are **adjacent** in the pipeline — one step forward (advance) or one
 * step back (rework). Staying in place or skipping a stage is illegal.
 */
export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  const fi = stageIndex(from);
  const ti = stageIndex(to);
  if (fi < 0 || ti < 0) return false;
  return Math.abs(ti - fi) === 1;
}

/**
 * Register a new Project (a repo path) in the registry. Rejects a **duplicate
 * repo** — the same normalized path can only be registered once — with a clear
 * message. A freshly registered Project starts unowned (`ownerWindowId: null`)
 * at `initialStage` (default `backlog`, matching the app's v1 reality of
 * opening a repo that already has an `issues/` backlog).
 */
export function registerProject(
  registry: ProjectRegistry,
  repoPath: string,
  initialStage: PipelineStage = 'backlog',
): RegistryResult {
  const key = normalizeRepoPath(repoPath);
  if (key === '') return fail(registry, 'A Project needs a repo path.');
  if (registry.projects.some((p) => p.repoPath === key)) {
    return fail(registry, `Project already registered: ${key}`);
  }
  const project: Project = { repoPath: key, stage: initialStage, ownerWindowId: null };
  return ok({ projects: upsert(registry.projects, project) }, project);
}

/**
 * Claim a Project for a Window — the core "no two Windows manage the same repo"
 * rule. The Project must be registered. If it is already owned by a *different*
 * Window, the claim is **rejected** with a clear message (this is what prevents
 * double-managing a repo). If it is unowned, this Window becomes the owner; if
 * this same Window already owns it, the claim is an idempotent success.
 */
export function claimProject(
  registry: ProjectRegistry,
  repoPath: string,
  windowId: WindowId,
): RegistryResult {
  const key = normalizeRepoPath(repoPath);
  const project = registry.projects.find((p) => p.repoPath === key);
  if (!project) return fail(registry, `No such Project: ${key}`);
  if (project.ownerWindowId !== null && project.ownerWindowId !== windowId) {
    return fail(
      registry,
      `${key} is already open in another Window — a repo can only be managed by one Window at a time.`,
    );
  }
  const claimed: Project = { ...project, ownerWindowId: windowId };
  return ok({ projects: upsert(registry.projects, claimed) }, claimed);
}

/**
 * Release a Project a Window owns (e.g. the Window closed, or switched away).
 * A no-op success if the Window doesn't own it — releasing something you don't
 * hold is harmless. Only the owning Window can release; another Window's claim
 * is left untouched.
 */
export function releaseProject(
  registry: ProjectRegistry,
  repoPath: string,
  windowId: WindowId,
): RegistryResult {
  const key = normalizeRepoPath(repoPath);
  const project = registry.projects.find((p) => p.repoPath === key);
  if (!project) return fail(registry, `No such Project: ${key}`);
  if (project.ownerWindowId !== windowId) {
    // Not this Window's to release; leave the registry as-is.
    return ok(registry, project);
  }
  const released: Project = { ...project, ownerWindowId: null };
  return ok({ projects: upsert(registry.projects, released) }, released);
}

/**
 * Switch a Window's active Project to `repoPath`, atomically: the Window
 * releases whatever Project it currently holds and claims the target. If the
 * target is owned by a *different* Window the switch is **rejected** and the
 * registry is left entirely unchanged (the Window keeps its current Project) —
 * so a failed switch never strands a Window with nothing open. The target must
 * already be registered.
 */
export function switchActiveProject(
  registry: ProjectRegistry,
  windowId: WindowId,
  repoPath: string,
): RegistryResult {
  const key = normalizeRepoPath(repoPath);
  const target = registry.projects.find((p) => p.repoPath === key);
  if (!target) return fail(registry, `No such Project: ${key}`);
  if (target.ownerWindowId !== null && target.ownerWindowId !== windowId) {
    return fail(
      registry,
      `${key} is already open in another Window — a repo can only be managed by one Window at a time.`,
    );
  }

  // Release the Window's current Project (if any), then claim the target — in
  // one new registry value so a caller never sees the intermediate state.
  const projects = registry.projects.map((p) => {
    if (p.repoPath === key) return { ...p, ownerWindowId: windowId };
    if (p.ownerWindowId === windowId) return { ...p, ownerWindowId: null };
    return p;
  });
  const claimed = projects.find((p) => p.repoPath === key)!;
  return ok({ projects: sortedProjects(projects) }, claimed);
}

/**
 * Apply a pipeline stage transition to a Project. Rejects an illegal move (not
 * adjacent in the pipeline) with a clear message and leaves the registry
 * unchanged; a legal move updates the Project's stage.
 */
export function transitionStage(
  registry: ProjectRegistry,
  repoPath: string,
  toStage: PipelineStage,
): RegistryResult {
  const key = normalizeRepoPath(repoPath);
  const project = registry.projects.find((p) => p.repoPath === key);
  if (!project) return fail(registry, `No such Project: ${key}`);
  if (!canTransition(project.stage, toStage)) {
    return fail(
      registry,
      `Illegal stage transition for ${key}: ${project.stage} → ${toStage}.`,
    );
  }
  const moved: Project = { ...project, stage: toStage };
  return ok({ projects: upsert(registry.projects, moved) }, moved);
}

/**
 * Does `windowId` currently own the Project at `repoPath`? True iff a Project is
 * registered for that (normalized) path AND its `ownerWindowId` is exactly this
 * Window. A repo that isn't registered, or is unowned, or is owned by a
 * different Window, all return false.
 */
export function ownsRepo(
  registry: ProjectRegistry,
  repoPath: string,
  windowId: WindowId,
): boolean {
  const project = findProject(registry, repoPath);
  return project !== undefined && project.ownerWindowId === windowId;
}

/** The verdict of an ownership check: allowed, or rejected with a reason. */
export interface OwnershipCheck {
  /** True when the calling Window may act on the target repo. */
  ok: boolean;
  /** A clear, user-facing rejection reason when `ok` is false; null otherwise. */
  error: string | null;
}

/**
 * Guard a repo-mutating/observing action: may `windowId` act on `repoPath`?
 *
 * This is the decision behind ADR-0004's "one Window owns a repo" rule applied
 * at the point of ACTION, not just at open/switch. The worktree/merge/observe
 * IPC handlers all act on a `projectPath` the renderer supplied; a renderer bug
 * with a stale path, or a Window caught mid-release (its `activeRepoPath` not
 * yet cleared while the registry has already moved on), could otherwise drive a
 * worktree mutation or a Merge on a repo it no longer owns — concurrently with
 * the real owner. Checking the LIVE registry at action time closes that window:
 *
 *   - unregistered path → reject (nobody manages it);
 *   - unowned path → reject (no Window is driving it right now);
 *   - owned by a different Window → reject (that Window is the one driving it);
 *   - owned by this Window → allow.
 *
 * Because a repo has at most one owner, two *different* Windows can never both
 * pass this check for the same repo — so it also prevents cross-Window
 * concurrent git-worktree mutations, not just tidies up error messages.
 */
export function checkRepoOwnership(
  registry: ProjectRegistry,
  repoPath: string,
  windowId: WindowId,
): OwnershipCheck {
  const key = normalizeRepoPath(repoPath);
  const project = registry.projects.find((p) => p.repoPath === key);
  if (!project) {
    return {
      ok: false,
      error: `No Project is registered for ${key} — this Window does not manage that repo.`,
    };
  }
  if (project.ownerWindowId === null) {
    return {
      ok: false,
      error: `${key} is not open in any Window — refusing to act on an unowned repo.`,
    };
  }
  if (project.ownerWindowId !== windowId) {
    return {
      ok: false,
      error: `${key} is managed by another Window — refusing to act on a repo this Window does not own.`,
    };
  }
  return { ok: true, error: null };
}

/**
 * Release every Project a Window owns — called when a Window closes so its
 * repos are freed for another Window to open. Always succeeds.
 */
export function closeWindow(
  registry: ProjectRegistry,
  windowId: WindowId,
): ProjectRegistry {
  const projects = registry.projects.map((p) =>
    p.ownerWindowId === windowId ? { ...p, ownerWindowId: null } : p,
  );
  return { projects: sortedProjects(projects) };
}
