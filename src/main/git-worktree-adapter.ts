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
  decideIsolation,
  reconcile,
  worktreeSlugFrom,
  type IsolationCommand,
  type IsolationRun,
  type IsolationState,
} from '../shared/isolation-policy';
import type {
  IsolationApplyResult,
  ResolvedPlacement,
} from '../shared/ipc-contract';

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
