/**
 * Integration check for the merge-preview simulation adapter (issue 104,
 * ADR-0018). Drives REAL git against throwaway temp repos with real `afk/`
 * branches — never the real project. It proves the two outcomes the badge rests
 * on (clean vs. conflict-with-files) AND the ADR-0018 invariant that a preview
 * touches NO refs, NO worktree, and NO index (dangling odb objects allowed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchFor } from '../shared/isolation-policy';
import {
  probeMergeTreeSupport,
  readPreviewStamp,
  simulateFirstMerge,
  simulateForStamp,
} from './merge-preview-adapter';
import type { MergeCandidate } from '../shared/merge-preview';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

const FIRST = '04-first';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Snapshot the repo state a preview must NOT change. */
async function snapshot(): Promise<{ refs: string; head: string; worktrees: string; status: string }> {
  return {
    refs: await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: (await git(repo, 'rev-parse', 'HEAD')).trim(),
    worktrees: await git(repo, 'worktree', 'list', '--porcelain'),
    status: await git(repo, 'status', '--porcelain'),
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-preview-'));
  repo = join(scratch, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'shared.txt'), 'line1\nline2\nline3\n');
  await writeFile(join(repo, 'other.txt'), 'other\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Create the finished `afk/04-first` branch with the given edits, back on main. */
async function makeFirstBranch(edit: () => Promise<void>): Promise<void> {
  await git(repo, 'checkout', '-b', branchFor(FIRST));
  await edit();
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'branch work');
  await git(repo, 'checkout', 'main');
}

describe('probeMergeTreeSupport', () => {
  it('reports true on this machine (git ≥ 2.38 required to run these tests)', async () => {
    expect(await probeMergeTreeSupport()).toBe(true);
  });
});

describe('simulateFirstMerge — clean vs. conflict (issue 104)', () => {
  it('reports a clean merge when the branch does not touch what main changed', async () => {
    await makeFirstBranch(async () => {
      await writeFile(join(repo, 'newfile.txt'), 'brand new\n');
    });
    // main moves on a DIFFERENT file, so the merge is clean.
    await writeFile(join(repo, 'other.txt'), 'other changed on main\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main moves other.txt');

    const candidates: MergeCandidate[] = [{ issueId: 4, slug: FIRST }];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    expect(await simulateForStamp(repo, stamp)).toEqual({ kind: 'clean' });
  });

  it('reports a conflict and names the conflicting file when both sides edit the same lines', async () => {
    await makeFirstBranch(async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBRANCH\nline3\n');
    });
    // main edits the SAME line differently → a real conflict at merge time.
    await writeFile(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main edits shared.txt');

    const candidates: MergeCandidate[] = [{ issueId: 4, slug: FIRST }];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    const outcome = await simulateForStamp(repo, stamp);
    expect(outcome).toEqual({ kind: 'conflict', files: ['shared.txt'] });
  });

  it('the stamp reflects a moved default tip after a commit to main (drives the recalculating flip)', async () => {
    await makeFirstBranch(async () => {
      await writeFile(join(repo, 'newfile.txt'), 'brand new\n');
    });
    const candidates: MergeCandidate[] = [{ issueId: 4, slug: FIRST }];
    const before = await readPreviewStamp(repo, 'main', candidates);
    // A hand commit on main — the exact event acceptance #2 describes.
    await writeFile(join(repo, 'other.txt'), 'committed by hand\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'hand commit on main');
    const after = await readPreviewStamp(repo, 'main', candidates);
    expect(after.defaultTip).not.toBe(before.defaultTip); // → stamp mismatch → recalculating
    expect(after.branchTips).toEqual(before.branchTips); // the branch itself did not move
  });

  it('accepts raw tips (OIDs) so the verdict is reproducible even if refs move later', async () => {
    await makeFirstBranch(async () => {
      await writeFile(join(repo, 'newfile.txt'), 'brand new\n');
    });
    const defaultTip = (await git(repo, 'rev-parse', 'main')).trim();
    const branchTip = (await git(repo, 'rev-parse', branchFor(FIRST))).trim();
    expect(await simulateFirstMerge(repo, defaultTip, branchTip)).toEqual({ kind: 'clean' });
  });
});

describe('the ADR-0018 read-only invariant (issue 104)', () => {
  it('moves no ref, creates no worktree, and leaves the index untouched', async () => {
    // A conflicting branch — the case that exercises the most merge-tree work.
    await makeFirstBranch(async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBRANCH\nline3\n');
    });
    await writeFile(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main edits shared.txt');

    const before = await snapshot();
    const candidates: MergeCandidate[] = [{ issueId: 4, slug: FIRST }];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    await simulateForStamp(repo, stamp);
    // Run it a second time — still no accumulation of side effects.
    await simulateForStamp(repo, stamp);
    const after = await snapshot();

    expect(after.refs).toBe(before.refs); // no ref moved (no new branch/tag/note)
    expect(after.head).toBe(before.head); // HEAD unchanged
    expect(after.worktrees).toBe(before.worktrees); // no worktree created
    expect(after.status.trim()).toBe(''); // index/working tree clean (untouched)
  });
});
