/**
 * Auto-merge lane executor (main process) — issue 145, ADR-0021 (merge-as-you-go).
 *
 * The lane's ACTUATOR: it turns the pure `decideAutoMergeLane` verdict into a real
 * `afk-merge.sh` merge, run UNDER the per-repo serializer, and classifies the
 * result into the same auto-note-vs-gate posture the press-time path already uses
 * (`decideDispatcherMerge`). One call is one **sweep**; the lane fires a sweep on
 * every Run-finish and every merge completion (ADR-0021), so the executor holds no
 * state of its own — each sweep re-reads the current scan, previews, and main-idle
 * facts and decides afresh (the preview is always re-stamped against the CURRENT
 * tip, so a stale go/no-go can't survive a sweep).
 *
 * Like the sibling I/O edges (`run-merge`, `merge-preview-scan`) this stays
 * Electron-free: every git/serializer/merge touch is an injected `dep`, so the
 * "clean → merge under the serializer / non-idle → hold / stray → never merge"
 * wiring is asserted BY TEST (`auto-merge-lane-executor.test.ts`) and the e2e
 * drives it against real infrastructure, rather than being buried in `index.ts`.
 *
 * Scope (issues 145 → 146). Issue 145 was the walking skeleton: a single clean
 * branch per sweep, decision + one merge. **Issue 146 completes the lane doctrine
 * in this executor**: one sweep now walks the finish-ordered candidates and can
 * return `paused` (a PREDICTED conflict raises the blocking `merge-conflict`
 * approval WITHOUT touching main — the pure brain decided it) and carries the
 * artifact offenders `skipped` this sweep for the caller's per-branch attention
 * items. An ACTUAL conflict on a `merge` still classifies to `gate` and leaves
 * main mid-merge, so both conflict kinds pause the whole lane until resolved.
 *
 * Issue 148 (the Merge-button rejob) wires the LIVE trigger into the renderer
 * instead of here: `App.tsx` runs the same `decideAutoMergeLane` decision (fed by
 * facts only a live Window has — the in-memory live-solo-Run fact — via
 * `../shared/merge-affordance`) on every scan tick and Run-finish, firing the
 * existing `MergeRuns` IPC (already serialized per repo) when it says `merge`,
 * and raising the same blocking `merge-conflict` approval when it says `pause`.
 * The renderer's Dispatcher-only auto-merge effect (issue 46) retired in favor of
 * that always-on path. THIS module — the main-process sweep, independent of any
 * live Window — stays available (and unit-tested) for a future headless trigger
 * (a `ReceiptWatch` callback or the `MergeRuns` completion in `index.ts`) but is
 * not yet wired to one; nothing production calls `sweepAutoMergeLane` today.
 */
import type { MergeRunsResult, RunLogRecord } from '../shared/ipc-contract';
import type { RepoSerializer } from '../shared/repo-serializer';
import type { DispatcherAction } from '../shared/action-authority';
import {
  decideAutoMergeLane,
  laneBranchesFrom,
  pauseReason,
  type AutoMergeLaneScan,
  type LaneHoldReason,
  type LaneSkip,
  type MainIdle,
} from '../shared/auto-merge-lane';
import { decideDispatcherMerge, type DispatcherMergeDecision } from '../shared/merge-classification';

export { laneBranchesFrom };
export type { AutoMergeLaneScan } from '../shared/auto-merge-lane';

/**
 * Everything one sweep needs, injected so the executor stays pure-ish (no direct
 * git/Electron). In production `index.ts` binds `scan` to `scanReposWithPreviews`
 * for the repo, `merge` to `mergeRuns(repo, slugs, …)`, `serializer` to the shared
 * `repoSerializer`, and `serializerKey` to `normalizeProjectKey(repo)` — the SAME
 * key the AfkScan / MergeRuns handlers use, so a sweep never races a scan-recompute
 * or a manual Merge on the same repo.
 */
export interface AutoMergeLaneSweepDeps {
  /** Read this repo's branches + previews + mid-merge flag for the current tick. */
  scan: () => Promise<AutoMergeLaneScan>;
  /** Is the main working tree clean (no uncommitted/untracked changes)? */
  isCleanTree: () => Promise<boolean>;
  /** Is a solo (on-main, non-isolated) Run live right now? An in-memory fact. */
  hasLiveSoloRun: () => boolean;
  /** The Run log — its Receipt records back the "Receipt-backed" and finish-order facts. */
  runLog: readonly RunLogRecord[];
  /** Merge the given `afk/NN-slug` branch(es) — the real `afk-merge.sh` machinery. */
  merge: (slugs: string[]) => Promise<MergeRunsResult>;
  /** The per-repo serializer the merge runs under (ADR-0021). */
  serializer: RepoSerializer;
  /** This repo's serializer key (`normalizeProjectKey(repo)` in production). */
  serializerKey: string;
}

