/**
 * Build version adapter (main process, issue 173) — the I/O edge behind the
 * self-hosting stale-build banner. THE DECISION lives in
 * `../shared/build-staleness` (pure, unit-tested); this file only runs git
 * and reads `package.json`, exactly the ADR-0002 split every other adapter in
 * this directory follows.
 *
 * `readOwnRunningCommit` is meant to be called ONCE, at app startup, and its
 * result cached by the caller — it is MC's own running build's commit, not a
 * live read. Re-reading it on every scan tick would defeat the point: the
 * whole hazard is that the IN-MEMORY process can fall behind the ON-DISK repo
 * (e.g. because the very drain it is running lands merges into that repo).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** MC's own running build's commit — read HEAD from the given app root. */
export async function readOwnRunningCommit(appRoot: string): Promise<string | null> {
  return git(appRoot, ['rev-parse', 'HEAD']);
}

/**
 * Whether `repoPath` is the mission-control codebase itself (the self-hosting
 * case this issue warns about) — its `package.json` `name` field, the same
 * cheap identity check a drain target's own manifest already carries. Never
 * throws: a missing/unreadable/non-JSON `package.json` just reads as "not
 * mission-control".
 */
export async function isMissionControlRepo(repoPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(repoPath, 'package.json'), 'utf8');
    return JSON.parse(raw).name === 'mission-control';
  } catch {
    return false;
  }
}

/** The current tip commit of `branch` in `repoPath`, or null if unreadable. */
export async function readTipCommit(repoPath: string, branch: string): Promise<string | null> {
  return git(repoPath, ['rev-parse', branch]);
}

/** How many commits `from..to` holds in `repoPath` — 0 on any git failure. */
export async function countCommitsBehind(
  repoPath: string,
  from: string,
  to: string,
): Promise<number> {
  const out = await git(repoPath, ['rev-list', '--count', `${from}..${to}`]);
  const n = out === null ? NaN : Number(out);
  return Number.isFinite(n) ? n : 0;
}
