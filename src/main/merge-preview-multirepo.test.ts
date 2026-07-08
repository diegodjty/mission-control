/**
 * Multi-repo & legacy-layout preview parity (issue 108, ADR-0018) — the
 * end-to-end proof, driving REAL git against throwaway temp repos through the
 * REAL stack (`scanAfkBranches` → `scanReposWithPreviews` → `createPreviewCoordinator`
 * with the real `simulateSequence` on a shared `createRepoSerializer`). It proves:
 *
 *   - a two-repo workbench Project with finished branches in BOTH repos shows
 *     independent, correct SEQUENCES per repo (AC1);
 *   - a conflict verdict in repo A leaves repo B's `clean` verdicts untouched
 *     (AC2) — the two repos never share a cache;
 *   - the LEGACY in-repo `issues/` layout produces IDENTICAL badges for the same
 *     git state as a single-repo workbench Project (AC4) — asserted, not assumed.
 *
 * Per-repo coalescing (one recompute each, parallel on distinct keys) and the
 * mid-merge suspension gate are asserted at their own layers
 * (merge-preview-coordinator.test.ts / merge-preview-scan.test.ts); this file is
 * the real-git behavioural spine those unit layers stand in for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchFor } from '../shared/isolation-policy';
import { createRepoSerializer } from '../shared/repo-serializer';
import { createPreviewCoordinator } from './merge-preview-coordinator';
import { probeMergeTreeSupport, readPreviewStamp, simulateSequence } from './merge-preview-adapter';
import {
  scanAfkBranches,
  isMidMerge,
  detectDefaultBranch,
} from './git-worktree-adapter';
import { scanReposWithPreviews, type RepoPreviewScanDeps } from './merge-preview-scan';
import type { AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview } from '../shared/merge-preview';

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Initialise a fresh git repo at `dir` with a `main` branch and a base commit. */
async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'MC Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'shared.txt'), 'line1\nline2\nline3\n');
  await mkdir(join(dir, 'issues'), { recursive: true });
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
}

/** An issue file body with the given status (what both layouts read as `done`). */
function issueFile(slug: string, status: string): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# ${slug}\n`;
}

/**
 * Create a finished `afk/<slug>` branch off CURRENT main: apply `edit`, commit the
 * issue file as `done` (so the LEGACY committed-status read sees it finished), and
 * return to main. The same commit makes the branch a candidate under BOTH layouts.
 */
