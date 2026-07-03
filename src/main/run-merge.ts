/**
 * Merge Adapter (main process) — the ONLY place the real Merge happens (issue
 * 08, ADR-0002). It drives `afk-merge.sh` to integrate finished `afk/NN-slug`
 * branches into `main`, surfaces conflicts, and cleans up Mission Control's
 * worktrees on success. It is invoked only from the human-triggered Merge
 * action — never automatically.
 *
 * A thin I/O edge: the "when/what to merge" DECISION lives in the pure
 * `../shared/merge-plan` (unit-tested); this adapter is verified by an
 * integration check that drives the real `afk-merge.sh` against a scratch git
 * repo with real parallel branches (see run-merge.test.ts).
 *
 * ## The layout reconciliation (handoff from issue 07)
 * Mission Control places single-repo worktrees at `.afk-worktrees/<slug>`
 * (git-worktree-adapter). `afk-merge.sh` is a multi-repo integrator: it keys
 * worktrees as `$WT_BASE/<slug>/<label>` and, in its own cleanup step, would
 * look there — a path Mission Control never creates. We bridge the two without
 * changing issue 07's tested layout:
 *   - We generate a single-repo `issues/afk-merge.conf` (`REPOS=( "app|." )`)
 *     so the script finds and merges the `afk/<slug>` branches — the merge
 *     itself operates on the repo + branch, never the worktree path.
 *   - We pass `--keep` so the script never touches worktree paths or branches
 *     (its `<slug>/<label>` assumption would just miss ours harmlessly). Mission
 *     Control then removes the worktrees and deletes the branches itself, using
 *     the real `.afk-worktrees/<slug>` paths the adapter created. This is the
 *     only place the merge and the isolation adapter meet.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { removeWorktree } from './git-worktree-adapter';
import { ensureLocallyIgnored } from './local-ignore';
import { afkMergeConfContent } from '../shared/merge-plan';
import { branchFor } from '../shared/isolation-policy';
import type { MergeRunsResult } from '../shared/ipc-contract';

const exec = promisify(execFile);

/** The `issues/.afk-parallel` parallel-mode marker, relative to the project root. */
const PARALLEL_MARKER_IGNORE = 'issues/.afk-parallel';

/** Where afk-merge.sh lives (installed with the afk-issue-runner skill). */
export function defaultMergeScriptPath(): string {
  return join(homedir(), '.claude', 'skills', 'afk-issue-runner', 'afk-merge.sh');
}

function confPath(projectPath: string): string {
  return join(projectPath, 'issues', 'afk-merge.conf');
}

/**
 * Write the single-repo merge config if the project has none yet, and make sure
 * both it and the `issues/.afk-parallel` marker are locally ignored so neither
 * trips afk-merge.sh's clean-repo preflight. Ignoring the marker here (the merge
 * preflight, issue 18) also unblocks a repo that already had an un-ignored
 * `.afk-parallel` written into it before this fix — no manual git surgery.
 */
export async function ensureMergeConf(projectPath: string): Promise<void> {
  await ensureLocallyIgnored(projectPath, 'issues/afk-merge.conf');
  await ensureLocallyIgnored(projectPath, PARALLEL_MARKER_IGNORE);
  const path = confPath(projectPath);
  if (existsSync(path)) return;
  await mkdir(join(projectPath, 'issues'), { recursive: true });
  await writeFile(path, afkMergeConfContent());
}

export interface MergeRunsOptions {
  /** Override the afk-merge.sh path (tests point this at the installed script). */
  scriptPath?: string;
  /** Clean up worktrees + branches after a clean merge (default true). */
  cleanup?: boolean;
}

interface ExecFailure {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Merge the given finished `afk/NN-slug` branches into `main` and clean up.
 *
 * On a clean merge (script exit 0): each branch is now on `main`; we remove its
 * worktree (non-force — untracked leftovers keep the worktree, reported) and
 * delete the merged branch. On a conflict (or any non-zero exit): nothing is
 * cleaned up, the script's own output (which names the conflicting files and how
 * to resolve them) is surfaced verbatim, and the merge is left as the script
 * left it for the human. Never resolves conflicts silently (issue 08).
 */
export async function mergeRuns(
  projectPath: string,
  slugs: string[],
  options: MergeRunsOptions = {},
): Promise<MergeRunsResult> {
  if (slugs.length === 0) {
    return { ok: true, conflicted: false, merged: [], message: 'Nothing to merge.', output: '' };
  }

  const scriptPath = options.scriptPath ?? defaultMergeScriptPath();
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      conflicted: false,
      merged: [],
      message: `Merge tool not found at ${scriptPath}.`,
      output: '',
    };
  }

  await ensureMergeConf(projectPath);

  // --keep: never let the script touch worktree paths/branches (see file header
  // — its <slug>/<label> layout does not match ours). --no-test: Mission
  // Control verifies separately; the merge action stays focused on integration.
  const args = [scriptPath, '--project', projectPath, '--keep', '--no-test', ...slugs];

  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    const result = await exec('bash', args, { maxBuffer: 16 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const failure = err as ExecFailure;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
    code = typeof failure.code === 'number' ? failure.code : 1;
  }
  const output = [stdout, stderr].filter((s) => s.trim().length > 0).join('\n').trim();

  if (code !== 0) {
    const conflicted = /conflict/i.test(output);
    return {
      ok: false,
      conflicted,
      merged: [],
      message: conflicted
        ? 'Merge stopped on a conflict — resolve the listed files, then Merge again. Nothing was cleaned up.'
        : 'Merge could not run — see details below.',
      output,
    };
  }

  // Clean merge: integrate is done. Clean up Mission Control's own worktrees +
  // branches for exactly the slugs we merged (the script left them via --keep).
  const cleanup = options.cleanup !== false;
  const merged: string[] = [];
  const leftBehind: string[] = [];
  for (const slug of slugs) {
    if (cleanup) {
      let worktreeGone = true;
      try {
        await removeWorktree(projectPath, slug);
      } catch {
        // Non-force remove refuses on uncommitted/untracked leftovers — the
        // merged work is safely on main, so this is a soft failure we report.
        worktreeGone = false;
      }
      // Only delete the branch once its worktree is gone (git refuses to delete
      // a branch that is still checked out in a worktree).
      if (worktreeGone) {
        try {
          await exec('git', ['branch', '-d', branchFor(slug)], { cwd: projectPath });
        } catch {
          // Branch already gone, or not fully merged — leave it, don't fail.
        }
      } else {
        leftBehind.push(slug);
      }
    }
    merged.push(slug);
  }

  const base = `Merged ${merged.length} branch${merged.length === 1 ? '' : 'es'} into main`;
  const message =
    leftBehind.length > 0
      ? `${base}. Left worktree(s) for ${leftBehind.join(', ')} in place (uncommitted changes).`
      : `${base}${cleanup ? ' and cleaned up their worktrees.' : '.'}`;

  return { ok: true, conflicted: false, merged, message, output };
}
