/**
 * Integration check for the merge-preview simulation adapter (issues 104 & 105,
 * ADR-0018). Drives REAL git against throwaway temp repos with real `afk/`
 * branches — never the real project. It proves:
 *   - the single-step outcomes the tracer rests on (clean vs. conflict-with-files);
 *   - the SEQUENTIAL simulation (issue 105): a clean chain, the pairwise-wrong
 *     case (B conflicts with A's changes but not with main), the stop-at-first-
 *     conflict (no branches simulated past it);
 *   - the ADR-0018 invariant that a chained preview touches NO refs, NO worktree,
 *     and NO index (dangling odb objects allowed).
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
  simulateSequence,
} from './merge-preview-adapter';
import { sequenceVerdicts } from '../shared/merge-preview';
import type { MergeCandidate } from '../shared/merge-preview';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

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

/** Create a finished `afk/<slug>` branch off the CURRENT main, with the given edits. */
async function makeBranch(slug: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, 'checkout', '-b', branchFor(slug), 'main');
  await edit();
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', `work on ${slug}`);
  await git(repo, 'checkout', 'main');
}

describe('probeMergeTreeSupport', () => {
  it('reports true on this machine (git ≥ 2.38 required to run these tests)', async () => {
    expect(await probeMergeTreeSupport()).toBe(true);
  });
});

describe('simulateFirstMerge — the single-step primitive (issue 104)', () => {
  it('reports a clean merge when the branch does not touch what main changed', async () => {
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'newfile.txt'), 'brand new\n');
    });
    await writeFile(join(repo, 'other.txt'), 'other changed on main\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main moves other.txt');

    const defaultTip = (await git(repo, 'rev-parse', 'main')).trim();
    const branchTip = (await git(repo, 'rev-parse', branchFor('04-a'))).trim();
    expect(await simulateFirstMerge(repo, defaultTip, branchTip)).toEqual({ kind: 'clean' });
  });

  it('reports a conflict and names the file when both sides edit the same lines', async () => {
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBRANCH\nline3\n');
    });
    await writeFile(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main edits shared.txt');

    const defaultTip = (await git(repo, 'rev-parse', 'main')).trim();
    const branchTip = (await git(repo, 'rev-parse', branchFor('04-a'))).trim();
    expect(await simulateFirstMerge(repo, defaultTip, branchTip)).toEqual({
      kind: 'conflict',
      files: ['shared.txt'],
    });
  });
});

describe('readPreviewStamp — the freshness read', () => {
  it('reflects a moved default tip after a hand commit to main (drives the recalculating flip)', async () => {
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'newfile.txt'), 'brand new\n');
    });
    const candidates: MergeCandidate[] = [{ issueId: 4, slug: '04-a' }];
    const before = await readPreviewStamp(repo, 'main', candidates);
    await writeFile(join(repo, 'other.txt'), 'committed by hand\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'hand commit on main');
    const after = await readPreviewStamp(repo, 'main', candidates);
    expect(after.defaultTip).not.toBe(before.defaultTip);
    expect(after.branchTips).toEqual(before.branchTips);
  });
});

