/**
 * Integration check for the Merge Adapter (issue 08). This exercises the REAL
 * `afk-merge.sh` against a throwaway scratch git repo with REAL parallel
 * `afk/NN-slug` branches — created through Mission Control's own worktree
 * adapter so the layout under test is exactly the one issue 07 produces
 * (`.afk-worktrees/<slug>`). It proves the three things the acceptance criteria
 * hinge on and that are verifiable headlessly: a clean merge integrates every
 * branch into `main` and cleans up its worktree; a conflict is surfaced and
 * nothing is silently resolved or cleaned up.
 *
 * Never touches the real project or the real backlog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRuns, defaultMergeScriptPath } from './run-merge';
import { createWorktree, worktreePathFor } from './git-worktree-adapter';
import { branchFor } from '../shared/isolation-policy';

const exec = promisify(execFile);
const SCRIPT = defaultMergeScriptPath();

let scratch: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Real "finished parallel Run": a worktree on afk/<slug> with a committed change. */
async function finishedRun(slug: string, file: string, content: string): Promise<string> {
  const wt = await createWorktree(repo, slug, branchFor(slug));
  await writeFile(join(wt, file), content);
  await git(wt, 'add', '.');
  await git(wt, 'commit', '-m', `work for ${slug}`);
  return wt;
}

async function branchExists(slug: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', branchFor(slug));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-merge-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# scratch repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('mergeRuns — the real afk-merge.sh against real parallel branches', () => {
  it('the merge script exists where the skill installs it', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('integrates every finished branch into main and cleans up the worktrees', async () => {
    const wt3 = await finishedRun('03-a', 'a.txt', 'from run 3\n');
    const wt4 = await finishedRun('04-b', 'b.txt', 'from run 4\n');
    expect(existsSync(wt3)).toBe(true);
    expect(existsSync(wt4)).toBe(true);

    const result = await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });

    // Reported clean, both slugs merged.
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged.sort()).toEqual(['03-a', '04-b']);

    // Both branches' files are now on main.
    await git(repo, 'checkout', 'main');
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain('a.txt');
    expect(tracked).toContain('b.txt');

    // Worktrees are gone from disk and from git's registry...
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(false);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(false);
    const list = await git(repo, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain('afk/03-a');
    expect(list).not.toContain('afk/04-b');

    // ...and the merged branches are deleted.
    expect(await branchExists('03-a')).toBe(false);
    expect(await branchExists('04-b')).toBe(false);
  });

  it('surfaces a conflict, resolves nothing, and cleans up nothing', async () => {
    // Both Runs edit the same file differently → the second branch conflicts.
    await finishedRun('03-a', 'README.md', '# scratch repo\nchange from run 3\n');
    await finishedRun('04-b', 'README.md', '# scratch repo\nDIFFERENT change from run 4\n');

    const result = await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.merged).toEqual([]);
    // The conflicting file is named in the surfaced output.
    expect(result.output).toContain('README.md');

    // Nothing was auto-resolved or cleaned up: the conflicting branch survives,
    // and at least one worktree is left in place for the human to sort out.
    expect(await branchExists('04-b')).toBe(true);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(true);
  });

  it('is a no-op with an empty slug list', async () => {
    const result = await mergeRuns(repo, [], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual([]);
  });

  it('reports a clear failure when the merge tool is missing', async () => {
    const result = await mergeRuns(repo, ['03-a'], {
      scriptPath: join(scratch, 'does-not-exist.sh'),
    });
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });
});
