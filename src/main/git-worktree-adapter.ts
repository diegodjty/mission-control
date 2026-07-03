/**
 * Git/Worktree Adapter (main process) — the ONLY place real git worktree
 * operations happen. It executes the commands the pure Isolation Policy emits
 * (create/remove worktrees, toggle `issues/.afk-parallel`) and reads the
 * on-disk isolation state back for the policy to reconcile against.
 *
 * A thin I/O edge (ADR-0002): the DECISIONS live in `../shared/isolation-policy`
 * and are unit-tested; this adapter is verified by an integration check that
 * drives real git against a scratch repo (see git-worktree-adapter.test.ts).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  branchFor,
  commitMessageForRun,
  decideIsolation,
  reconcile,
  worktreeSlugFrom,
  type IsolationCommand,
  type IsolationRun,
  type IsolationState,
} from '../shared/isolation-policy';
import { buildBacklog, type IssueStatus } from '../shared/backlog-model';
import { shouldCommitWorktree, shouldCommitMain } from '../shared/run-state';
import { issueIdFromSlug, type AfkBranchFacts } from '../shared/worktree-scan';
import { ensureLocallyIgnored } from './local-ignore';
import type {
  IsolationApplyResult,
  ResolvedPlacement,
} from '../shared/ipc-contract';
import { readFile } from 'node:fs/promises';

const exec = promisify(execFile);

/** Where per-Run worktrees live: a sibling `.afk-worktrees/` dir, keyed by slug. */
export function worktreeBase(projectPath: string): string {
  return join(dirname(projectPath), '.afk-worktrees');
}

/** The absolute worktree path for a Run's `NN-slug`. */
export function worktreePathFor(projectPath: string, slug: string): string {
  return join(worktreeBase(projectPath), slug);
}

