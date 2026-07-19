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
import {
  removeWorktree,
  forceRemoveWorktree,
  detectDefaultBranch,
  reconcileMergedWorktrees,
  adoptStrayReceipts,
} from './git-worktree-adapter';
import { ensureLocallyIgnored } from './local-ignore';
import { afkMergeConfContent } from '../shared/merge-plan';
import { branchFor } from '../shared/isolation-policy';
import { isProtectedBranch } from '../shared/action-authority';
import {
  ignoredArtifactPaths,
  artifactMergeRefusalMessage,
  type ArtifactOffender,
} from '../shared/artifact-hygiene';
import {
  parseMergeSummary,
  classifyMergeFailure,
  parsePartialMerge,
  parseWrongBranch,
  dirtyPathsFromPorcelain,
  dirtyTreeMessage,
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
/**
 * The offending paths behind a dirty-tree preflight refusal (issue 59), read
 * from `git status --porcelain` in the main checkout — the script's own `die`
 * line names only the repo directory, not what is actually uncommitted. Best
 * effort: an unreadable status yields [] and the message falls back to the
 * generic phrasing.
 */
async function dirtyMainPaths(projectPath: string): Promise<string[]> {
  try {
    // `--untracked-files=all` so a file inside a brand-new directory is named
    // itself (`docs/PRD.md`) rather than as an opaque `docs/` dir entry — the
    // message should name what is actually uncommitted (issues 59/62).
    const { stdout } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectPath,
    });
    return dirtyPathsFromPorcelain(stdout);
  } catch {
    return [];
  }
}

/**
 * The ignored install-artifact paths a branch would INTRODUCE relative to the
 * default branch (issue 98) — `git diff --name-only <default>...<branch>` (the
 * changes on the branch since it diverged) filtered through the pure hygiene rule.
 * Empty when the branch adds none, or when the branch/diff can't be read (a
 * missing branch is reported later by afk-merge.sh's own "no branch" skip).
 */
