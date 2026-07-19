/**
 * Integration check for the branch-awareness reads/ops (issue 167): unlike
 * `detectDefaultBranch` (which exists to give the merge path an
 * always-usable integration-target name and so falls back to `main` on a
 * detached HEAD), `getBranchStatus` reports detachment EXPLICITLY, so the Map
 * can name it rather than silently implying the repo is on `main`. Drives
 * real git against a throwaway scratch repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBranch,
  getBranchStatus,
  listLocalBranches,
  switchBranch,
} from './git-worktree-adapter';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-branchstatus-'));
  repo = join(scratch, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), 'hi\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('getBranchStatus (issue 167)', () => {
  it('reports the current branch, not detached', async () => {
    expect(await getBranchStatus(repo)).toEqual({ branch: 'main', detached: false });
  });

  it('reports detached HEAD explicitly, unlike detectDefaultBranch\'s main fallback', async () => {
    const sha = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await git(repo, 'checkout', sha);
    expect(await getBranchStatus(repo)).toEqual({ branch: null, detached: true });
  });

  it('reports a feature branch by name', async () => {
    await git(repo, 'checkout', '-b', 'feature/x');
    expect(await getBranchStatus(repo)).toEqual({ branch: 'feature/x', detached: false });
  });
});

describe('listLocalBranches (issue 167)', () => {
  it('lists every local branch', async () => {
    await git(repo, 'branch', 'topic-a');
    await git(repo, 'branch', 'topic-b');
    expect((await listLocalBranches(repo)).sort()).toEqual(['main', 'topic-a', 'topic-b']);
  });
});

describe('createBranch / switchBranch (issue 167 pre-start actions)', () => {
  it('creates and checks out a new branch off HEAD', async () => {
    const outcome = await createBranch(repo, 'afk/167-new');
    expect(outcome).toEqual({ ok: true, error: null });
    expect(await getBranchStatus(repo)).toEqual({ branch: 'afk/167-new', detached: false });
  });

  it('fails cleanly creating a branch that already exists', async () => {
    await git(repo, 'branch', 'dupe');
    const outcome = await createBranch(repo, 'dupe');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('checks out an existing branch', async () => {
    await git(repo, 'branch', 'topic-c');
    const outcome = await switchBranch(repo, 'topic-c');
    expect(outcome).toEqual({ ok: true, error: null });
    expect(await getBranchStatus(repo)).toEqual({ branch: 'topic-c', detached: false });
  });

  it('fails cleanly switching to a branch that does not exist', async () => {
    const outcome = await switchBranch(repo, 'does-not-exist');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });
});
