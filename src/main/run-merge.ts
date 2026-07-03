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
import { removeWorktree, detectDefaultBranch } from './git-worktree-adapter';
import { ensureLocallyIgnored } from './local-ignore';
import { afkMergeConfContent } from '../shared/merge-plan';
import { branchFor } from '../shared/isolation-policy';
import {
  parseMergeSummary,
  classifyMergeFailure,
  parsePartialMerge,
  parseWrongBranch,
} from '../shared/merge-output';
import type { MergeRunsResult, MergeAbortResult } from '../shared/ipc-contract';

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
 * The user-facing wrong-branch preflight message (issue 27). afk-merge.sh refuses
 * unless the repo is on its DETECTED default branch, so we name the actual branch
 * pair from the script's `die` line ("on 'feature', not 'master'") rather than the
 * old, wrong hardcoded "not on main". Falls back to the detected default branch,
 * then to a generic phrasing, if the line can't be parsed.
 */
function wrongBranchMessage(output: string, defaultBranch: string): string {
  const wb = parseWrongBranch(output);
  if (wb) {
    return (
      `Merge preflight failed: the repository is on '${wb.current}', not its default ` +
      `branch '${wb.expected}'. Check out ${wb.expected}, then Merge again.`
    );
  }
  return (
    `Merge preflight failed: the repository is not on its default branch ` +
    `('${defaultBranch}'). Check out ${defaultBranch}, then Merge again.`
  );
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
 * On exit 0 the script may still have SKIPPED branches (missing, or already on
 * main), so we parse its `=== summary ===` block for the slugs it actually
 * merged: only those are reported in `merged`, and only their worktrees are
 * removed (non-force — untracked leftovers keep the worktree, reported) and
 * branches deleted. A skipped slug is named in the message, never counted as a
 * fresh merge (issue 23). On any non-zero exit nothing is cleaned up, the
 * failure is classified from the script's structured lines (conflict vs.
 * preflight refusal) so the message names the real cause, and the script's own
 * output is surfaced verbatim. Never resolves conflicts silently (issue 08).
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

  // The branch afk-merge.sh integrates into is the repo's default branch, not a
  // hardcoded `main` (issue 27) — detect it so every message names the real one.
  const defaultBranch = await detectDefaultBranch(projectPath);

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
    // Classify from the script's structured lines, not a substring, so a
    // preflight refusal is reported as its real cause instead of a false
    // "conflict" or a generic "could not run".
    const cause = classifyMergeFailure(output);

    if (cause === 'conflict') {
      // A conflict leaves `main` MID-MERGE: the script merges + commits each slug
      // in turn, so earlier slugs are already ON main while a later one's conflict
      // stopped the run with a conflicted index / MERGE_HEAD (issue 24). Recover
      // the partial truth from the per-slug progress lines (the `=== summary ===`
      // block is never reached) so the report says "A merged, B conflicted, main
      // is mid-merge" instead of the old, wrong "nothing merged / cleaned up".
      const partial = parsePartialMerge(output);
      const merged = partial.mergedBeforeConflict;
      const conflictedOn = partial.conflictedSlug;
      const files = partial.conflictingFiles;

      const mergedPart =
        merged.length > 0
          ? `Merged ${merged.length} branch${merged.length === 1 ? '' : 'es'} into ${defaultBranch} ` +
            `(${merged.join(', ')}), then hit`
          : 'Hit';
      const conflictPart = conflictedOn ? `a conflict on ${conflictedOn}` : 'a conflict';
      const filesPart = files.length > 0 ? ` in ${files.join(', ')}` : '';
      const staySuffix =
        merged.length > 0
          ? ` (the already-merged branch${merged.length === 1 ? '' : 'es'} stay${merged.length === 1 ? 's' : ''} merged)`
          : '';
      const message =
        `${mergedPart} ${conflictPart}${filesPart} — ${defaultBranch} is now mid-merge. ` +
        `Resolve the conflict and commit, or Abort the merge to return ${defaultBranch} to a clean state${staySuffix}.`;

      return {
        ok: false,
        conflicted: true,
        midMerge: true,
        merged,
        conflictingFiles: files,
        message,
        output,
      };
    }

    const message =
      cause === 'dirty-tree'
        ? 'Merge preflight failed: the repository has uncommitted changes. Commit or stash them, then Merge again.'
        : cause === 'wrong-branch'
          ? wrongBranchMessage(output, defaultBranch)
          : 'Merge could not run — see details below.';
    return { ok: false, conflicted: false, midMerge: false, merged: [], message, output };
  }

  // Clean merge (exit 0). The script exits 0 even when it SKIPPED branches that
  // were missing or already on main, so parse its `=== summary ===` block for
  // the slugs it ACTUALLY merged this run — report and clean up only those.
  const summary = parseMergeSummary(output);
  const mergedSlugs = summary.mergedSlugs;

  const cleanup = options.cleanup !== false;
  const merged: string[] = [];
  const leftBehind: string[] = [];
  for (const slug of mergedSlugs) {
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

  // Name any requested slugs that were skipped (missing branch / already in
  // main) so a stale-scan Merge reads honestly ("Merged 0 branches …") instead
  // of claiming a merge that never happened.
  const skipNotes = summary.rows
    .filter((r) => !r.merged && r.skipReason)
    .map((r) => `${r.slug}: ${r.skipReason}`);

  const base = `Merged ${merged.length} branch${merged.length === 1 ? '' : 'es'} into ${defaultBranch}`;
  const skipSuffix = skipNotes.length > 0 ? ` (${skipNotes.join('; ')})` : '';
  const cleanupSuffix =
    leftBehind.length > 0
      ? `. Left worktree(s) for ${leftBehind.join(', ')} in place (uncommitted changes).`
      : cleanup && merged.length > 0
        ? ` and cleaned up ${merged.length === 1 ? 'its worktree' : 'their worktrees'}.`
        : '.';
  const message = `${base}${skipSuffix}${cleanupSuffix}`;

  return { ok: true, conflicted: false, midMerge: false, merged, message, output };
}

/**
 * Abort an in-progress (conflicted) merge on `main` (issue 24). A partial
 * `afk-merge.sh` run leaves `main` mid-merge — a conflicted index with MERGE_HEAD
 * set — after committing earlier clean slugs; `git merge --abort` unwinds JUST
 * that in-progress merge, returning `main` to a clean state (the already-committed
 * clean slugs stay merged; only the conflicting merge is undone). This is the
 * in-app "back to a clean main" path so a non-git user isn't stranded and a new
 * drain/Run isn't blocked forever.
 *
 * Idempotent: if there is nothing to abort (no MERGE_HEAD), git errors with "no
 * merge to abort" — we treat that as success (main is already clean) rather than
 * surfacing a scary failure.
 */
export async function abortMerge(projectPath: string): Promise<MergeAbortResult> {
  try {
    await exec('git', ['merge', '--abort'], { cwd: projectPath });
    return { ok: true, error: null };
  } catch (err) {
    const failure = err as ExecFailure;
    const detail = `${failure.stderr ?? ''}${failure.stdout ?? ''}`.trim();
    // Nothing in progress to abort ⇒ main is already clean; not a real failure.
    if (/no merge to abort|MERGE_HEAD missing/i.test(detail)) {
      return { ok: true, error: null };
    }
    return { ok: false, error: detail || 'git merge --abort failed' };
  }
}
