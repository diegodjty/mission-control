/**
 * Git init (main process) — the "Initialize git" edge (issue 158, ADR-0017).
 *
 * A repo-less project's workspace root is a plain directory until a `git
 * init` lands there; issue 157 made the engine serialize on it rather than
 * collide, and this is the human's one-click fix: turn it into an actual git
 * repo with one initial commit, so `isGitRepoDir` (git-worktree-adapter.ts)
 * reports true and the project becomes isolatable. Fires only on the
 * explicit `git:init` IPC call (main/index.ts) — never on any load/scan path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitInitOutcome {
  /** True when `git init` and the initial commit both landed. */
  ok: boolean;
  /** The git failure message when `ok` is false, else null. */
  error: string | null;
}

/**
 * `git init` a directory, then commit its current tree (empty tree commits
 * fine via `--allow-empty`, so a freshly scaffolded-but-empty workspace root
 * still ends up with one commit to build worktrees from). Never throws.
 */
export async function initGitRepo(path: string): Promise<GitInitOutcome> {
  try {
    await exec('git', ['init'], { cwd: path });
    await exec('git', ['add', '-A'], { cwd: path });
    await exec('git', ['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: path });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
