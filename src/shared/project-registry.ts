/**
 * Project Registry — the pure decision core of ADR-0004's "one backend, many
 * Windows" model.
 *
 * The single main-process backend owns a registry of **Projects**: each a
 * **project key** (its identity — see below), a **pipeline stage** (`planning →
 * backlog → executing → merge-qa`), and — at most — one **Window** currently
 * managing it. This module holds two decisions and nothing else:
 *
 *   1. **Stage transitions** — which moves along the pipeline are legal
 *      (`canTransition` / `transitionStage`).
 *   2. **Project ownership** — a Project may be managed by at most ONE Window
 *      at a time, so a second Window trying to open/manage a Project another
 *      Window already owns is rejected with a clear message (`claimProject` /
 *      `switchActiveProject`). This is what stops two Windows double-managing
 *      a Project and stomping each other's worktrees/merges (ADR-0004).
 *
 * **The key (issue 71, ADR-0015).** A Project used to be identified by its
 * repo path. Under the Workbench a Project is a workbench entry that may span
 * several repos, so the identity is now the resolved **project key**: the
 * workbench project directory for a workbench Project, the repo path for a
 * legacy (in-repo `issues/`) one. The caller (main's open flow) resolves every
 * user-supplied handle — repo path or workbench dir — through the pure
 * project-identity module BEFORE it reaches this registry, so two aliases of
 * one Project always collapse to one key and can never be double-owned.
 *
 * It is PURE (no Electron, no fs, no BrowserWindow): every function takes a
 * registry value and returns a new one, never mutating the input, so the
 * decisions are unit-testable in isolation (see PRD "Testing Decisions"). The
 * main process holds one live `ProjectRegistry` value and maps real Windows to
 * `windowId`s; this module just decides. Path canonicalisation that needs the
 * filesystem (symlink resolution) is the caller's job — `normalizeProjectKey`
 * here only normalises the textual form (trim, strip trailing slashes) so two
 * spellings of the same path share one identity.
 */

/** The Mission Control pipeline stages, in order (PRD: planning → merge/QA). */
export const PIPELINE_STAGES = ['planning', 'backlog', 'executing', 'merge-qa'] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Opaque id for one Window (the main process maps this to a BrowserWindow). */
export type WindowId = string;

/** One Project in the registry. `key` (normalized) is its identity. */
export interface Project {
  /**
   * The Project's identity: the resolved project key — a workbench project
   * directory, or a legacy repo path. Normalized.
   */
  key: string;
  /** Where this Project sits in the pipeline. */
  stage: PipelineStage;
  /** The Window currently managing it, or null when no Window has it open. */
  ownerWindowId: WindowId | null;
}

/** The whole registry: the set of Projects the single backend owns. */
export interface ProjectRegistry {
  /** Projects keyed by `key`, ascending for determinism. */
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
 * Normalize a project key to its textual identity: trim surrounding whitespace
 * and strip trailing slashes (but never reduce a root `/` to empty). This does
 * NOT touch the filesystem — symlink/realpath canonicalisation (and workbench
 * alias resolution, issue 71) is the caller's responsibility before it reaches
 * the registry.
 */
export function normalizeProjectKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** Find a Project by (un-normalized) key, or undefined. */
export function findProject(
  registry: ProjectRegistry,
  rawKey: string,
): Project | undefined {
  const key = normalizeProjectKey(rawKey);
  return registry.projects.find((p) => p.key === key);
}

/** Keep the projects list ascending by key so results are deterministic. */
function sortedProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.key.localeCompare(b.key));
}

