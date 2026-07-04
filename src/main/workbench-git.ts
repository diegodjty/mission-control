/**
 * Workbench git (main process) — the auto-commit edge for the Workbench repo
 * (issue 72, ADR-0015).
 *
 * The Workbench (`~/Workbench/`) is ONE private git repo holding every
 * project's pipeline artifacts. Workers flip claims and write Receipts
 * directly in it; Mission Control auto-commits it after each Run event —
 * claim observed, park, done + Receipt — with boring
 * `<project>: issue NN <event>` messages, so the claim surface has history
 * without anyone hand-committing. Push is manual, always: this module NEVER
 * pushes (single-machine by construction — ADR-0015's tripwire).
 *
 * Scope discipline: everything is pathspec'd to the PROJECT directory the
 * event belongs to (`git add -A .` / `git commit … -- .` with cwd = the
 * project root), so a commit can never sweep in another project's dirt or
 * anything a human has staged elsewhere in the workbench. Idempotent: with
 * nothing changed under the project dir there is nothing to commit and the
 * call is a quiet no-op — a re-observed event commits nothing twice.
 *
 * Code repos never receive these workflow commits: the only cwd this module
 * ever runs git in is the workbench project root.
 *
 * WHICH events commit (and their messages) is the pure
 * `shared/workbench-run-events` module's decision; this file only does git.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WorkbenchCommitOutcome {
  /** True when a new commit landed in the workbench repo this call. */
  committed: boolean;
  /** The git error when a commit was attempted and failed, else null. */
  error: string | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Commit everything currently changed under the workbench PROJECT directory
 * (`projectRoot` = `~/Workbench/<project>`) with the given message. Quiet and
 * idempotent: a clean project dir commits nothing and returns
 * `{ committed: false, error: null }`; a missing git repo (or any git
 * failure) is reported, never thrown — a broken workbench must not take down
 * a Run. Never pushes.
 */
export async function commitWorkbenchProject(
  projectRoot: string,
  message: string,
): Promise<WorkbenchCommitOutcome> {
  try {
    // Stage every change under THIS project dir only (cwd-relative pathspec).
    await git(projectRoot, ['add', '-A', '.']);
    // Anything to commit? `--cached` vs HEAD, scoped to the project dir.
    // Exit 0 = no staged changes here → quiet no-op (idempotence).
    try {
      await git(projectRoot, ['diff', '--cached', '--quiet', '--', '.']);
      return { committed: false, error: null };
    } catch {
      // Non-zero exit: there IS something staged under the project dir.
    }
    // Pathspec'd commit: only this project's paths land, even if other paths
    // happen to be staged elsewhere in the workbench repo.
    await git(projectRoot, ['commit', '-m', message, '--', '.']);
    return { committed: true, error: null };
  } catch (err) {
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