/** The `issues/.afk-parallel` flag file path for a Project. */
function parallelFlagPath(projectPath: string): string {
  return join(projectPath, 'issues', '.afk-parallel');
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: projectPath,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Is parallel mode on (the flag file present)? */
export function isParallel(projectPath: string): boolean {
  return existsSync(parallelFlagPath(projectPath));
}

/**
 * Turn parallel mode on by writing the `issues/.afk-parallel` flag. The flag is
 * Mission Control's own machine state, not something to commit, so it is locally
 * git-ignored as it is written (issue 18) — otherwise it shows as an untracked
 * change, dirties the working tree, and trips `afk-merge.sh`'s clean-repo
 * preflight, blocking every parallel merge. The ignore is idempotent and
 * worktree-safe (see `ensureLocallyIgnored`).
 */
export async function enableParallel(projectPath: string): Promise<void> {
  const flag = parallelFlagPath(projectPath);
  await ensureLocallyIgnored(projectPath, 'issues/.afk-parallel');
  await mkdir(dirname(flag), { recursive: true });
  await writeFile(
    flag,
    'Parallel mode: Mission Control gave each concurrent Run its own worktree.\n',
  );
}

/** Turn parallel mode off by removing the flag (idempotent). */
export async function disableParallel(projectPath: string): Promise<void> {
  await rm(parallelFlagPath(projectPath), { force: true });
}

/**
 * The `NN-slug`s that currently have a worktree registered on an `afk/*`
 * branch. Read from `git worktree list --porcelain`, matched by branch name
 * (path-agnostic — robust to the `/var`↔`/private/var` symlink on macOS).
 */
export async function listWorktreeSlugs(projectPath: string): Promise<string[]> {
  let out: string;
  try {
    out = await git(projectPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const line of out.split('\n')) {
    const match = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (!match) continue;
    const slug = worktreeSlugFrom(match[1]);
    if (slug !== null) slugs.push(slug);
  }
  return slugs;
}

/**
 * Every local `afk/NN-slug` branch, as `NN-slug` stems — INCLUDING ones whose
 * worktree has been removed (the branch survives so unmerged work can still be
 * merged, issue 08). This is the on-disk source of "which Runs exist" that
 * outlives closing all Panes (issue 16), where `listWorktreeSlugs` (worktrees
 * only) does not.
 */
export async function listAfkBranchSlugs(projectPath: string): Promise<string[]> {
  let out: string;
  try {
    out = await git(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const line of out.split('\n')) {
    const slug = worktreeSlugFrom(line.trim());
    if (slug !== null) slugs.push(slug);
  }
  return slugs;
}

/** Is the `afk/<slug>` branch tip already an ancestor of `main` (i.e. merged)? */
async function isMergedIntoMain(projectPath: string, slug: string): Promise<boolean> {
  try {
    // `--is-ancestor` exits 0 when merged, non-zero otherwise (rejects here).
    await git(projectPath, ['merge-base', '--is-ancestor', branchFor(slug), 'main']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the Project's on-disk `afk/` state (issue 16): for every `afk/NN-slug`
 * branch, whether it still has a worktree (Run in flight), the status committed
 * on its tip (`done` ⇒ finished/mergeable, per issue 15), and whether it is
 * already merged into `main`. The pure `worktree-scan` module turns these facts
 * into the Map's `running`/`finished (unmerged)` indicators and the on-disk
 * Merge affordance — a source of truth that survives closing every Pane, unlike
 * the renderer's in-memory tracked Runs. Sorted ascending by issue id.
 */
export async function scanAfkBranches(projectPath: string): Promise<AfkBranchFacts[]> {
  const slugs = await listAfkBranchSlugs(projectPath);
  const worktreeSlugs = new Set(await listWorktreeSlugs(projectPath));
  const facts = await Promise.all(
    slugs.map(async (slug) => {
      const hasWorktree = worktreeSlugs.has(slug);
      return {
        issueId: issueIdFromSlug(slug),
        slug,
        hasWorktree,
        committedStatus: await readCommittedIssueStatus(projectPath, slug),
        // Only meaningful while a worktree exists — the working-tree `done` flip
        // vs. the committed tip is what distinguishes a commit-failure from a
        // Run in progress (issue 22). No worktree ⇒ no working tree to read.
        worktreeStatus: hasWorktree
          ? await readWorktreeIssueStatus(projectPath, slug)
          : null,
        mergedIntoMain: await isMergedIntoMain(projectPath, slug),
      };
    }),
  );
  return facts.sort((a, b) => a.issueId - b.issueId);
}

/**
 * Is `main` left MID-MERGE — an in-progress (conflicted) merge with MERGE_HEAD
 * present (issue 24)? `afk-merge.sh` commits each clean slug to `main` before the
 * next, so a later slug's conflict `exit 1`s with `main` holding a conflicted
 * index and MERGE_HEAD set. A new drain/Run must not start on top of that, and
 * the UI offers an Abort until it's resolved. `git rev-parse --verify --quiet
 * MERGE_HEAD` exits 0 only while a merge is in progress.
 */
export async function isMidMerge(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Read the full on-disk isolation state for the policy to reconcile against. */
export async function currentState(projectPath: string): Promise<IsolationState> {
  return {
    parallel: isParallel(projectPath),
    worktreeSlugs: await listWorktreeSlugs(projectPath),
  };
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a worktree for a Run at `.afk-worktrees/<slug>` on `afk/<slug>`. If the
 * branch already exists (e.g. a re-run), it is attached rather than recreated.
 * Returns the worktree path.
 */
export async function createWorktree(
  projectPath: string,
  slug: string,
  branch: string,
): Promise<string> {
  const path = worktreePathFor(projectPath, slug);
  await mkdir(worktreeBase(projectPath), { recursive: true });
  const args = (await branchExists(projectPath, branch))
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path];
  await git(projectPath, args);
  return path;
}

/**
 * Remove a Run's worktree, keeping its `afk/<slug>` branch intact so any
 * unmerged work survives for the Merge step (issue 08). A plain (non-force)
 * remove is used deliberately: git refuses if the worktree has uncommitted
 * changes, which protects work from being silently discarded.
 */
export async function removeWorktree(projectPath: string, slug: string): Promise<void> {
  const path = worktreePathFor(projectPath, slug);
  await git(projectPath, ['worktree', 'remove', path]);
}

/**
 * Discard a STRANDED isolated Run (issue 22): FORCE-remove its worktree AND
 * delete its `afk/<slug>` branch, so a blocked/stopped/commit-failed Run that
 * can never merge stops cluttering the Map and, in solo terms, frees the batch
 * to proceed. Unlike `removeWorktree` (a deliberate non-force keep-the-branch
 * remove for finished work heading to Merge), this is the explicit "throw it
 * away" the user asks for — force is required precisely because the worktree has
 * uncommitted work and the branch is unmerged.
 *
 * Best-effort and idempotent per step: a missing worktree or branch is not an
 * error (the state may have been partially cleaned already), so re-invoking is
 * safe. `worktree prune` clears any stale admin entry left after a force remove.
 */
export async function discardWorktree(projectPath: string, slug: string): Promise<void> {
  const path = worktreePathFor(projectPath, slug);
  try {
    await git(projectPath, ['worktree', 'remove', '--force', path]);
  } catch {
    // No worktree registered (already removed / never created) — carry on.
  }
  try {
    await git(projectPath, ['worktree', 'prune']);
  } catch {
    // Pruning is housekeeping; a failure here must not block the branch delete.
  }
  try {
    await git(projectPath, ['branch', '-D', branchFor(slug)]);
  } catch {
    // Branch already gone — the discard is still complete.
  }
}

/** Execute a list of Isolation Policy commands against real git, in order. */
export async function applyCommands(
  projectPath: string,
  commands: IsolationCommand[],
): Promise<void> {
  for (const command of commands) {
    switch (command.type) {
      case 'enable-parallel':
        await enableParallel(projectPath);
        break;
      case 'disable-parallel':
        await disableParallel(projectPath);
        break;
      case 'create-worktree':
        await createWorktree(projectPath, command.slug, command.branch);
        break;
      case 'remove-worktree':
        await removeWorktree(projectPath, command.slug);
        break;
    }
  }
}

/**
 * The high-level operation the backend drives on every change to the active Run
 * set: decide the desired isolation, reconcile it against disk (creating and
 * removing worktrees, toggling parallel mode), and return each Run's resolved
 * cwd so its Pane spawns in the right place. Idempotent — safe to re-run.
 */
export async function applyIsolation(
  projectPath: string,
  runs: IsolationRun[],
): Promise<IsolationApplyResult> {
  const desired = decideIsolation(runs);
  const state = await currentState(projectPath);
  await applyCommands(projectPath, reconcile(state, desired));

  const placements: ResolvedPlacement[] = desired.placements.map((placed) =>
    placed.placement.kind === 'worktree'
      ? {
          issueId: placed.issueId,
          slug: placed.slug,
          cwd: worktreePathFor(projectPath, placed.slug),
          branch: placed.placement.branch,
        }
      : {
          issueId: placed.issueId,
          slug: placed.slug,
          cwd: projectPath,
          branch: null,
        },
  );

  return { parallel: desired.parallel, placements };
}

/** The `NN-slug` for a Run, from its issue file name (`NN-slug.md`). */
export function slugFromFileName(fileName: string): string {
  return basename(fileName, '.md');
}

/** Parse a single issue file's `status` via the pure Backlog Model. */
function statusOf(slug: string, content: string): IssueStatus | null {
  const backlog = buildBacklog([{ name: `${slug}.md`, content }], null);
  return backlog.issues[0]?.status ?? null;
}

/** Read a solo Run's issue status from the MAIN checkout working tree, or null. */
async function readMainIssueStatus(
  projectPath: string,
  slug: string,
): Promise<IssueStatus | null> {
  const issueFile = join(projectPath, 'issues', `${slug}.md`);
  try {
    return statusOf(slug, await readFile(issueFile, 'utf8'));
  } catch {
    return null;
  }
}

/** Read an isolated Run's issue status from its worktree working tree, or null. */
async function readWorktreeIssueStatus(
  projectPath: string,
  slug: string,
): Promise<IssueStatus | null> {
  const issueFile = join(worktreePathFor(projectPath, slug), 'issues', `${slug}.md`);
  try {
    return statusOf(slug, await readFile(issueFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read an isolated Run's issue status from its COMMITTED `afk/<slug>` branch via
 * `git show afk/<slug>:issues/<slug>.md`, or null when the branch/file isn't
 * readable. This is the authoritative "finished" source (issue 15): a Run is
 * finished only once its work is committed on the branch, so detection and Merge
 * — which integrates committed branches — agree on what `done` means.
 */
export async function readCommittedIssueStatus(
  projectPath: string,
  slug: string,
): Promise<IssueStatus | null> {
  try {
    const content = await git(projectPath, [
      'show',
      `${branchFor(slug)}:issues/${slug}.md`,
    ]);
    return statusOf(slug, content);
  } catch {
    return null;
  }
}

/**
 * Auto-commit a finished isolated Run's worktree onto its `afk/<slug>` branch
 * (issue 15, Option A). The agent is spawned in single-issue mode and never
 * commits, so when it finishes — flipping `issues/<slug>.md` to `done` in the
 * worktree working tree — the created/edited files and the `done` flip sit
 * uncommitted and the `afk/` branch stays empty, leaving Merge nothing to
 * integrate. Mission Control owns the worktree lifecycle (ADR-0002), so it makes
 * the commit itself.
 *
 * Only commits on the finished (done) transition — the pure `shouldCommitWorktree`
 * decides that from the worktree's working-tree status; a still-`wip`, blocked,
 * or stopped Run is left uncommitted (nothing to merge). Idempotent: a clean
 * worktree (nothing staged/untracked vs. its branch tip — e.g. a Run already
 * committed) is skipped, so re-observing never double-commits.
 *
 * Returns a structured outcome (issue 22, corr-5): `committed` says whether a new
 * commit landed, and `error` carries the git failure message when the commit was
 * ATTEMPTED and failed — instead of the old silent `false`, which made a finished
 * Run whose commit failed indistinguishable from one still running. A caller
 * (the isolated-status observe) surfaces that error so the UI can show a distinct
 * "commit failed" state; the committed state genuinely stays behind either way.
 */
export interface WorktreeCommitOutcome {
  /** True when a new commit was made on the `afk/<slug>` branch this call. */
  committed: boolean;
  /** The git error when the commit was attempted and failed, else null. */
  error: string | null;
}

export async function commitFinishedWorktree(
  projectPath: string,
  slug: string,
): Promise<WorktreeCommitOutcome> {
  const worktreePath = worktreePathFor(projectPath, slug);
  if (!existsSync(worktreePath)) return { committed: false, error: null };

  const worktreeStatus = await readWorktreeIssueStatus(projectPath, slug);
  if (!shouldCommitWorktree({ isolated: true, worktreeStatus })) {
    return { committed: false, error: null };
  }

  try {
    // Idempotency guard: with nothing changed vs. the branch tip there is
    // nothing to commit (a Run already committed, by MC or by hand).
    const porcelain = await git(worktreePath, ['status', '--porcelain']);
    if (porcelain.trim().length === 0) return { committed: false, error: null };
    await git(worktreePath, ['add', '-A']);
    await git(worktreePath, ['commit', '-m', commitMessageForRun(slug)]);
    return { committed: true, error: null };
  } catch (err) {
    // No longer swallowed: the finished work stays uncommitted (so the branch
    // is not yet mergeable), and we report WHY so the Run reads "commit failed"
    // rather than perpetually "running".
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Auto-commit a finished SOLO Run's work on `main` (issue 25) — the symmetric
 * counterpart of `commitFinishedWorktree` for isolated Runs. A solo Run works
 * directly on `main`; the spawned agent (single-issue mode) flips its issue to
 * `done` and leaves the created/edited files + the flip UNCOMMITTED, so `main`
 * stays dirty and the next parallel Merge fails its clean-tree preflight
 * ("commit or stash them first") — the exact wall the QA walkthrough hit. Since
 * Mission Control owns the Run lifecycle, it makes the commit itself so
 * "finished" uniformly means "committed".
 *
 * Only commits on the finished (done) transition — the pure `shouldCommitMain`
 * decides that from the main-checkout status; a still-`wip`, blocked, or stopped
 * solo Run is left for the user. Idempotent: a clean `main` (nothing staged/
 * untracked — e.g. already committed) is skipped, so re-observing never
 * double-commits. In solo mode only ONE Run is live at a time (isolation keys on
 * concurrency), so committing all of `main` captures exactly this Run's work.
 *
 * Returns the same structured outcome as `commitFinishedWorktree`: `committed`
 * says whether a new commit landed, and `error` carries the git failure message
 * when the commit was ATTEMPTED and failed.
 */
export async function commitFinishedMain(
  projectPath: string,
  slug: string,
): Promise<WorktreeCommitOutcome> {
  const mainStatus = await readMainIssueStatus(projectPath, slug);
  if (!shouldCommitMain({ isolated: false, mainStatus })) {
    return { committed: false, error: null };
  }

  try {
    // Idempotency guard: with a clean working tree there is nothing to commit
    // (this Run's work was already committed, by MC or by hand).
    const porcelain = await git(projectPath, ['status', '--porcelain']);
    if (porcelain.trim().length === 0) return { committed: false, error: null };
    await git(projectPath, ['add', '-A']);
    await git(projectPath, ['commit', '-m', commitMessageForRun(slug)]);
    return { committed: true, error: null };
  } catch (err) {
    // The finished work stays uncommitted (so `main` is still dirty) and we
    // report WHY rather than swallowing it.
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Observe an ISOLATED Run's completion from its OWN worktree/branch, not the
 * main checkout (issue 13) — a parallel Run flips its issue to `done` in a
 * worktree on `afk/<slug>`, invisible to the main-checkout backlog watcher.
 *
 * Issue 15 aligns "finished" with the COMMITTED branch state so detection and
 * Merge agree: first auto-commit the worktree if the agent has finished it
 * (idempotent — see `commitFinishedWorktree`), then read the status from the
 * committed `afk/<slug>` branch. A Run therefore only shows finished once its
 * work is actually committed and thus mergeable. `status` is null when the
 * branch isn't readable (nothing observed yet) — `deriveRunStatus` treats that
 * as not-done, exactly as for an unobserved main-backlog status.
 *
 * `commitError` (issue 22, corr-5) carries any auto-commit failure so the
 * renderer can surface a distinct "commit failed" state instead of the failure
 * being swallowed and the Run reading "running" forever.
 */
export interface IsolatedIssueObservation {
  status: IssueStatus | null;
  commitError: string | null;
}

export async function readIsolatedIssueStatus(
  projectPath: string,
  slug: string,
): Promise<IsolatedIssueObservation> {
  const { error } = await commitFinishedWorktree(projectPath, slug);
  return {
    status: await readCommittedIssueStatus(projectPath, slug),
    commitError: error,
  };
}