/** Replace (or insert) a Project by key, returning a new sorted list. */
function upsert(projects: readonly Project[], next: Project): Project[] {
  const without = projects.filter((p) => p.key !== next.key);
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
 * Register a new Project (by its resolved key) in the registry. Rejects a
 * **duplicate key** — the same normalized key can only be registered once —
 * with a clear message. A freshly registered Project starts unowned
 * (`ownerWindowId: null`) at `initialStage` (default `backlog`, matching the
 * app's v1 reality of opening a Project that already has an issues backlog).
 */
export function registerProject(
  registry: ProjectRegistry,
  rawKey: string,
  initialStage: PipelineStage = 'backlog',
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  if (key === '') return fail(registry, 'A Project needs a path.');
  if (registry.projects.some((p) => p.key === key)) {
    return fail(registry, `Project already registered: ${key}`);
  }
  const project: Project = { key, stage: initialStage, ownerWindowId: null };
  return ok({ projects: upsert(registry.projects, project) }, project);
}

/**
 * Claim a Project for a Window — the core "no two Windows manage the same
 * Project" rule. The Project must be registered. If it is already owned by a
 * *different* Window, the claim is **rejected** with a clear message (this is
 * what prevents double-managing — and, with alias resolution upstream, what
 * stops the same Project being owned twice under a repo path AND its workbench
 * dir). If it is unowned, this Window becomes the owner; if this same Window
 * already owns it, the claim is an idempotent success.
 */
export function claimProject(
  registry: ProjectRegistry,
  rawKey: string,
  windowId: WindowId,
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  const project = registry.projects.find((p) => p.key === key);
  if (!project) return fail(registry, `No such Project: ${key}`);
  if (project.ownerWindowId !== null && project.ownerWindowId !== windowId) {
    return fail(
      registry,
      `${key} is already open in another Window — a Project can only be managed by one Window at a time.`,
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
  rawKey: string,
  windowId: WindowId,
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  const project = registry.projects.find((p) => p.key === key);
  if (!project) return fail(registry, `No such Project: ${key}`);
  if (project.ownerWindowId !== windowId) {
    // Not this Window's to release; leave the registry as-is.
    return ok(registry, project);
  }
  const released: Project = { ...project, ownerWindowId: null };
  return ok({ projects: upsert(registry.projects, released) }, released);
}

/**
 * Switch a Window's active Project to `rawKey`'s Project, atomically: the
 * Window releases whatever Project it currently holds and claims the target.
 * If the target is owned by a *different* Window the switch is **rejected**
 * and the registry is left entirely unchanged (the Window keeps its current
 * Project) — so a failed switch never strands a Window with nothing open. The
 * target must already be registered.
 */
export function switchActiveProject(
  registry: ProjectRegistry,
  windowId: WindowId,
  rawKey: string,
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  const target = registry.projects.find((p) => p.key === key);
  if (!target) return fail(registry, `No such Project: ${key}`);
  if (target.ownerWindowId !== null && target.ownerWindowId !== windowId) {
    return fail(
      registry,
      `${key} is already open in another Window — a Project can only be managed by one Window at a time.`,
    );
  }

  // Release the Window's current Project (if any), then claim the target — in
  // one new registry value so a caller never sees the intermediate state.
  const projects = registry.projects.map((p) => {
    if (p.key === key) return { ...p, ownerWindowId: windowId };
    if (p.ownerWindowId === windowId) return { ...p, ownerWindowId: null };
    return p;
  });
  const claimed = projects.find((p) => p.key === key)!;
  return ok({ projects: sortedProjects(projects) }, claimed);
}

/**
 * The whole ProjectOpen decision (issue 87): open `rawKey`'s Project in
 * `windowId`'s Window — registering it first if it has never been seen (at
 * `initialStage`; an already-registered Project keeps its stage), then
 * switching the Window onto it with `switchActiveProject`'s release-then-claim
 * semantics.
 *
 * Open MUST behave like switch, not like a bare claim: a bare `claimProject`
 * from a Window that already owns another Project leaves the Window owning
 * BOTH, and any "which Project is this Window on?" lookup then has two answers
 * — the walkthrough-86 stale-switch, where an Inbox click-through or Launcher
 * Continue claimed the target fine but the Window's active Project (selector,
 * Map, watchers) stayed on the previous one. Routing open through the switch
 * semantics keeps the invariant `activeProjectKeyFor` relies on: a Window owns
 * at most ONE Project.
 *
 * Failure modes are inherited unchanged: an empty key is refused ("a Project
 * needs a path"), a target owned by a different Window is refused with the
 * standard ownership message and the registry left untouched — the Window
 * keeps whatever it had open.
 */
export function openProjectForWindow(
  registry: ProjectRegistry,
  rawKey: string,
  windowId: WindowId,
  initialStage: PipelineStage = 'backlog',
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  if (!findProject(registry, key)) {
    const reg = registerProject(registry, key, initialStage);
    if (!reg.ok) return reg;
    registry = reg.registry;
  }
  return switchActiveProject(registry, windowId, key);
}

/**
 * The key of the ONE Project a Window actively manages right now, or null.
 * Meaningful because every ownership-changing flow (open via
 * `openProjectForWindow`, switch via `switchActiveProject`, close via
 * `closeWindow`) preserves the one-Project-per-Window invariant — so "the
 * first owned Project" and "the Window's current Project" are the same thing.
 * Never use a first-owned scan where the invariant might not hold (issue 88).
 */
export function activeProjectKeyFor(
  registry: ProjectRegistry,
  windowId: WindowId,
): string | null {
  return registry.projects.find((p) => p.ownerWindowId === windowId)?.key ?? null;
}

/**
 * Apply a pipeline stage transition to a Project. Rejects an illegal move (not
 * adjacent in the pipeline) with a clear message and leaves the registry
 * unchanged; a legal move updates the Project's stage.
 */
export function transitionStage(
  registry: ProjectRegistry,
  rawKey: string,
  toStage: PipelineStage,
): RegistryResult {
  const key = normalizeProjectKey(rawKey);
  const project = registry.projects.find((p) => p.key === key);
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
 * Does `windowId` currently own the Project at `rawKey`? True iff a Project is
 * registered for that (normalized) key AND its `ownerWindowId` is exactly this
 * Window. A Project that isn't registered, or is unowned, or is owned by a
 * different Window, all return false.
 */
export function ownsProject(
  registry: ProjectRegistry,
  rawKey: string,
  windowId: WindowId,
): boolean {
  const project = findProject(registry, rawKey);
  return project !== undefined && project.ownerWindowId === windowId;
}

/** The verdict of an ownership check: allowed, or rejected with a reason. */
export interface OwnershipCheck {
  /** True when the calling Window may act on the target Project. */
  ok: boolean;
  /** A clear, user-facing rejection reason when `ok` is false; null otherwise. */
  error: string | null;
}

/**
 * Guard a Project-mutating/observing action: may `windowId` act on the Project
 * at `rawKey`?
 *
 * This is the decision behind ADR-0004's "one Window owns a Project" rule
 * applied at the point of ACTION, not just at open/switch. The worktree/merge/
 * observe IPC handlers all act on a project key the renderer supplied; a
 * renderer bug with a stale key, or a Window caught mid-release (its active
 * key not yet cleared while the registry has already moved on), could
 * otherwise drive a worktree mutation or a Merge on a Project it no longer
 * owns — concurrently with the real owner. Checking the LIVE registry at
 * action time closes that window:
 *
 *   - unregistered key → reject (nobody manages it);
 *   - unowned key → reject (no Window is driving it right now);
 *   - owned by a different Window → reject (that Window is the one driving it);
 *   - owned by this Window → allow.
 *
 * Because a Project has at most one owner, two *different* Windows can never
 * both pass this check for the same Project — so it also prevents cross-Window
 * concurrent git-worktree mutations, not just tidies up error messages.
 */
export function checkProjectOwnership(
  registry: ProjectRegistry,
  rawKey: string,
  windowId: WindowId,
): OwnershipCheck {
  const key = normalizeProjectKey(rawKey);
  const project = registry.projects.find((p) => p.key === key);
  if (!project) {
    return {
      ok: false,
      error: `No Project is registered for ${key} — this Window does not manage it.`,
    };
  }
  if (project.ownerWindowId === null) {
    return {
      ok: false,
      error: `${key} is not open in any Window — refusing to act on an unowned Project.`,
    };
  }
  if (project.ownerWindowId !== windowId) {
    return {
      ok: false,
      error: `${key} is managed by another Window — refusing to act on a Project this Window does not own.`,
    };
  }
  return { ok: true, error: null };
}

/**
 * Release every Project a Window owns — called when a Window closes so its
 * Projects are freed for another Window to open. Always succeeds.
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
