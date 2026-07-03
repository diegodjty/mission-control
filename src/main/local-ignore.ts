/**
 * Local git-ignore helper (main process) — a shared thin I/O edge used by any
 * adapter that writes Mission Control's own machine state (the generated
 * `issues/afk-merge.conf`, the `issues/.afk-parallel` parallel-mode marker) into
 * a user's repo. That state is not something to commit; left un-ignored it shows
 * as an uncommitted change and trips `afk-merge.sh`'s clean-repo preflight,
 * blocking every parallel merge.
 *
 * Lives in its own module (rather than inside run-merge or the worktree adapter)
 * so both can use it without a circular import — run-merge already depends on the
 * worktree adapter.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);

/**
 * Locally git-ignore a path so it never shows as an uncommitted change. Uses
 * `.git/info/exclude` (resolved via `git rev-parse --git-path info/exclude`, so
 * it is correct even from a linked worktree — where `.git` is a file, not a
 * dir). Idempotent: the pattern is appended only if it is not already present,
 * so repeated calls never double-append. Best-effort: a failure here (not a git
 * repo yet, unusual layout) is swallowed — the caller handles the fallout.
 */
export async function ensureLocallyIgnored(projectPath: string, pattern: string): Promise<void> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: projectPath,
    });
    const excludePath = join(projectPath, stdout.trim());
    let current = '';
    if (existsSync(excludePath)) current = await readFile(excludePath, 'utf8');
    if (current.split('\n').some((line) => line.trim() === pattern)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await writeFile(excludePath, `${current}${sep}${pattern}\n`);
  } catch {
    // Not a git repo yet, or unusual layout — the caller handles the fallout.
  }
}
