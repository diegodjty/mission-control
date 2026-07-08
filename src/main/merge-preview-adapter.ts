/**
 * Preview simulation adapter (main process) — issue 104, ADR-0018.
 *
 * The thin git edge for merge previews: probe the git version once, resolve
 * branch tips (the cheap scan-tick READ), and run the read-only
 * `git merge-tree --write-tree` that predicts whether a branch merges cleanly
 * into the default branch.
 *
 * "Read-only" per ADR-0018 means NO refs, NO worktrees, NO index — `merge-tree
 * --write-tree` writes only UNREACHABLE objects into the odb (gc-pruned later),
 * which is accepted by design. The pure decisions (verdict shape, version
 * parsing) live in `../shared/merge-preview` and `../shared/git-version`; this
 * adapter is verified by an integration check driving real git against scratch
 * repos (see merge-preview-adapter.test.ts), including a no-side-effects invariant.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { branchFor } from '../shared/isolation-policy';
import { parseGitVersion, supportsMergeTree } from '../shared/git-version';
import type { MergeCandidate, PreviewStamp, RawSimOutcome } from '../shared/merge-preview';

const exec = promisify(execFile);

interface ExecFailure {
  stdout?: string;
  stderr?: string;
  code?: number;
}

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

/**
 * Simulate merging one branch tip into the default-branch tip with
 * `git merge-tree --write-tree --name-only <defaultTip> <branchTip>` (git ≥2.38).
 *
 * Exit 0 ⇒ clean. Exit 1 ⇒ conflict, and stdout is
 *   `<toplevel tree OID>\n<conflicting file>\n…\n\n<informational messages>`
 * so the conflicting files are the non-blank lines between the OID line and the
 * first blank line. Any other exit is a hard failure (unrelated histories, a bad
 * object) and throws, so the coordinator's `.catch` leaves the badge
 * `recalculating` rather than inventing a verdict. Tips are OIDs, so the merge is
 * reproducible even if the refs move afterwards.
 */
export async function simulateFirstMerge(
  repoPath: string,
  defaultTip: string,
  branchTip: string,
): Promise<RawSimOutcome> {
  try {
    await exec('git', ['merge-tree', '--write-tree', '--name-only', defaultTip, branchTip], {
      cwd: repoPath,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { kind: 'clean' };
  } catch (err) {
    const failure = err as ExecFailure;
    if (failure.code === 1) {
      return { kind: 'conflict', files: parseConflictFiles(failure.stdout ?? '') };
    }
    throw new Error(
      `git merge-tree failed (code ${failure.code ?? '?'}): ${(failure.stderr ?? '').trim()}`,
    );
  }
}

/**
 * The coordinator's compute hook: simulate the FIRST candidate's merge from a
 * stamp. `stamp.branchTips[0]` is the first (lowest-id) candidate's tip and
 * `stamp.defaultTip` the default branch's — the exact tips the scan observed, so
 * the verdict the coordinator caches is stamped with what it was computed against.
 */
export async function simulateForStamp(
  repoPath: string,
  stamp: PreviewStamp,
): Promise<RawSimOutcome> {
  return simulateFirstMerge(repoPath, stamp.defaultTip, stamp.branchTips[0]);
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