async function makeFinishedBranch(
  repo: string,
  slug: string,
  edit: () => Promise<void>,
): Promise<void> {
  await git(repo, 'checkout', '-b', branchFor(slug), 'main');
  await edit();
  // Git doesn't track empty dirs, so `issues/` can vanish on checkout — recreate it.
  await mkdir(join(repo, 'issues'), { recursive: true });
  await writeFile(join(repo, 'issues', `${slug}.md`), issueFile(slug, 'done'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', `finish ${slug}`);
  await git(repo, 'checkout', 'main');
}

/** The real per-repo scan deps for a given layout (legacy: no issues root). */
function realDeps(workbenchIssuesRoot: string | null): RepoPreviewScanDeps {
  const serializer = createRepoSerializer();
  const coordinator = createPreviewCoordinator({
    serializer,
    isSupported: () => true,
    simulate: (repoPath, stamp) => simulateSequence(repoPath, stamp),
  });
  const scanOpts = workbenchIssuesRoot !== null ? { workbenchIssuesRoot } : {};
  return {
    scanBranches: async (repo) =>
      (await scanAfkBranches(repo, scanOpts)).map((b): AfkBranchFacts => ({ ...b, repoPath: repo })),
    isMidMerge,
    previewSupported: true,
    detectDefaultBranch,
    readStamp: readPreviewStamp,
    readPreviews: (input) => coordinator.read(input),
    serializerKeyFor: (repo) => repo,
  };
}

/** Run the scan until every preview has SETTLED (no `recalculating` left). */
async function settledPreviews(repos: string[], deps: RepoPreviewScanDeps): Promise<BranchPreview[]> {
  for (let i = 0; i < 300; i++) {
    const scan = await scanReposWithPreviews(repos, deps);
    const settled =
      scan.previews.length > 0 && scan.previews.every((p) => p.verdict?.kind !== 'recalculating');
    if (settled) return scan.previews;
    await sleep(15);
  }
  throw new Error('previews did not settle within the timeout');
}

/** Compact (issueId → verdict-kind[+detail]) view for stable comparisons. */
function verdictShape(previews: BranchPreview[]): Record<number, unknown> {
  const out: Record<number, unknown> = {};
  for (const p of previews) out[p.issueId] = p.verdict;
  return out;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-multirepo-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('probe (git ≥ 2.38 required for these tests)', () => {
  it('supports merge-tree on this machine', async () => {
    expect(await probeMergeTreeSupport()).toBe(true);
  });
});

describe('two-repo workbench Project — independent, correct sequences per repo (issue 108)', () => {
  it('repo A (sequential conflict) and repo B (clean chain) each badge their OWN sequence', async () => {
    const repoA = join(scratch, 'repo-a');
    const repoB = join(scratch, 'repo-b');
    await initRepo(repoA);
    await initRepo(repoB);

    // Repo A: the pairwise-wrong case — 04 and 07 edit the SAME line of shared.txt
    // differently. 04 merges clean onto main, then 07 conflicts with 04 in sequence.
    await makeFinishedBranch(repoA, '04-a', async () => {
      await writeFile(join(repoA, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeFinishedBranch(repoA, '07-b', async () => {
      await writeFile(join(repoA, 'shared.txt'), 'line1\nBBB\nline3\n');
    });

    // Repo B: 11 and 13 touch disjoint new files — a fully clean chain.
    await makeFinishedBranch(repoB, '11-c', async () => {
      await writeFile(join(repoB, 'c.txt'), 'from c\n');
    });
    await makeFinishedBranch(repoB, '13-d', async () => {
      await writeFile(join(repoB, 'd.txt'), 'from d\n');
    });

    const deps = realDeps(null); // single shared coordinator across BOTH repos
    const previews = await settledPreviews([repoA, repoB], deps);

    // Each repo's sequence is computed against its OWN base — no cross-contamination.
    expect(verdictShape(previews)).toEqual({
      4: { kind: 'clean' }, // repo A: 04 merges clean first
      7: { kind: 'conflicts', files: ['shared.txt'] }, // repo A: 07 conflicts with 04
      11: { kind: 'clean' }, // repo B: independent clean chain
      13: { kind: 'clean' },
    });
  }, 20000);

  it('a conflict in repo A leaves repo B’s clean verdicts untouched (AC2)', async () => {
    const repoA = join(scratch, 'repo-a');
    const repoB = join(scratch, 'repo-b');
    await initRepo(repoA);
    await initRepo(repoB);

    // Repo A: 04 conflicts against main directly (main also moved shared.txt), so
    // the FIRST branch is a conflict and 07 is blocked behind it.
    await makeFinishedBranch(repoA, '04-a', async () => {
      await writeFile(join(repoA, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeFinishedBranch(repoA, '07-b', async () => {
      await writeFile(join(repoA, 'other.txt'), 'from b\n');
    });
    await writeFile(join(repoA, 'shared.txt'), 'line1\nMAIN\nline3\n');
    await git(repoA, 'add', '.');
    await git(repoA, 'commit', '-m', 'main moves shared.txt');

    // Repo B: a clean chain, wholly independent of repo A.
    await makeFinishedBranch(repoB, '11-c', async () => {
      await writeFile(join(repoB, 'c.txt'), 'from c\n');
    });
    await makeFinishedBranch(repoB, '13-d', async () => {
      await writeFile(join(repoB, 'd.txt'), 'from d\n');
    });

    const previews = await settledPreviews([repoA, repoB], realDeps(null));
    expect(verdictShape(previews)).toEqual({
      4: { kind: 'conflicts', files: ['shared.txt'] }, // repo A: first-branch conflict
      7: { kind: 'blocked', behindIssueId: 4 }, // repo A: blocked behind 04
      11: { kind: 'clean' }, // repo B: STILL clean — A's conflict never reached it
      13: { kind: 'clean' },
    });
  }, 20000);
});

describe('legacy in-repo layout ≡ workbench Project — identical badges for the same git state (issue 108, AC4)', () => {
  it('the same repo scanned as legacy and as a single-repo workbench Project badges identically', async () => {
    const repo = join(scratch, 'repo');
    await initRepo(repo);

    // A mixed batch that exercises the full contract: 04 merges clean first, then
    // 07 collides with 04's edit to the same shared.txt line (the sequential case),
    // so the run stops and 09 is blocked behind 07. All three edit shared.txt so
    // the sequence — not pairwise-against-main — is what decides the verdicts.
    await makeFinishedBranch(repo, '04-a', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nAAA\nline3\n');
    });
    await makeFinishedBranch(repo, '07-b', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nBBB\nline3\n');
    });
    await makeFinishedBranch(repo, '09-c', async () => {
      await writeFile(join(repo, 'shared.txt'), 'line1\nCCC\nline3\n');
    });

    // The workbench claim surface: the SAME statuses (`done`) the branches carry
    // in-repo, so both layouts see the SAME finished-unmerged candidate set.
    const workbenchIssuesRoot = join(scratch, 'workbench-issues');
    await mkdir(workbenchIssuesRoot, { recursive: true });
    for (const slug of ['04-a', '07-b', '09-c']) {
      await writeFile(join(workbenchIssuesRoot, `${slug}.md`), issueFile(slug, 'done'));
    }

    // FRESH coordinators for each layout, so each computes from COLD — a shared
    // cache would make "identical" trivially true and prove nothing.
    const legacyPreviews = await settledPreviews([repo], realDeps(null));
    const workbenchPreviews = await settledPreviews([repo], realDeps(workbenchIssuesRoot));

    // Same git state ⇒ same candidates ⇒ same badges. The badge contract does NOT
    // fork by Project kind (PRD story 18).
    expect(verdictShape(workbenchPreviews)).toEqual(verdictShape(legacyPreviews));
    // And the shape is the real one the batch produces (07 conflicts with 04's
    // sibling on shared.txt in sequence, 09 blocked behind 07).
    expect(verdictShape(legacyPreviews)).toEqual({
      4: { kind: 'clean' },
      7: { kind: 'conflicts', files: ['shared.txt'] },
      9: { kind: 'blocked', behindIssueId: 7 },
    });
  }, 20000);
});
