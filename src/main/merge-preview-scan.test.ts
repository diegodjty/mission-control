/**
 * Per-repo merge-preview scan orchestration (issue 108, ADR-0018).
 *
 * Proves the badge contract is PER-REPO and INDEPENDENT at the orchestration
 * seam extracted from the `AfkScan` handler: each member repo is scanned against
 * its OWN serializer key, its mid-merge suspension gate is its own, and the
 * git-floor gate is honoured — so a conflict, a mid-merge, or a below-floor git
 * in one repo never reaches into another repo's previews. Every git/coordinator
 * touch is a fake, so this exercises the same orchestration production runs. The
 * legacy⇔workbench parity for the SAME git state is asserted end-to-end against
 * real git in `merge-preview-multirepo.test.ts` (this layer is layout-agnostic:
 * project kind only picks the `scanBranches` dep's scan options).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  scanRepoWithPreviews,
  scanReposWithPreviews,
  type RepoPreviewScanDeps,
} from './merge-preview-scan';
import type { AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview, MergePreviewVerdict } from '../shared/merge-preview';
import type { PreviewReadInput } from './merge-preview-coordinator';

const REPO_A = '/repo/a';
const REPO_B = '/repo/b';

/** A finished-unmerged branch fact (a Merge candidate): committed `done`, unmerged. */
function finished(repo: string, issueId: number, slug: string): AfkBranchFacts {
  return {
    issueId,
    slug,
    hasWorktree: false,
    committedStatus: 'done',
    worktreeStatus: null,
    mergedIntoMain: false,
    repoPath: repo,
  };
}

/** Turn a coordinator read input into per-branch previews carrying a fixed verdict. */
function verdicts(input: PreviewReadInput, verdict: MergePreviewVerdict): BranchPreview[] {
  return input.candidates.map((c) => ({ issueId: c.issueId, slug: c.slug, verdict }));
}

interface FakeOpts {
  branchesByRepo: Record<string, AfkBranchFacts[]>;
  midMergeByRepo?: Record<string, boolean>;
  previewSupported?: boolean;
  /** Verdict each repo's candidates get (defaults to `clean`). */
  verdictForRepo?: (repo: string) => MergePreviewVerdict;
}

/** Build fully-instrumented fake deps so calls can be asserted. */
function fakeDeps(opts: FakeOpts): {
  deps: RepoPreviewScanDeps;
  scanBranches: ReturnType<typeof vi.fn>;
  isMidMerge: ReturnType<typeof vi.fn>;
  readStamp: ReturnType<typeof vi.fn>;
  readPreviews: ReturnType<typeof vi.fn>;
} {
  const scanBranches = vi.fn(async (repo: string) => opts.branchesByRepo[repo] ?? []);
  const isMidMerge = vi.fn(async (repo: string) => opts.midMergeByRepo?.[repo] ?? false);
  // The stamp is opaque here — the fake coordinator read ignores it — but we
  // still return a distinct per-repo value so a leaked cross-repo stamp would show.
  const readStamp = vi.fn(async (repo: string) => ({ defaultTip: `tip-${repo}`, branchTips: [] }));
  // Mirror the real coordinator: a mid-merge repo's read yields `suspended` for
  // every branch (issue 107); otherwise the per-repo verdict (default `clean`).
  const readPreviews = vi.fn((input: PreviewReadInput) =>
    verdicts(
      input,
      input.midMerge
        ? { kind: 'suspended' }
        : opts.verdictForRepo
          ? opts.verdictForRepo(input.repoPath)
          : { kind: 'clean' },
    ),
  );
  const deps: RepoPreviewScanDeps = {
    scanBranches,
    isMidMerge,
    previewSupported: opts.previewSupported ?? true,
    detectDefaultBranch: vi.fn(async () => 'main'),
    readStamp,
    readPreviews,
    serializerKeyFor: (repo) => repo, // identity key: distinct repos ⇒ distinct keys
  };
  return { deps, scanBranches, isMidMerge, readStamp, readPreviews };
}

describe('scanReposWithPreviews — per-repo independence (issue 108)', () => {
  it('computes each member repo against its OWN serializer key and candidates', async () => {
    const { deps, readPreviews } = fakeDeps({
      branchesByRepo: {
        [REPO_A]: [finished(REPO_A, 4, '04-a')],
        [REPO_B]: [finished(REPO_B, 7, '07-b'), finished(REPO_B, 9, '09-c')],
      },
    });

    const scan = await scanReposWithPreviews([REPO_A, REPO_B], deps);

    // Branches flattened across repos, sorted ascending by issue id.
    expect(scan.branches.map((b) => b.issueId)).toEqual([4, 7, 9]);
    expect(scan.previews.map((p) => p.issueId)).toEqual([4, 7, 9]);

    // One coordinator read PER REPO, each with that repo's own key + candidates.
    expect(readPreviews).toHaveBeenCalledTimes(2);
    const calls = readPreviews.mock.calls.map((c) => c[0] as PreviewReadInput);
    const keys = calls.map((c) => c.serializerKey).sort();
    expect(keys).toEqual([REPO_A, REPO_B]); // DISTINCT keys — no shared cache
    const aCall = calls.find((c) => c.serializerKey === REPO_A)!;
    const bCall = calls.find((c) => c.serializerKey === REPO_B)!;
    expect(aCall.repoPath).toBe(REPO_A);
    expect(aCall.candidates.map((c) => c.slug)).toEqual(['04-a']);
    expect(bCall.repoPath).toBe(REPO_B);
    expect(bCall.candidates.map((c) => c.slug)).toEqual(['07-b', '09-c']);
  });

  it('a conflict verdict in repo A leaves repo B’s clean verdicts untouched', async () => {
    const { deps } = fakeDeps({
      branchesByRepo: {
        [REPO_A]: [finished(REPO_A, 4, '04-a')],
        [REPO_B]: [finished(REPO_B, 7, '07-b')],
      },
      verdictForRepo: (repo) =>
        repo === REPO_A ? { kind: 'conflicts', files: ['shared.txt'] } : { kind: 'clean' },
    });

    const scan = await scanReposWithPreviews([REPO_A, REPO_B], deps);

    const byId = new Map(scan.previews.map((p) => [p.issueId, p.verdict]));
    expect(byId.get(4)).toEqual({ kind: 'conflicts', files: ['shared.txt'] });
    expect(byId.get(7)).toEqual({ kind: 'clean' }); // repo B unaffected by A's conflict
  });
});