async function branchIntroducedArtifacts(
  projectPath: string,
  branch: string,
  defaultBranch: string,
): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--name-only', `${defaultBranch}...${branch}`],
      { cwd: projectPath, maxBuffer: 16 * 1024 * 1024 },
    );
    return ignoredArtifactPaths(
      stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    );
  } catch {
    return [];
  }
}

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
  /**
   * Whether to run the stray-Receipt adoption sweep before the preflight
   * (issue 62). Default true (legacy). Workbench Projects pass false (issue
   * 72): their Receipts live in the workbench, never in a code repo, so a
   * dirty `issues/completions/` there is unknown state — the truthful
   * preflight halt applies, not a repair.
   */
  adoptStrays?: boolean;
  /**
   * A workbench Project's issues root (issue 72): threaded into the merged-
   * worktree reconciliation sweep so its committed-`done` detection reads the
   * workbench claim surface. Absent for legacy (in-repo reads, unchanged).
   */
  workbenchIssuesRoot?: string;
  /**
   * The protected-branch guard (issue 113). When present, a merge whose target
   * is a protected branch (`main`/`master`) is WITHHELD unless `confirmed` — the
   * result carries `protectedBranch` and nothing runs, so the drain can raise the
   * "big warning" gate and, on approval, re-invoke with `confirmed: true`. Absent
   * ⇒ no guard (legacy/adapter callers; behavior unchanged). The production
   * MergeRuns IPC handler always passes it.
   */
  protectedBranchGuard?: { confirmed: boolean };
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
    return {
      ok: true,
      conflicted: false,
      merged: [],
      adopted: [],
      message: 'Nothing to merge.',
      output: '',
    };
  }

  const scriptPath = options.scriptPath ?? defaultMergeScriptPath();
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      conflicted: false,
      merged: [],
      adopted: [],
      message: `Merge tool not found at ${scriptPath}.`,
      output: '',
    };
  }

  await ensureMergeConf(projectPath);

  // The branch afk-merge.sh integrates into is the repo's CURRENTLY-checked-out
  // branch (issues 27/113), not a hardcoded `main` — detect it so every message
  // names the real one AND the protected-branch guard below reads the true target.
  const defaultBranch = await detectDefaultBranch(projectPath);

  // Protected-branch guard (issue 113): if the target is a protected branch
  // (`main`/`master`) and the human hasn't confirmed, WITHHOLD the whole merge —
  // BEFORE stray-Receipt adoption (which itself commits) or the script runs — so
  // nothing lands on the protected branch. The drain raises the "big warning"
  // gate off `protectedBranch`; on approval it re-invokes with `confirmed: true`.
  // A non-protected feature branch is unchanged (falls through, auto-proceeds).
  if (
    options.protectedBranchGuard &&
    !options.protectedBranchGuard.confirmed &&
    isProtectedBranch(defaultBranch)
  ) {
    return {
      ok: false,
      conflicted: false,
      midMerge: false,
      merged: [],
      adopted: [],
      protectedBranch: defaultBranch,
      message:
        `About to land Run work on the protected branch '${defaultBranch}'. ` +
        `'${defaultBranch}' may be tied to production/deploy workflows — confirm to merge, ` +
        `or decline to leave the finished work on its branch/worktree unmerged.`,
      output: '',
    };
  }

  // Adopt stray Receipts BEFORE the script's clean-tree preflight (issue 62,
  // ADR-0013): a Worker that misplaced its Receipt into the main checkout's
  // `issues/completions/` (instead of its own worktree's copy) is a KNOWN,
  // repairable artifact — auto-committed under a dedicated `chore: adopt stray
  // Receipt(s)` message so ONE stray file no longer fails every merge and piles
  // up finished-unmerged Runs. Anything dirty OUTSIDE that set is unknown state:
  // it is NOT committed, and the script's preflight still halts on it with the
  // truthful issue-59 message below. An adoption failure is likewise left to
  // that same preflight halt.
  const adoption =
    options.adoptStrays === false
      ? { adopted: [], error: null }
      : await adoptStrayReceipts(projectPath);
  const adopted = adoption.adopted;

  // Ignored-artifact preflight (issue 98): refuse — BEFORE running afk-merge.sh at
  // all — any branch that would add a local install artifact (a committed
  // `node_modules` symlink, a `dist/`/`out/` build output) to the default branch.
  // Merging such a branch makes the self-referential symlink point at its own
  // location, an infinite loop that clobbers the real install and kills every
  // build (observed during the 94/95/96 drain). We check every requested slug so
  // the message names them all at once, then halt with the truthful cause —
  // mirroring the issue-23/59 dirty-tree / stray-Receipt preflights. Halting here
  // means the script never runs, so the target repo's install is never touched.
  const artifactOffenders: ArtifactOffender[] = [];
  for (const slug of slugs) {
    const paths = await branchIntroducedArtifacts(projectPath, branchFor(slug), defaultBranch);
    if (paths.length > 0) artifactOffenders.push({ slug, paths });
  }
  if (artifactOffenders.length > 0) {
    return {
      ok: false,
      conflicted: false,
      midMerge: false,
      merged: [],
      adopted,
      message: artifactMergeRefusalMessage(defaultBranch, artifactOffenders),
      output: '',
    };
  }

  // --into: integrate into the code repo's CURRENTLY-checked-out branch (issue
  // 113), which `detectDefaultBranch` read above via `git symbolic-ref --short
  // HEAD`. Passing it explicitly stops afk-merge.sh from re-guessing and
  // PREFERRING a local `main`/`master`/`origin/HEAD` — the old behavior that
  // refused ("wrong branch" preflight) whenever the repo sat on a feature
  // branch. A feature-branch checkout now integrates into that feature branch.
  // --keep: never let the script touch worktree paths/branches (see file header
  // — its <slug>/<label> layout does not match ours). --no-test: Mission
  // Control verifies separately; the merge action stays focused on integration.
  const args = [
    scriptPath,
    '--project',
    projectPath,
    '--into',
    defaultBranch,
    '--keep',
    '--no-test',
    ...slugs,
  ];

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
        adopted,
        conflictingFiles: files,
        message,
        output,
      };
    }

    // A dirty-tree refusal names the ACTUAL offending paths (issue 59) — the
    // truthful "uncommitted changes on main: <paths>" a user (or the straggler-
    // Receipt commit) can act on, clearly distinct from a conflict.
    const message =
      cause === 'dirty-tree'
        ? dirtyTreeMessage(defaultBranch, await dirtyMainPaths(projectPath))
        : cause === 'wrong-branch'
          ? wrongBranchMessage(output, defaultBranch)
          : 'Merge could not run — see details below.';
    return {
      ok: false,
      conflicted: false,
      midMerge: false,
      merged: [],
      adopted,
      message,
      output,
    };
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
        // Non-force remove refuses on uncommitted/untracked leftovers. This slug
        // was just integrated by afk-merge.sh, so its work is CONFIRMED on the
        // default branch — the leftover is stale residue. Force-remove it (issue
        // 153): a lingering merged worktree is exactly what got re-observed into
        // a ghost completion commit. Nothing mergeable is lost.
        try {
          await forceRemoveWorktree(projectPath, slug);
        } catch {
          worktreeGone = false;
        }
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

  // Beyond the slugs THIS run merged, reconcile any OTHER on-disk `afk/` worktree
  // or branch whose work already reached the default branch (issue 50). The
  // per-slug loop above only cleans what `afk-merge.sh` merged THIS invocation;
  // residue that got onto the default branch by another route — a prior merge, a
  // re-run, the solo-committed-then-merged path — is SKIPPED by the script and so
  // was never cleaned, leaving `.afk-worktrees` directories behind after a
  // fully-merged drain. The sweep reuses the default-branch-aware merged check and
  // leaves not-yet-merged (finished-unmerged / running) worktrees untouched.
  if (cleanup) {
    const swept = await reconcileMergedWorktrees(
      projectPath,
      options.workbenchIssuesRoot !== undefined
        ? { workbenchIssuesRoot: options.workbenchIssuesRoot }
        : {},
    );
    for (const slug of swept.leftBehind) {
      if (!leftBehind.includes(slug)) leftBehind.push(slug);
    }
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

  return { ok: true, conflicted: false, midMerge: false, merged, adopted, message, output };
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
