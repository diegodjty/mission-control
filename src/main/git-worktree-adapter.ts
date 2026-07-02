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
import { shouldCommitWorktree } from '../shared/run-state';
import { issueIdFromSlug, type AfkBranchFacts } from '../shared/worktree-scan';
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

/** Turn parallel mode on by writing the `issues/.afk-parallel` flag. */
export async function enableParallel(projectPath: string): Promise<void> {
  const flag = parallelFlagPath(projectPath);
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
    slugs.map(async (slug) => ({
      issueId: issueIdFromSlug(slug),
      slug,
      hasWorktree: worktreeSlugs.has(slug),
      committedStatus: await readCommittedIssueStatus(projectPath, slug),
      mergedIntoMain: await isMergedIntoMain(projectPath, slug),
    })),
  );
  return facts.sort((a, b) => a.issueId - b.issueId);
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
 * committed) is skipped, so re-observing never double-commits. Returns whether a
 * new commit was made. Best-effort: git failures are swallowed (the committed
 * state simply stays behind, so the Run is not yet reported finished).
 */
export async function commitFinishedWorktree(
  projectPath: string,
  slug: string,
): Promise<boolean> {
  const worktreePath = worktreePathFor(projectPath, slug);
  if (!existsSync(worktreePath)) return false;

  const worktreeStatus = await readWorktreeIssueStatus(projectPath, slug);
  if (!shouldCommitWorktree({ isolated: true, worktreeStatus })) return false;

  try {
    // Idempotency guard: with nothing changed vs. the branch tip there is
    // nothing to commit (a Run already committed, by MC or by hand).
    const porcelain = await git(worktreePath, ['status', '--porcelain']);
    if (porcelain.trim().length === 0) return false;
    await git(worktreePath, ['add', '-A']);
    await git(worktreePath, ['commit', '-m', commitMessageForRun(slug)]);
    return true;
  } catch {
    return false;
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
 * work is actually committed and thus mergeable. Returns null when the branch
 * isn't readable (nothing observed yet) — `deriveRunStatus` treats that as
 * not-done, exactly as for an unobserved main-backlog status.
 */
export async function readIsolatedIssueStatus(
  projectPath: string,
  slug: string,
): Promise<IssueStatus | null> {
  await commitFinishedWorktree(projectPath, slug);
  return readCommittedIssueStatus(projectPath, slug);
}
