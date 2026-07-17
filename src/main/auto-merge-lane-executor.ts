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
 * Scope of THIS slice (issue 145): a single clean branch per sweep, and the sweep
 * is the pure decision + one merge. **Live subscription** (calling `sweepLane`
 * from the `ReceiptWatch` onReceipt callback and the MergeRuns completion in
 * `index.ts`, and retiring the renderer's Dispatcher-only auto-merge effect) plus
 * multi-branch ordering, the conflict lane-pause, and the artifact skip are the
 * sequenced follow-ons (issues 146/148) — wiring both triggers live now would
 * double-fire alongside the still-present press-time path.
 */
import { mergeReadinessOnDisk, type AfkBranchFacts } from '../shared/worktree-scan';
import type { BranchPreview } from '../shared/merge-preview';
import type { MergeRunsResult, RunLogRecord } from '../shared/ipc-contract';
import type { RepoSerializer } from '../shared/repo-serializer';
import { hasReceiptFor } from '../shared/receipt-audit';
import {
  decideAutoMergeLane,
  type LaneBranch,
  type LaneHoldReason,
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

/** The outcome of one sweep: it held (and why), or it swept a branch (with the classified result). */
export type LaneSweepOutcome =
  | { kind: 'hold'; reason: LaneHoldReason }
  | {
      kind: 'swept';
      issueId: number;
      slug: string;
      /** The raw merge result the machinery returned. */
      result: MergeRunsResult;
      /**
       * The auto-vs-gate classification (`decideDispatcherMerge`): a clean sweep is
       * `auto` → the caller records the passive `merge` note (silent + note, no
       * gate); a conflict is `gate`; a preflight failure is `halt`. The lane-PAUSE
       * a `gate` should raise is issue 146 — this slice only classifies.
       */
      decision: DispatcherMergeDecision;
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
 * Run one sweep of the auto-merge lane for a repo. Reads the current scan +
 * main-idle facts, asks the pure `decideAutoMergeLane`, and — only on a `merge`
 * verdict — runs the real merge UNDER the per-repo serializer, returning the
 * classified result. A `hold` verdict does nothing but report why (no git touch).
 * Idempotent per tick: with no change on disk a re-sweep decides identically.
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
  if (decision.kind === 'hold') return { kind: 'hold', reason: decision.reason };

  // Merge the ONE branch the lane chose, under the per-repo serializer so the
  // merge never races a scan-recompute or a manual Merge on the same repo.
  const result = await deps.serializer.run(deps.serializerKey, () => deps.merge([decision.slug]));
  return {
    kind: 'swept',
    issueId: decision.issueId,
    slug: decision.slug,
    result,
    decision: decideDispatcherMerge(result),
  };
}
