/**
 * Preview coordinator (main process) — issue 104, ADR-0018.
 *
 * The per-repo verdict cache that turns the ~1.5 s scan tick's cheap stamp read
 * into a fresh-or-`recalculating` badge WITHOUT ever computing on the scan path.
 * `read` is a pure cache read plus a stamp comparison; when the stamp mismatches
 * (main or a branch tip moved, a new first branch, or a cold cache) it returns
 * `recalculating` for the first branch and queues ONE coalesced recompute per
 * repo through the SHARED per-repo serializer — never per-branch, never two
 * pending (ADR-0018 freshness).
 *
 * Serializer discipline (issue 31 + ADR-0018): the recompute runs on the same
 * key the real Merge / worktree-commit handlers use, so a background simulation
 * never races a real git mutation. Because only one preview task is ever queued
 * per repo (the `pending` guard), a real action queued afterwards waits behind at
 * most that single in-flight preview task — never a backlog of them.
 *
 * The git-floor gate lives here too: below git 2.38 (`isSupported()` false) `read`
 * always returns [] so no badges are shown; the scan handler pairs that with the
 * single passive note.
 */
import type { RepoSerializer } from '../shared/repo-serializer';
import {
  decidePreviews,
  previewNeedsRecompute,
  verdictFromSimulation,
  type BranchPreview,
  type CachedPreview,
  type MergeCandidate,
  type PreviewStamp,
  type RawSimOutcome,
} from '../shared/merge-preview';

export interface PreviewReadInput {
  /** The serializer key for this repo — MUST match the merge/commit handlers'. */
  serializerKey: string;
  /** The repo path handed to `simulate`. */
  repoPath: string;
  /** Finished-unmerged branches, ascending issue id (mergeReadinessOnDisk order). */
  candidates: MergeCandidate[];
  /** The tips the scan just observed for this repo. */
  currentStamp: PreviewStamp;
}

export interface PreviewCoordinator {
  /** True when git clears the merge-tree floor; false ⇒ `read` always returns []. */
  readonly supported: boolean;
  /**
   * Cache read + stamp check for the scan payload; queues one coalesced recompute
   * on a mismatch. Never computes a verdict itself.
   */
  read(input: PreviewReadInput): BranchPreview[];
  /** Test/inspection: is a recompute pending for this serializer key? */
  pending(serializerKey: string): boolean;
}

export interface PreviewCoordinatorDeps {
  serializer: RepoSerializer;
  /**
   * Whether git supports `merge-tree --write-tree` (probed once at backend
   * start). A thunk, so the coordinator can be built before the async probe
   * resolves and reflect it live once it does.
   */
  isSupported: () => boolean;
  /**
   * Run the actual first-branch simulation against `repoPath` for `stamp`
   * (defaultTip vs. branchTips[0]). Injected so the coordinator stays git-free
   * and unit-testable; index.ts wires the real adapter (`simulateForStamp`).
   */
  simulate: (repoPath: string, stamp: PreviewStamp) => Promise<RawSimOutcome>;
}

export function createPreviewCoordinator(deps: PreviewCoordinatorDeps): PreviewCoordinator {
  const { serializer, isSupported, simulate } = deps;
  const cache = new Map<string, CachedPreview>();
  const pending = new Set<string>();

  function read(input: PreviewReadInput): BranchPreview[] {
    if (!isSupported()) return [];
    const { serializerKey, repoPath, candidates, currentStamp } = input;
    if (candidates.length === 0) return [];
    const first = candidates[0];
    const cached = cache.get(serializerKey) ?? null;

    if (
      previewNeedsRecompute(cached, first.slug, currentStamp) &&
      !pending.has(serializerKey)
    ) {
      // Coalesce: set pending BEFORE queueing so a burst of scan ticks while this
      // recompute is in flight queues nothing extra (single-threaded, so no read
      // can slip between the check and this set).
      pending.add(serializerKey);
      // Capture the stamp/slug this recompute is FOR; store the verdict against
      // exactly them so a later tick can tell whether tips moved again.
      const stampForTask = currentStamp;
      const slugForTask = first.slug;
      void serializer
        .run(serializerKey, () => simulate(repoPath, stampForTask))
        .then((raw: RawSimOutcome) => {
          cache.set(serializerKey, {
            stamp: stampForTask,
            firstSlug: slugForTask,
            verdict: verdictFromSimulation(raw),
          });
        })
        .catch(() => {
          // A failed simulation leaves no fresh cache entry; the next scan tick,
          // still seeing a mismatch, re-queues. The badge stays `recalculating`
          // until a simulation succeeds — never a wrong verdict.
        })
        .finally(() => {
          // Re-arm the coalescer: the NEXT scan re-checks the (possibly moved)
          // stamp and queues again if still stale — ADR-0018's "stamp re-checked
          // when the task completes".
          pending.delete(serializerKey);
        });
    }

    return decidePreviews({ candidates, currentStamp, cached });
  }

  return {
    get supported(): boolean {
      return isSupported();
    },
    read,
    pending: (key: string) => pending.has(key),
  };
}
