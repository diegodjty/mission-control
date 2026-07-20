/**
 * Integration check for the build-version adapter (issue 173): drives real
 * git + a real `package.json` against a throwaway scratch repo, never the
 * real project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOwnRunningCommit,
  isMissionControlRepo,
  readTipCommit,
  countCommitsBehind,
} from './build-version';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-buildversion-'));
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

describe('readOwnRunningCommit', () => {
  it('reads HEAD of the given repo', async () => {
    const sha = (await git(repo, 'rev-parse', 'HEAD')).trim();
    expect(await readOwnRunningCommit(repo)).toBe(sha);
  });

  it('returns null for a non-git directory', async () => {
    const plain = join(scratch, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    expect(await readOwnRunningCommit(plain)).toBeNull();
  });
});

describe('isMissionControlRepo', () => {
  it('is true when package.json name is "mission-control"', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'mission-control', version: '0.1.0' }),
    );
    expect(await isMissionControlRepo(repo)).toBe(true);
  });

  it('is false for any other package name', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'some-other-repo' }));
    expect(await isMissionControlRepo(repo)).toBe(false);
  });

  it('is false when package.json is missing', async () => {
    expect(await isMissionControlRepo(repo)).toBe(false);
  });
});

describe('readTipCommit + countCommitsBehind', () => {
  it('reads the tip of a branch and counts commits behind it', async () => {
    const first = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await writeFile(join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'second');
    await writeFile(join(repo, 'b.txt'), 'b\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'third');

    const tip = await readTipCommit(repo, 'main');
    expect(tip).not.toBeNull();
    expect(tip).not.toBe(first);
    expect(await countCommitsBehind(repo, first, tip as string)).toBe(2);
    expect(await countCommitsBehind(repo, tip as string, tip as string)).toBe(0);
  });

  it('readTipCommit returns null for an unknown branch', async () => {
    expect(await readTipCommit(repo, 'no-such-branch')).toBeNull();
  });
});
