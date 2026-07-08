/**
 * Preview coordinator (main process) — issues 104 & 105, ADR-0018.
 *
 * The per-repo verdict cache that turns the ~1.5 s scan tick's cheap stamp read
 * into fresh-or-`recalculating` badges WITHOUT ever computing on the scan path.
 * `read` is a pure cache read plus a batch+stamp comparison; when it mismatches
 * (the default tip or any branch tip moved, or the finished-branch set itself
 * changed — a new branch, a discard, a re-run) it returns `recalculating` for
 * EVERY branch and queues ONE coalesced recompute per repo through the SHARED
 * per-repo serializer — never per-branch, never two pending (ADR-0018 freshness).
 * The recompute simulates the whole sequence (issue 105), so a conflict on an
 * early branch correctly reshuffles every downstream `blocked behind NN`.
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
 *
 * Mid-merge suspension (issue 107, ADR-0018): when the scan reports the repo
 * mid-merge, `read` short-circuits to a `suspended` "merge in progress" verdict
 * for every branch and queues NO recompute — a mid-merge repo can't be
 * Merge-pressed, so any verdict would predict a press that cannot happen. The
 * cache is left untouched; the stamp mismatch resumes previews on the first clean
 * tick after the human resolves-and-commits or Aborts (main's tip moves).
 */
import type { RepoSerializer } from '../shared/repo-serializer';
import {
  decidePreviews,
  previewNeedsRecompute,
  type BranchPreview,
  type CachedPreview,
  type MergeCandidate,
  type PreviewStamp,
  type SequenceSimOutcome,
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
  /**
   * The repo is mid-merge (issue 24 scan fact). When true, `read` suspends every
   * branch ("merge in progress") and queues NO recompute (issue 107, ADR-0018).
   * Omitted ⇒ not mid-merge, the normal cache/stamp path runs.
   */
  midMerge?: boolean;
}

export interface PreviewCoordinator {
  /** True when git clears the merge-tree floor; false ⇒ `read` always returns []. */
  readonly supported: boolean;
  /**
   * Cache read + batch/stamp check for the scan payload; queues one coalesced
   * recompute on a mismatch. Never computes a verdict itself.
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
   * Run the actual SEQUENCE simulation against `repoPath` for `stamp` (fold the
   * ordered branch tips into the default tip, stopping at the first conflict).
   * Injected so the coordinator stays git-free and unit-testable; index.ts wires
   * the real adapter (`simulateSequence`).
   */
  simulate: (repoPath: string, stamp: PreviewStamp) => Promise<SequenceSimOutcome>;
}

export function createPreviewCoordinator(deps: PreviewCoordinatorDeps): PreviewCoordinator {
  const { serializer, isSupported, simulate } = deps;
  const cache = new Map<string, CachedPreview>();
  const pending = new Set<string>();

  function read(input: PreviewReadInput): BranchPreview[] {
    if (!isSupported()) return [];
    const { serializerKey, repoPath, candidates, currentStamp, midMerge = false } = input;
    if (candidates.length === 0) return [];
    // Mid-merge (issue 107, ADR-0018): suspend every branch and queue NOTHING — a
    // verdict would predict a Merge press that can't happen. Return before the
    // recompute check so no task is enqueued and the cache is left as-is; the
    // stamp mismatch re-arms recompute once the mid-merge clears.
    if (midMerge) {
      return decidePreviews({ candidates, currentStamp, cached: null, midMerge: true });
    }
    const slugs = candidates.map((c) => c.slug);
    const cached = cache.get(serializerKey) ?? null;

    if (
      previewNeedsRecompute(cached, slugs, currentStamp) &&
      !pending.has(serializerKey)
    ) {
      // Coalesce: set pending BEFORE queueing so a burst of scan ticks while this
      // recompute is in flight queues nothing extra (single-threaded, so no read
      // can slip between the check and this set).
      pending.add(serializerKey);
      // Capture the batch/stamp this recompute is FOR; store the sequence against
      // exactly them so a later tick can tell whether anything moved again.
      const stampForTask = currentStamp;
      const slugsForTask = slugs;
      void serializer
        .run(serializerKey, () => simulate(repoPath, stampForTask))
        .then((outcome: SequenceSimOutcome) => {
          cache.set(serializerKey, {
            stamp: stampForTask,
            slugs: slugsForTask,
            outcome,
          });
        })
        .catch(() => {
          // A failed simulation leaves no fresh cache entry; the next scan tick,
          // still seeing a mismatch, re-queues. The badges stay `recalculating`
          // until a simulation succeeds — never a wrong verdict.
        })
        .finally(() => {
          // Re-arm the coalescer: the NEXT scan re-checks the (possibly moved)
          // stamp/batch and queues again if still stale — ADR-0018's "stamp
          // re-checked when the task completes".
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
