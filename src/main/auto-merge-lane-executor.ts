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
 * Still deferred to issue 148 (the Merge-button rejob): the LIVE subscription —
 * calling `sweepAutoMergeLane` from the `ReceiptWatch` onReceipt callback and the
 * MergeRuns completion in `index.ts`, and retiring the renderer's Dispatcher-only
 * auto-merge effect (`App.tsx`). Wiring the triggers live now would double-fire
 * alongside the still-present press-time path; 148 is where that path becomes the
 * exceptions entry (resolve/abort a paused lane, adopt strays, force a sweep). The
 * always-on PROPERTY is proven here and in the e2e by driving a sweep with no
 * drain live — the executor is stateless per tick, so any trigger can fire it.
 */
import { mergeReadinessOnDisk, type AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview, SettledVerdict } from '../shared/merge-preview';
import type { MergeRunsResult, RunLogRecord } from '../shared/ipc-contract';
import type { RepoSerializer } from '../shared/repo-serializer';
import type { DispatcherAction } from '../shared/dispatcher-authority';
import { hasReceiptFor } from '../shared/receipt-audit';
import {
  decideAutoMergeLane,
  type LaneBranch,
  type LaneHoldReason,
  type LaneSkip,
  type MainIdle,
} from '../shared/auto-merge-lane';
import { decideDispatcherMerge, type DispatcherMergeDecision } from '../shared/dispatcher-merge';

/** One repo's scanned facts the sweep reads (the shape `scanReposWithPreviews` yields per repo). */
export interface AutoMergeLaneScan {
  /** The repo's `afk/` branch facts (finished-unmerged is derived from these). */
  branches: AfkBranchFacts[];
  /** Each finished-unmerged branch's preview verdict against the current tip. */
  previews: BranchPreview[];
  /** True when this repo is left mid-merge (a main-idle fact — issue 24). */
  midMerge: boolean;
}

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
 * The Receipt `finished` timestamp embedded in a Run-log record's id
 * (`receipt:<NN-slug>:<finished>`, ADR-0013). The slug carries no colon and
 * `finished` is ISO-8601 (which does), so everything past the second colon is the
 * timestamp. Null for a non-Receipt (legacy scroll-era) record or a malformed id.
 */
function finishedFromReceiptId(id: string): string | null {
  const prefix = 'receipt:';
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const slugEnd = rest.indexOf(':');
  if (slugEnd === -1) return null;
  const finished = rest.slice(slugEnd + 1);
  return finished.length > 0 ? finished : null;
}

/** The latest Receipt's `finished` timestamp per issue id (newest `capturedAt` wins). */
function latestFinishedByIssue(runLog: readonly RunLogRecord[]): Map<number, string> {
  const latestCapturedAt = new Map<number, string>();
  const finished = new Map<number, string>();
  for (const rec of runLog) {
    if (rec.issueId === null || !rec.id.startsWith('receipt:')) continue;
    const prior = latestCapturedAt.get(rec.issueId);
    if (prior !== undefined && rec.capturedAt <= prior) continue;
    const stamp = finishedFromReceiptId(rec.id);
    if (stamp === null) continue;
    latestCapturedAt.set(rec.issueId, rec.capturedAt);
    finished.set(rec.issueId, stamp);
  }
  return finished;
}

/**
 * Assemble the pure lane's candidate list from a scan + previews + the Run log:
 * every finished-unmerged branch (`mergeReadinessOnDisk`), annotated with whether
 * a Receipt backs it, its Receipt `finished` timestamp, and its preview verdict.
 * Exported for the executor test (and 146) to reuse the exact assembly.
 */
export function laneBranchesFrom(
  scan: AutoMergeLaneScan,
  runLog: readonly RunLogRecord[],
): LaneBranch[] {
  const verdictByIssue = new Map(scan.previews.map((p) => [p.issueId, p.verdict]));
  const finishedByIssue = latestFinishedByIssue(runLog);
  return mergeReadinessOnDisk(scan.branches).mergeable.map((c) => ({
    issueId: c.issueId,
    slug: c.slug,
    receiptBacked: hasReceiptFor(runLog, c.issueId),
    finished: finishedByIssue.get(c.issueId) ?? null,
    verdict: verdictByIssue.get(c.issueId) ?? null,
  }));
}

/**
 * The plain-language cause a paused lane surfaces on its blocking `merge-conflict`
 * approval — the conflicting files for a `conflicts` branch, or the earlier branch
 * a `blocked` one is stuck behind. Mirrors the wording the merge-preview badge uses.
 */
function pauseReason(slug: string, verdict: SettledVerdict): string {
  if (verdict.kind === 'blocked') {
    return `Auto-merge lane paused: ${slug} is blocked behind issue ${verdict.behindIssueId}'s predicted conflict — resolve or abort it to resume the lane.`;
  }
  const files = verdict.kind === 'conflicts' && verdict.files.length > 0 ? ` in ${verdict.files.join(', ')}` : '';
  return `Auto-merge lane paused: ${slug} is predicted to conflict${files} — resolve or abort it to resume the lane.`;
}

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