/**
 * The outcome of one sweep (issue 146). Every outcome carries `skipped` — the
 * artifact-hygiene offenders passed this sweep (issue 106), which the caller turns
 * into per-branch attention items whether or not anything merged.
 *   - `hold`   — nothing merged (main not idle, or nothing currently mergeable).
 *   - `paused` — a PREDICTED conflict stopped the lane: NO merge was attempted
 *     (main is untouched), and the caller raises the blocking `merge-conflict`
 *     approval on `slug`. The lane stays paused (every sweep re-`paused`s) until the
 *     branch is resolved or aborted and leaves the candidate set — then it resumes.
 *   - `swept`  — a branch was merged; `decision` classifies it (`auto` clean note /
 *     `gate` an ACTUAL conflict that now left main mid-merge / `halt` preflight).
 */
export type LaneSweepOutcome =
  | { kind: 'hold'; reason: LaneHoldReason; skipped: LaneSkip[] }
  | {
      kind: 'paused';
      issueId: number;
      slug: string;
      /** The ADR-0011 blocking action a paused lane raises — reused, never a new one. */
      action: Extract<DispatcherAction, 'merge-conflict'>;
      /** Plain-language cause (the conflicting files, or the branch it is blocked behind). */
      reason: string;
      skipped: LaneSkip[];
    }
  | {
      kind: 'swept';
      issueId: number;
      slug: string;
      /** The raw merge result the machinery returned. */
      result: MergeRunsResult;
      /**
       * The auto-vs-gate classification (`decideDispatcherMerge`): a clean sweep is
       * `auto` → the caller records the passive `merge` note (silent + note, no
       * gate); an ACTUAL conflict is `gate` (and leaves main mid-merge, pausing the
       * lane via the idle gate); a preflight failure is `halt`.
       */
      decision: DispatcherMergeDecision;
      skipped: LaneSkip[];
    };

/**
 * Run one sweep of the auto-merge lane for a repo (issue 146). Reads the current
 * scan + main-idle facts, asks the pure `decideAutoMergeLane`, and:
 *   - `merge` → runs the real merge UNDER the per-repo serializer, returns the
 *     classified result (an actual conflict there leaves main mid-merge, which the
 *     idle gate pauses on every following sweep).
 *   - `pause` → a PREDICTED conflict: touches no git, returns a `paused` outcome
 *     carrying the blocking `merge-conflict` action + reason for the caller to gate.
 *   - `hold` → does nothing but report why.
 * Every outcome carries the artifact offenders `skipped` this sweep. Idempotent per
 * tick: with no change on disk a re-sweep decides identically, so re-firing on a
 * scan tick or a merge completion is safe.
 */
export async function sweepAutoMergeLane(
  deps: AutoMergeLaneSweepDeps,
): Promise<LaneSweepOutcome> {
  const scan = await deps.scan();
  const branches = laneBranchesFrom(scan, deps.runLog);
  const main: MainIdle = {
    cleanTree: await deps.isCleanTree(),
    midMerge: scan.midMerge,
    liveSoloRun: deps.hasLiveSoloRun(),
  };

  const decision = decideAutoMergeLane({ branches, main });
  if (decision.kind === 'hold') {
    return { kind: 'hold', reason: decision.reason, skipped: decision.skipped };
  }
  if (decision.kind === 'pause') {
    // A predicted conflict never touches main: raise the blocking approval and let
    // the queued branches wait. The pause lifts on its own once this branch is
    // resolved or aborted (it drops from the candidate set on the next sweep).
    return {
      kind: 'paused',
      issueId: decision.issueId,
      slug: decision.slug,
      action: 'merge-conflict',
      reason: pauseReason(decision.slug, decision.verdict),
      skipped: decision.skipped,
    };
  }

  // Merge the ONE branch the lane chose, under the per-repo serializer so the
  // merge never races a scan-recompute or a manual Merge on the same repo.
  const result = await deps.serializer.run(deps.serializerKey, () => deps.merge([decision.slug]));
  return {
    kind: 'swept',
    issueId: decision.issueId,
    slug: decision.slug,
    result,
    decision: decideDispatcherMerge(result),
    skipped: decision.skipped,
  };
}
