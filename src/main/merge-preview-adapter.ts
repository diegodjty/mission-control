/**
 * Preview simulation adapter (main process) — issues 104, 105 & 106, ADR-0018.
 *
 * The thin git edge for merge previews: probe the git version once, resolve
 * branch tips (the cheap scan-tick READ), and run the read-only
 * `git merge-tree --write-tree` plumbing that predicts whether the finished
 * branches merge cleanly — as a SEQUENCE, in merge order (issue 105), exactly
 * as `afk-merge.sh` would integrate them.
 *
 * Sequential mechanism (ADR-0018). `merge-tree --write-tree` the first branch
 * against the default-branch tip; on a clean step it emits the merged toplevel
 * TREE, which we turn into a dangling `commit-tree` commit (parents: the
 * previous base, the just-merged branch) — the exact "main after merging this
 * branch" state — and `merge-tree` the next branch against THAT, and so on. The
 * chain STOPS at the first predicted conflict (later branches never merge, so we
 * never simulate them). Pairwise-against-main was rejected precisely because it
 * gets branch 2-of-N wrong; the chain reproduces the real press.
 *
 * "Read-only" per ADR-0018 means NO refs, NO worktrees, NO index — both
 * `merge-tree --write-tree` and the `commit-tree` chaining write only
 * UNREACHABLE objects into the odb (gc-pruned later), which is accepted by
 * design. The synthesized commits use a FIXED identity + date so an unchanged
 * batch re-hashes to the SAME dangling objects instead of churning new ones. The
 * pure decisions (verdict shape, sequence→badge mapping, version parsing) live
 * in `../shared/merge-preview` and `../shared/git-version`; this adapter is
 * verified by an integration check driving real git against scratch repos (see
 * merge-preview-adapter.test.ts), including the no-side-effects invariant.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { branchFor } from '../shared/isolation-policy';
import { parseGitVersion, supportsMergeTree } from '../shared/git-version';
import { ignoredArtifactPaths } from '../shared/artifact-hygiene';
import type {
  MergeCandidate,
  PreviewStamp,
  RawSimOutcome,
  SequenceSimOutcome,
} from '../shared/merge-preview';

const exec = promisify(execFile);

interface ExecFailure {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * The identity + fixed timestamps for the dangling commits the sequence chain
 * synthesizes. Set via env (never touching repo config, so the preview stays
 * read-only) and PINNED so re-simulating an unchanged batch produces byte-identical
 * commit objects — the odb sees the same unreachable OIDs, not fresh churn each tick.
 */
const PREVIEW_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'mc-preview',
  GIT_AUTHOR_EMAIL: 'mc-preview@local',
  GIT_COMMITTER_NAME: 'mc-preview',
  GIT_COMMITTER_EMAIL: 'mc-preview@local',
  GIT_AUTHOR_DATE: '1000000000 +0000',
  GIT_COMMITTER_DATE: '1000000000 +0000',
} as const;

/** Probe whether this machine's git supports `merge-tree --write-tree` (≥2.38). */
export async function probeMergeTreeSupport(): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['--version']);
    return supportsMergeTree(parseGitVersion(stdout));
  } catch {
    return false;
  }
}

async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', ref], { cwd: repoPath });
  return stdout.trim();
}

/**
 * Read the freshness stamp for `candidates` (ADR-0018): the default branch tip
 * plus each finished-unmerged branch's tip, ordered as given (ascending issue
 * id). Cheap plumbing (`rev-parse`) — this is the scan-tick READ that the
 * coordinator compares against its cache, distinct from the expensive
 * `merge-tree` simulation.
 */
export async function readPreviewStamp(
  repoPath: string,
  defaultBranch: string,
  candidates: MergeCandidate[],
): Promise<PreviewStamp> {
  const defaultTip = await revParse(repoPath, defaultBranch);
  const branchTips = await Promise.all(
    candidates.map((c) => revParse(repoPath, branchFor(c.slug))),
  );
  return { defaultTip, branchTips };
}

/** One merge-tree step's result: clean-with-merged-tree, or a conflict-with-files. */
interface StepResult {
  outcome: RawSimOutcome;
  /** The merged toplevel tree OID on a CLEAN step (to chain from), else null. */
  mergedTree: string | null;
}

/**
 * Run one read-only `git merge-tree --write-tree --name-only <base> <branch>`
 * step (git ≥2.38). `base` and `branch` are commit-ish (OIDs, or a synthesized
 * commit OID mid-chain).
 *
 * Exit 0 ⇒ clean; stdout's FIRST line is the merged toplevel tree OID — captured
 * so the sequence can build the next base from it. Exit 1 ⇒ conflict; stdout is
 *   `<toplevel tree OID>\n<conflicting file>\n…\n\n<informational messages>`
 * so the conflicting files are the non-blank lines between the OID line and the
 * first blank line. Any other exit is a hard failure (unrelated histories, a bad
 * object) and throws, so the coordinator's `.catch` leaves the badge
 * `recalculating` rather than inventing a verdict.
 */