describe('scanReposWithPreviews — per-repo mid-merge suspension (issue 108 + 107)', () => {
  it('passes each repo’s OWN mid-merge flag through; A badges suspended, B still computes', async () => {
    const { deps, readPreviews } = fakeDeps({
      branchesByRepo: {
        [REPO_A]: [finished(REPO_A, 4, '04-a')],
        [REPO_B]: [finished(REPO_B, 7, '07-b')],
      },
      midMergeByRepo: { [REPO_A]: true, [REPO_B]: false },
    });

    const scan = await scanReposWithPreviews([REPO_A, REPO_B], deps);

    // Mid-merge is per repo: A's branch badges `suspended` (issue 107), B's stays
    // `clean` — A's mid-merge never suspends B.
    const byId = new Map(scan.previews.map((p) => [p.issueId, p.verdict]));
    expect(byId.get(4)).toEqual({ kind: 'suspended' });
    expect(byId.get(7)).toEqual({ kind: 'clean' });

    // The coordinator is read for BOTH repos, each with its OWN key and its OWN
    // midMerge flag — the orchestration passes the flag through, never gates it out.
    const calls = readPreviews.mock.calls.map((c) => c[0] as PreviewReadInput);
    const aCall = calls.find((c) => c.serializerKey === REPO_A)!;
    const bCall = calls.find((c) => c.serializerKey === REPO_B)!;
    expect(aCall.midMerge).toBe(true);
    expect(bCall.midMerge).toBe(false);

    // Branches are unaffected (suspension changes badges, not rows), and the
    // aggregate mid-merge flag is raised (any repo mid-merge blocks the batch).
    expect(scan.branches.map((b) => b.issueId)).toEqual([4, 7]);
    expect(scan.midMerge).toBe(true);
  });

  it('a single mid-merge repo badges every branch suspended (one-repo Project)', async () => {
    const { deps, readPreviews } = fakeDeps({
      branchesByRepo: { [REPO_A]: [finished(REPO_A, 4, '04-a')] },
      midMergeByRepo: { [REPO_A]: true },
    });
    const scan = await scanRepoWithPreviews(REPO_A, deps);
    expect(scan.midMerge).toBe(true);
    expect(scan.previews.map((p) => p.verdict)).toEqual([{ kind: 'suspended' }]);
    expect(readPreviews).toHaveBeenCalledTimes(1);
    expect((readPreviews.mock.calls[0][0] as PreviewReadInput).midMerge).toBe(true);
  });
});

describe('scanReposWithPreviews — git-floor gate (issue 108)', () => {
  it('below the merge-tree floor: no previews anywhere, coordinator never read', async () => {
    const { deps, readPreviews } = fakeDeps({
      branchesByRepo: {
        [REPO_A]: [finished(REPO_A, 4, '04-a')],
        [REPO_B]: [finished(REPO_B, 7, '07-b')],
      },
      previewSupported: false,
    });

    const scan = await scanReposWithPreviews([REPO_A, REPO_B], deps);

    expect(scan.previews).toEqual([]);
    expect(readPreviews).not.toHaveBeenCalled();
    // Branches + mid-merge are unaffected by the floor gate — only badges vanish.
    expect(scan.branches.map((b) => b.issueId)).toEqual([4, 7]);
  });

  it('a repo with no finished-unmerged candidates reads no previews', async () => {
    // A branch already merged into main is not a candidate, so no coordinator read.
    const merged: AfkBranchFacts = { ...finished(REPO_A, 4, '04-a'), mergedIntoMain: true };
    const { deps, readPreviews } = fakeDeps({ branchesByRepo: { [REPO_A]: [merged] } });
    const scan = await scanReposWithPreviews([REPO_A], deps);
    expect(scan.previews).toEqual([]);
    expect(readPreviews).not.toHaveBeenCalled();
  });
});

describe('scanReposWithPreviews — aggregation (issue 108)', () => {
  it('OR-s mid-merge across repos and concatenates previews', async () => {
    const { deps } = fakeDeps({
      branchesByRepo: {
        [REPO_A]: [finished(REPO_A, 4, '04-a')],
        [REPO_B]: [finished(REPO_B, 2, '02-b')],
      },
      midMergeByRepo: { [REPO_A]: false, [REPO_B]: false },
    });
    const scan = await scanReposWithPreviews([REPO_A, REPO_B], deps);
    expect(scan.midMerge).toBe(false);
    // Branches sorted by issue id even though repo B's lower id came second.
    expect(scan.branches.map((b) => b.issueId)).toEqual([2, 4]);
  });
});
