import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decideDispatcherMerge } from '../../../shared/merge-classification';
import { decideAutoMergeLane, laneBranchesFrom } from '../../../shared/auto-merge-lane';
import { decideMergeAffordance, type MergeAffordance } from '../../../shared/merge-affordance';
import { mergeReadinessOnDisk } from '../../../shared/worktree-scan';
import type { ActiveScanView } from '../../../shared/project-switch';
import {
  mergeResultDisplay,
  pendingMergeDisplay,
  emptyMergeDisplay,
  mergeThrewDisplay,
  type MergeDisplay,
} from '../../../shared/merge-display';
import type { RunLogRecord } from '../../../shared/ipc-contract';
import type { RunStatus } from '../../../shared/run-state';
import type { DispatcherAction } from '../../../shared/action-authority';
import { protectedLandWarning } from './appHelpers';
import type { TrackedRun } from './appTypes';

/** What confirming a protected-branch merge land would re-execute. */
export interface ProtectedMergeLandTarget {
  kind: 'merge';
  slugs: string[];
  auto: boolean;
}

export interface MergeLaneDeps {
  projectPath: string | null;
  activeScan: ActiveScanView;
  runLog: RunLogRecord[];
  liveRunIssueIds: number[];
  runs: TrackedRun[];
  runStatusOf: (run: TrackedRun) => RunStatus;
  isIsolated: (run: TrackedRun) => boolean;
  logNote: (id: string, action: DispatcherAction, label: string) => void;
  /**
   * The one shared-write seam (this issue's hard part): a successful merge
   * drops the merged branches from the on-disk scan and clears the merged
   * ids' run-tracking bookkeeping (`runs`, `worktreeCommitErrors`, the
   * committed-worktree marker) — all owned by the caller, not this hook.
   */
  onMergeCompleted: (mergedIds: Set<number>, mergedSlugs: string[]) => void;
  /** Records what confirming a protected-branch land would re-execute — the
   * record itself is shared with the solo-commit path, so the caller owns it. */
  recordProtectedLandTarget: (pid: string, target: ProtectedMergeLandTarget) => void;
  /** Re-scans the on-disk `afk/` state for `projectPath` and applies it to the
   * caller's scan state — the on-disk scan is owned by the drain/scan seam,
   * not this hook. Used to refresh `midMerge` immediately after an abort. */
  refreshScan: (projectPath: string) => void;
}

export interface MergeLane {
  merging: boolean;
  mergeDisplay: MergeDisplay | null;
  mergeAffordance: MergeAffordance;
  sweepNote: string | null;
  aborting: boolean;
  resolveConflict: (slug: string) => void;
  mergeStrays: (slugs: string[]) => void;
  forceSweep: () => void;
  runAbortMerge: () => void;
  /** Clears all merge-lane state on a Project switch. */
  reset: () => void;
}

/**
 * The merge / auto-merge-lane seam (issues 08/16/17/24/46/145/146/148,
 * ADR-0021): the single merge invocation shared by the Map's exceptions
 * affordance (resolving a paused conflict, merging an adopted stray) and the
 * always-on lane's own merge, plus the mid-merge Abort affordance.
 *
 * `runMergeCore` also needs to drop merged branches from the on-disk scan and
 * clear the merged ids' run-tracking bookkeeping — state this hook does not
 * own. `onMergeCompleted` is the clean interface for that shared write: the
 * caller decides how to update its scan/run state, this hook just reports
 * which ids/slugs merged.
 */