async function mergeTreeStep(
  repoPath: string,
  base: string,
  branch: string,
): Promise<StepResult> {
  try {
    const { stdout } = await exec(
      'git',
      ['merge-tree', '--write-tree', '--name-only', base, branch],
      { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
    );
    return { outcome: { kind: 'clean' }, mergedTree: stdout.split('\n')[0].trim() };
  } catch (err) {
    const failure = err as ExecFailure;
    if (failure.code === 1) {
      return {
        outcome: { kind: 'conflict', files: parseConflictFiles(failure.stdout ?? '') },
        mergedTree: null,
      };
    }
    throw new Error(
      `git merge-tree failed (code ${failure.code ?? '?'}): ${(failure.stderr ?? '').trim()}`,
    );
  }
}

/**
 * Synthesize the dangling commit that IS "base after merging `branch`" — tree =
 * `mergedTree`, parents = (previous base, merged branch). Unreachable (no ref
 * points at it), so it is gc-prunable; the fixed identity/date keep it
 * reproducible. Its OID is the base the NEXT branch previews against.
 */
async function commitMergedTree(
  repoPath: string,
  mergedTree: string,
  baseParent: string,
  branchParent: string,
): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['commit-tree', mergedTree, '-p', baseParent, '-p', branchParent, '-m', 'mc-preview: sequence step'],
    { cwd: repoPath, env: { ...process.env, ...PREVIEW_COMMIT_ENV } },
  );
  return stdout.trim();
}

/**
 * Recompute a stamp's whole preview (issues 105 & 106): the merge-tree SEQUENCE
 * plus the per-branch install-artifact hygiene facts, packaged together so the
 * coordinator caches and stamps them as one unit.
 *
 * The sequence (105): fold the ordered branch tips into the default tip one at a
 * time, chaining each clean step through a synthesized commit, and STOP at the
 * first conflict — one `steps` entry per branch simulated (up to and including
 * the first conflict). `stamp.branchTips` are the ordered (ascending issue id)
 * finished-branch tips and `stamp.defaultTip` the base — the exact tips the scan
 * observed, so the verdict the coordinator caches is stamped with what it was
 * computed against.
 *
 * The artifact facts (106): the ignored install-artifact paths EACH branch would
 * introduce, computed for every candidate independent of the sequence stop (a
 * per-branch stable diff, see `readArtifactPaths`). The pure decision module
 * turns both into per-branch verdicts, the artifact fact superseding the textual
 * one per offender.
 */
export async function simulateSequence(
  repoPath: string,
  stamp: PreviewStamp,
): Promise<SequenceSimOutcome> {
  const steps: RawSimOutcome[] = [];
  let base = stamp.defaultTip;
  for (const branchTip of stamp.branchTips) {
    const step = await mergeTreeStep(repoPath, base, branchTip);
    steps.push(step.outcome);
    if (step.outcome.kind === 'conflict') break; // first conflict stops the sequence
    // Clean: advance the base to "everything merged so far" for the next branch.
    base = await commitMergedTree(repoPath, step.mergedTree as string, base, branchTip);
  }
  const artifactPaths = await readArtifactPaths(repoPath, stamp);
  return { steps, artifactPaths };
}

/**
 * The ignored install-artifact paths each candidate branch would INTRODUCE
 * relative to the default tip (issue 98/106), one entry per branch in merge
 * order (parallel to `stamp.branchTips`) — `git diff --name-only
 * <defaultTip>...<branchTip>` (the changes on the branch since it diverged),
 * filtered through the shared pure hygiene rule. This mirrors the press-time
 * merge preflight's own check (`run-merge.ts`) so the badge predicts exactly what
 * pressing Merge would refuse.
 *
 * A per-branch STABLE fact, so — unlike the merge-tree sequence — it is computed
 * for EVERY candidate, including any past the sequence's first-conflict stop: the
 * hygiene refusal fires for any requested offender regardless of merge order. A
 * branch/diff that can't be read yields [] (never a false offender); the real
 * Merge preflight is the authority.
 */
async function readArtifactPaths(repoPath: string, stamp: PreviewStamp): Promise<string[][]> {
  return Promise.all(
    stamp.branchTips.map((branchTip) => branchArtifacts(repoPath, stamp.defaultTip, branchTip)),
  );
}

/** The ignored-artifact paths one branch tip would add over the default tip. */
async function branchArtifacts(
  repoPath: string,
  defaultTip: string,
  branchTip: string,
): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--name-only', `${defaultTip}...${branchTip}`],
      { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
    );
    return ignoredArtifactPaths(
      stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    );
  } catch {
    return [];
  }
}

/**
 * Simulate merging a single branch tip into a base tip (the tracer primitive,
 * issue 104) — a one-step convenience over `mergeTreeStep`, kept for the adapter
 * integration tests that assert the raw clean/conflict-with-files outcomes and
 * OID reproducibility.
 */
export async function simulateFirstMerge(
  repoPath: string,
  baseTip: string,
  branchTip: string,
): Promise<RawSimOutcome> {
  return (await mergeTreeStep(repoPath, baseTip, branchTip)).outcome;
}

/** Conflicting file names from `merge-tree --name-only` conflict output. */
function parseConflictFiles(stdout: string): string[] {
  const lines = stdout.split('\n');
  const files: string[] = [];
  // Line 0 is the toplevel tree OID; the conflicted file names follow, one per
  // line, until the first blank line (after which come informational messages).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) break;
    files.push(line);
  }
  return files;
}
