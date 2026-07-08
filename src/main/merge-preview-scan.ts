/**
 * Per-repo merge-preview scan orchestration (main process) — issue 108, ADR-0018.
 *
 * A workbench Project spans zero-or-more member repos and the afk scan already
 * reads branches from ALL of them (issue 72). This module is the seam that makes
 * previews **per-repo and independent**: it drives the branch scan, the mid-merge
 * suspension gate, the freshness stamp, and the coordinator cache read ONCE PER
 * REPO, keyed on that repo's serializer key — so a conflict (or a mid-merge, or a
 * git-floor gap) in repo A never touches repo B's badges. Each repo gets its own
 * coordinator cache entry, its own stamp, its own merge sequence, and its own
 * suspension state.
 *
 * It was extracted from the `AfkScan` IPC handler in `index.ts` precisely so the
 * per-repo independence, the per-repo mid-merge suspension, and the legacy⇔
 * workbench parity (issue 108's acceptance criteria) are asserted BY TEST rather
 * than buried in an Electron handler: every git/coordinator touch is a `deps`
 * function, so the orchestration is exercised with fakes and the behaviour is the
 * same one production runs. The badge contract deliberately does NOT fork by
 * Project kind — the legacy in-repo `issues/` layout is just a single-repo scan
 * through this same code, so its badges match a single-repo workbench Project's
 * for the same git state.
 *
 * Nothing here computes a verdict: `readPreviews` is a pure cache read against the
 * per-repo coordinator (which, on a stamp/batch mismatch, queues one coalesced
 * recompute through the SHARED per-repo serializer). Each repo's own `midMerge`
 * flag is passed straight through to its `readPreviews` call: a mid-merge repo
 * (issue 107) gets every branch badged `suspended` ("merge in progress") and no
 * recompute queued — a verdict would predict a press that can't happen — while
 * every other repo computes normally against its own cache. A below-floor git
 * (no `merge-tree`) yields no previews at all (`previewSupported` false).
 */
import { mergeReadinessOnDisk, type AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview, MergeCandidate, PreviewStamp } from '../shared/merge-preview';
import type { PreviewReadInput } from './merge-preview-coordinator';

/** One member repo's scan facts: its branches, its mid-merge flag, its previews. */
export interface RepoScanResult {
  branches: AfkBranchFacts[];
  midMerge: boolean;
  previews: BranchPreview[];
}

/** The whole Project's scan: branches/previews flattened across member repos. */
export interface ReposScanResult {
  /** Every member repo's branches, flattened and sorted ascending by issue id. */
  branches: AfkBranchFacts[];
  /** True when ANY member repo is left mid-merge (blocks a new drain/Run). */
  midMerge: boolean;
  /** Every member repo's per-branch preview verdicts, flattened. */
  previews: BranchPreview[];
}

/**
 * The git/coordinator touches the orchestration needs, injected so it stays
 * Electron-free and unit-testable. In production `index.ts` wires the real
 * adapter (`scanAfkBranches` with the layout's `scanOpts`, `isMidMerge`,
 * `detectDefaultBranch`, `readPreviewStamp`) and the shared `previewCoordinator`.
 */
export interface RepoPreviewScanDeps {
  /**
   * Scan one repo's `afk/` branches, already tagged with `repoPath`. The caller
   * bakes in the layout-aware scan options (a workbench Project passes its
   * `workbenchIssuesRoot`; legacy passes none) — this module is layout-agnostic,
   * which is exactly why legacy and workbench produce identical badges.
   */
  scanBranches: (repo: string) => Promise<AfkBranchFacts[]>;
  /**
   * Is this repo left MID-MERGE? The flag is passed through to `readPreviews`, so
   * a mid-merge repo's branches badge `suspended` (issue 107, ADR-0018).
   */
  isMidMerge: (repo: string) => Promise<boolean>;
  /** True once git clears the `merge-tree` floor (≥2.38); false ⇒ no badges. */
  previewSupported: boolean;
  /** Resolve this repo's default/integration branch (the sequence's base). */
  detectDefaultBranch: (repo: string) => Promise<string>;
  /** Read the cheap freshness stamp (default tip + ordered finished-branch tips). */
  readStamp: (
    repo: string,
    defaultBranch: string,
    candidates: MergeCandidate[],
  ) => Promise<PreviewStamp>;
  /** Cache read against the per-repo coordinator — NEVER computes a verdict. */
  readPreviews: (input: PreviewReadInput) => BranchPreview[];
  /**
   * The serializer key for a repo — MUST equal the key the real Merge / worktree-
   * commit handlers use for that repo, and IS the coordinator's per-repo cache
   * key. Distinct repos ⇒ distinct keys ⇒ independent caches + parallel
   * recomputes.
   */
  serializerKeyFor: (repo: string) => string;
}

/**
 * Scan ONE member repo and read its previews (issue 108). Mirrors the handler's
 * per-repo body exactly: scan branches, read the mid-merge flag, and — when
 * previews are supported and the repo has at least one finished-unmerged
 * candidate — read the coordinator against this repo's own serializer key,
 * passing this repo's own `midMerge` flag. The coordinator suspends every branch
 * (`suspended` — issue 107) when `midMerge` is set and queues no recompute;
 * otherwise it returns the fresh-or-`recalculating` sequence verdicts. Below the
 * git floor, or with no candidates, yields `previews: []` for THIS repo alone; it
 * never reaches into another repo's cache.
 */
export async function scanRepoWithPreviews(
  repo: string,
  deps: RepoPreviewScanDeps,
): Promise<RepoScanResult> {
  const branches = await deps.scanBranches(repo);
  // Report whether this repo is left mid-merge by a partial conflict (issue 24)
  // so the renderer can block a new drain/Run and offer Abort — and, passed to
  // the coordinator below, suspend this repo's badges (issue 107).
  const midMerge = await deps.isMidMerge(repo);
  let previews: BranchPreview[] = [];
  if (deps.previewSupported) {
    const candidates = mergeReadinessOnDisk(branches).mergeable;
    if (candidates.length > 0) {
      const defaultBranch = await deps.detectDefaultBranch(repo);
      const currentStamp = await deps.readStamp(repo, defaultBranch, candidates);
      previews = deps.readPreviews({
        serializerKey: deps.serializerKeyFor(repo),
        repoPath: repo,
        candidates,
        currentStamp,
        midMerge,
      });
    }
  }
  return { branches, midMerge, previews };
}

/**
 * Scan EVERY member repo independently and aggregate (issue 108). The repos run
 * concurrently (distinct serializer keys never contend), each computing its own
 * branches/mid-merge/previews via `scanRepoWithPreviews`; the results are then
 * flattened — branches sorted ascending by issue id (a stable Map order),
 * mid-merge OR-ed (any repo mid-merge blocks the batch), previews concatenated.
 * A single-repo Project (a legacy in-repo `issues/` layout, or a one-repo
 * workbench Project) is just the one-element case — same code, so its badges are
 * identical for the same git state.
 */
export async function scanReposWithPreviews(
  repos: string[],
  deps: RepoPreviewScanDeps,
): Promise<ReposScanResult> {
  const perRepo = await Promise.all(repos.map((repo) => scanRepoWithPreviews(repo, deps)));
  return {
    branches: perRepo.flatMap((r) => r.branches).sort((a, b) => a.issueId - b.issueId),
    midMerge: perRepo.some((r) => r.midMerge),
    previews: perRepo.flatMap((r) => r.previews),
  };
}