export function useMergeLane(deps: MergeLaneDeps): MergeLane {
  const {
    projectPath,
    activeScan,
    runLog,
    liveRunIssueIds,
    runs,
    runStatusOf,
    isIsolated,
    logNote,
    onMergeCompleted,
    recordProtectedLandTarget,
    refreshScan,
  } = deps;

  const midMerge = activeScan.midMerge;

  const [merging, setMerging] = useState(false);
  const [mergeDisplay, setMergeDisplay] = useState<MergeDisplay | null>(null);
  // The mergeable-set signature already AUTO-attempted this drain (issue 46). A
  // clean auto-merge drops the branches and a conflict sets `midMerge` — both
  // self-guard against a re-fire — but a preflight failure leaves the branch
  // set unchanged, so this stops the auto-merge effect from looping on it.
  const autoMergeSig = useRef<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  // Retained ONLY as a defensive fallback for the (currently unreachable)
  // Dispatcher `merge` proposal kind — everyday merging belongs to the
  // always-on lane (ADR-0021, issue 148); the Map button targets EXPLICIT
  // slugs instead of this whole-batch plan.
  const mergePlan = mergeReadinessOnDisk(activeScan.branches, liveRunIssueIds);

  // The single merge invocation, shared by the Map's exceptions affordance
  // (`auto=false` — resolving a conflict, merging a stray) and the always-on
  // lane's own merge (`auto=true`, issues 145/146/148). The git work, the
  // merge-status display, and the on-disk/tracking cleanup are IDENTICAL in
  // both modes. The only thing `auto` adds is the Dispatcher posture on the
  // RESULT: a clean merge records a passive `merge` note and relays its
  // summary; a conflict / preflight failure records a blocking `merge-conflict`
  // proposal and surfaces the reason (never auto-resolved). The pure
  // `decideDispatcherMerge` makes that auto-vs-gate call. `targetSlugs` names
  // exactly which `afk/NN-slug` branches to integrate this invocation.
  const runMergeCore = useCallback(
    (targetSlugs: string[], auto: boolean, confirmProtected = false): void => {
      if (projectPath === null || merging) return;
      // Merge stays PER REPO (issue 72): one afk-merge invocation integrates one
      // repo's branches. Group the target set by the repo each branch lives in
      // (from the scan facts) and merge the FIRST group this invocation; a
      // remaining group re-derives as ready once the scan refreshes, so the next
      // click / lane-sweep round integrates it — sequential by construction.
      // A legacy Project has one repo, so the "first group" is the whole set,
      // byte-identical to before.
      const repoOf = (slug: string): string =>
        activeScan.branches.find((b) => b.slug === slug)?.repoPath ?? '';
      const firstRepo = targetSlugs.length > 0 ? repoOf(targetSlugs[0]) : '';
      const slugs = targetSlugs.filter((slug) => repoOf(slug) === firstRepo);
      if (slugs.length === 0) {
        // Triggered with nothing mergeable on disk (e.g. stale in-memory
        // readiness after the branches were removed): say so plainly rather than
        // silently doing nothing or later showing "could not run".
        setMergeDisplay(emptyMergeDisplay());
        return;
      }
      const mergedIds = new Set(
        activeScan.branches.filter((b) => slugs.includes(b.slug)).map((b) => b.issueId),
      );
      // Stable per-mergeable-set id so a re-render can't duplicate the note/gate.
      const sig = [...slugs].sort().join(',');

      setMerging(true);
      setMergeDisplay(pendingMergeDisplay(slugs.length));
      void window.mc
        .mergeRuns({
          projectPath,
          slugs,
          repoPath: firstRepo === '' ? undefined : firstRepo,
          confirmProtectedLand: confirmProtected,
        })
        .then((result) => {
          setMergeDisplay(mergeResultDisplay(result));
          // Protected-branch withhold (issue 113): the target is a protected branch
          // (`main`/`master`) and the human hasn't confirmed, so NOTHING landed.
          // Raise the blocking "big warning" gate (approve re-runs with confirmation)
          // and STOP — do not classify this as a conflict/preflight failure or run
          // the merged-cleanup below. Applies to the autonomous drain merge AND the
          // user-initiated Merge (both flow through here).
          if (result.protectedBranch && !confirmProtected) {
            const branch = result.protectedBranch;
            const pid = `protected-branch-land:merge:${sig}`;
            recordProtectedLandTarget(pid, { kind: 'merge', slugs, auto });
            logNote(pid, 'protected-branch-land', protectedLandWarning(branch));
            return;
          }
          if (auto) {
            // A stray-Receipt adoption (issue 62) is a repair MC did on its own:
            // it auto-committed known artifacts (dirty files under
            // `issues/completions/` on main) so the preflight could proceed —
            // worth a note since the drain journal reads it (issue 73).
            if (result.adopted !== undefined && result.adopted.length > 0) {
              logNote(
                `receipt-adopt:${sig}:${result.adopted.join(',')}`,
                'receipt-adopt',
                `Adopted stray Receipt(s) on main: ${result.adopted.join(', ')}`,
              );
            }
            // Classify the completed merge into an auto-proceed note vs a
            // conflict/failure note (ADR-0011's classifier, unchanged by ADR-0022).
            const decision = decideDispatcherMerge(result);
            if (decision.kind === 'auto') {
              // A CLEAN merge is a routine fact ("merged 05 clean") → a note.
              logNote(`merge:${sig}`, 'merge', decision.note);
            } else if (decision.kind === 'gate') {
              // A REAL CONFLICT: note it. Resolving it is the Merge
              // affordance's job (the `midMerge` banner + Abort merge), not an
              // approve/reject click — that gate was the retired chat panel's.
              logNote(`merge-conflict:${sig}`, 'merge-conflict', decision.reason);
            } else if (decision.kind === 'halt') {
              // A PREFLIGHT/tool failure is NOT a conflict and NOT approvable
              // (issue 59): an approval could only retry into the same dirty tree
              // and fail identically. Surface its truthful reason (the offending
              // paths) as its own passive note; once the tree is cleaned up (by
              // the user, or by MC committing a straggler Receipt), a retry — the
              // manual Merge button, or the next auto attempt — passes.
              logNote(`merge-preflight:${sig}`, 'merge-preflight', decision.reason);
            }
          }
          if (result.ok) {
            // Optimistically drop the merged slugs from the on-disk scan the
            // instant the merge succeeds, so `mergePlan` recomputes to not-ready
            // synchronously — before `merging` resets in `.finally` and re-enables
            // the button. Without this the scan keeps listing the now-deleted
            // branches until the next ~1.5s poll, so a rapid second click would
            // fire a merge at branches that no longer exist and surface an error
            // contradicting the success just shown (issue 29). The next real scan
            // confirms the same truth, so this is a safe optimistic prefix of it.
            // Merged Runs' worktrees are gone; the merged ids' commit error + once-
            // committed marker are stale too — clearing all three is the caller's
            // shared-write to make (`onMergeCompleted`).
            onMergeCompleted(mergedIds, slugs);
          }
        })
        .catch((err: unknown) => {
          setMergeDisplay(
            mergeThrewDisplay(err instanceof Error ? err.message : String(err)),
          );
        })
        .finally(() => setMerging(false));
    },
    [projectPath, merging, mergePlan, activeScan, logNote, onMergeCompleted, recordProtectedLandTarget],
  );

  // --- Merge affordance (issue 148, ADR-0021) ------------------------------
  // Everyday merging belongs to the lane; the Map button changes job to the
  // lane's EXCEPTIONS entry — a predicted conflict pausing the lane (named),
  // and/or adopted stray branches (no Receipt — the lane never touches them).
  // Both are independent facts, computed from the same on-disk scan + Run log
  // the lane itself reads. `main.liveSoloRun` is only knowable HERE (a live
  // solo Run is in-memory renderer state), so the prediction is evaluated
  // against an otherwise-idle main (a real mid-merge/dirty tree already gates
  // via the unchanged `midMerge` banner below).
  const liveSoloRun = useMemo(
    () => runs.some((r) => runStatusOf(r) === 'running' && !isIsolated(r)),
    [runs, runStatusOf, isIsolated],
  );
  const mergeAffordance: MergeAffordance = useMemo(
    () =>
      decideMergeAffordance({
        branches: activeScan.branches,
        previews: activeScan.previews ?? [],
        runLog,
        main: { cleanTree: true, midMerge, liveSoloRun },
      }),
    [activeScan, runLog, midMerge, liveSoloRun],
  );

  // Resolve a paused conflict: attempt the real merge of THIS branch (the
  // prediction may be stale — the tip may have moved — so this can also just
  // succeed). A genuine conflict leaves `main` mid-merge, which the unchanged
  // banner + Abort button below handles exactly as before (ADR-0021).
  const resolveConflict = useCallback(
    (slug: string): void => runMergeCore([slug], false),
    [runMergeCore],
  );
  // Merge adopted stray branches (no Receipt) — a manual human action the
  // lane deliberately never takes on its own.
  const mergeStrays = useCallback(
    (slugs: string[]): void => runMergeCore(slugs, false),
    [runMergeCore],
  );

  // Force one lane sweep NOW (issue 148): the same decision the always-on
  // effect below makes, just invoked on demand and always reporting an
  // outcome — a merge (via the unified `mergeDisplay`), the named pause, or
  // plainly that nothing was mergeable.
  const forceSweep = useCallback((): void => {
    setSweepNote(null);
    const laneBranches = laneBranchesFrom(
      { branches: activeScan.branches, previews: activeScan.previews ?? [], midMerge },
      runLog,
    );
    const decision = decideAutoMergeLane({
      branches: laneBranches,
      main: { cleanTree: true, midMerge, liveSoloRun },
    });
    if (decision.kind === 'merge') {
      runMergeCore([decision.slug], false);
      return;
    }
    if (decision.kind === 'pause') {
      setSweepNote(mergeAffordance.pausedConflict?.reason ?? `Auto-merge lane paused on ${decision.slug}.`);
      return;
    }
    setSweepNote(
      decision.reason === 'no-clean-branch'
        ? 'Nothing mergeable — the lane has no clean, Receipt-backed branch to merge right now.'
        : `Main is not idle (${decision.reason}) — the lane held.`,
    );
  }, [activeScan, runLog, midMerge, liveSoloRun, mergeAffordance, runMergeCore]);

  // --- Auto-merge lane (issues 145/146/148, ADR-0021) ----------------------
  // Everyday merging is ALWAYS ON now — no live Dispatcher session required
  // (replaces the old Dispatcher-only auto-merge effect, issue 46). On every
  // scan tick, ask the pure lane brain (fed by facts only a live Window has —
  // the in-memory live-solo-Run fact) whether to merge the next clean,
  // Receipt-backed branch, and fire the same (already-serialized) MergeRuns
  // IPC if so. A predicted conflict raises the same blocking `merge-conflict`
  // approval the press-time path always has; strays never enter this — only
  // the human merges them, via the Map's exceptions affordance above.
  // `autoMergeSig` records the attempted branch so a persistent preflight
  // failure — which leaves the branch set unchanged — can't loop the effect (a
  // clean merge drops the branch and a conflict sets `midMerge`, so those
  // self-guard).
  useEffect(() => {
    if (merging) return;
    const laneBranches = laneBranchesFrom(
      { branches: activeScan.branches, previews: activeScan.previews ?? [], midMerge },
      runLog,
    );
    const decision = decideAutoMergeLane({
      branches: laneBranches,
      main: { cleanTree: true, midMerge, liveSoloRun },
    });
    if (decision.kind !== 'merge') return;
    const sig = `${decision.issueId}:${decision.slug}`;
    if (autoMergeSig.current === sig) return;
    autoMergeSig.current = sig;
    runMergeCore([decision.slug], true);
  }, [activeScan, runLog, midMerge, liveSoloRun, merging, runMergeCore]);

  // Abort an in-progress merge left on `main` by a partial conflict (issue 24):
  // `git merge --abort` back to a clean `main` (already-merged slugs stay merged),
  // so a non-git user isn't stranded and a new drain/Run is unblocked. Refreshes
  // the scan immediately so `midMerge` clears without waiting for the next poll.
  const runAbortMerge = useCallback((): void => {
    if (projectPath === null || aborting) return;
    setAborting(true);
    void window.mc
      .abortMerge({ projectPath })
      .then((res) => {
        if (!res.ok) {
          window.alert(`Could not abort the merge: ${res.error ?? 'unknown error'}`);
          return;
        }
        // The conflicted merge is gone; drop the stale conflict panel and re-scan.
        setMergeDisplay(null);
        refreshScan(projectPath);
      })
      .catch((err: unknown) => {
        window.alert(
          `Could not abort the merge: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setAborting(false));
  }, [projectPath, aborting, refreshScan]);

  const reset = useCallback((): void => {
    setMerging(false);
    setAborting(false);
    setMergeDisplay(null);
    setSweepNote(null);
    autoMergeSig.current = null;
  }, []);

  return {
    merging,
    mergeDisplay,
    mergeAffordance,
    sweepNote,
    aborting,
    resolveConflict,
    mergeStrays,
    forceSweep,
    runAbortMerge,
    reset,
  };
}