describe('simulateSequence — the sequential simulation (issue 105)', () => {
  it('a clean batch of 3 disjoint branches → every step clean', async () => {
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'a.txt'), 'from a\n');
    });
    await makeBranch('07-b', async () => {
      await writeFile(join(repo, 'b.txt'), 'from b\n');
    });
    await makeBranch('09-c', async () => {
      await writeFile(join(repo, 'c.txt'), 'from c\n');
    });

    const candidates: MergeCandidate[] = [
      { issueId: 4, slug: '04-a' },
      { issueId: 7, slug: '07-b' },
      { issueId: 9, slug: '09-c' },
    ];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    const outcome = await simulateSequence(repo, stamp);
    expect(outcome.steps).toEqual([{ kind: 'clean' }, { kind: 'clean' }, { kind: 'clean' }]);
    expect(sequenceVerdicts(candidates, outcome)).toEqual([
      { kind: 'clean' },
      { kind: 'clean' },
      { kind: 'clean' },
    ]);
  });

  it('the PAIRWISE-WRONG case: B conflicts with A but not with main → B badges conflicts', async () => {
    // Both A and B edit the SAME line of shared.txt, differently. main stays at
    // base, so EACH branch merges cleanly PAIRWISE-against-main. But in sequence,
    // A lands first and B then collides with A's line — the case that motivates
    // sequential simulation (a pairwise preview would wrongly badge B "clean").
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeBranch('07-b', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBBB\nline3\n');
    });

    const candidates: MergeCandidate[] = [
      { issueId: 4, slug: '04-a' },
      { issueId: 7, slug: '07-b' },
    ];

    // Sanity: pairwise-against-main, B alone is CLEAN — the false "no surprise".
    const defaultTip = (await git(repo, 'rev-parse', 'main')).trim();
    const bTip = (await git(repo, 'rev-parse', branchFor('07-b'))).trim();
    expect(await simulateFirstMerge(repo, defaultTip, bTip)).toEqual({ kind: 'clean' });

    // Sequentially, B conflicts (on shared.txt) after A merges.
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    const outcome = await simulateSequence(repo, stamp);
    expect(outcome.steps[0]).toEqual({ kind: 'clean' }); // A merges clean first
    expect(outcome.steps[1]).toEqual({ kind: 'conflict', files: ['shared.txt'] });
    expect(sequenceVerdicts(candidates, outcome)).toEqual([
      { kind: 'clean' },
      { kind: 'conflicts', files: ['shared.txt'] },
    ]);
  });

  it('stops at the first conflict: later branches are NOT simulated (no speculative verdicts)', async () => {
    // A clean, B conflicts (with A) on shared.txt, C touches a disjoint file.
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeBranch('07-b', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBBB\nline3\n');
    });
    await makeBranch('09-c', async () => {
      await writeFile(join(repo, 'c.txt'), 'from c\n');
    });

    const candidates: MergeCandidate[] = [
      { issueId: 4, slug: '04-a' },
      { issueId: 7, slug: '07-b' },
      { issueId: 9, slug: '09-c' },
    ];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    const outcome = await simulateSequence(repo, stamp);
    // Only TWO steps: A (clean) and B (conflict). C is past the stop → not run.
    expect(outcome.steps).toHaveLength(2);
    expect(sequenceVerdicts(candidates, outcome)).toEqual([
      { kind: 'clean' },
      { kind: 'conflicts', files: ['shared.txt'] },
      { kind: 'blocked', behindIssueId: 7 }, // C blocked behind B
    ]);
  });

  it('conflict on the FIRST branch → everything after it blocked behind it', async () => {
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeBranch('07-b', async () => {
      await writeFile(join(repo, 'b.txt'), 'from b\n');
    });
    // main also edits the SAME line A touched → A conflicts against main first.
    await writeFile(join(repo, 'shared.txt'), 'line1\nMAIN\nline3\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'main edits shared.txt');

    const candidates: MergeCandidate[] = [
      { issueId: 4, slug: '04-a' },
      { issueId: 7, slug: '07-b' },
    ];
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    const outcome = await simulateSequence(repo, stamp);
    expect(outcome.steps).toHaveLength(1); // stops immediately
    expect(sequenceVerdicts(candidates, outcome)).toEqual([
      { kind: 'conflicts', files: ['shared.txt'] },
      { kind: 'blocked', behindIssueId: 4 },
    ]);
  });
});

describe('the ADR-0018 read-only invariant after CHAINED simulation (issue 105)', () => {
  it('moves no ref, creates no worktree, and leaves the index untouched — even with commit-tree chaining', async () => {
    // A clean → chains a synthesized commit; B conflicts → the most plumbing the
    // sequence exercises (merge-tree + commit-tree + merge-tree).
    await makeBranch('04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeBranch('07-b', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBBB\nline3\n');
    });
    await makeBranch('09-c', async () => {
      await writeFile(join(repo, 'c.txt'), 'from c\n');
    });

    const candidates: MergeCandidate[] = [
      { issueId: 4, slug: '04-a' },
      { issueId: 7, slug: '07-b' },
      { issueId: 9, slug: '09-c' },
    ];
    const before = await snapshot();
    const stamp = await readPreviewStamp(repo, 'main', candidates);
    await simulateSequence(repo, stamp);
    // Run it again — still no accumulation of side effects (idempotent objects).
    await simulateSequence(repo, stamp);
    const after = await snapshot();

    expect(after.refs).toBe(before.refs); // no ref moved (no new branch/tag/note)
    expect(after.head).toBe(before.head); // HEAD unchanged
    expect(after.worktrees).toBe(before.worktrees); // no worktree created
    expect(after.status.trim()).toBe(''); // index/working tree clean (untouched)
  });
});
