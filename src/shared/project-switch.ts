/**
 * Project-switch scoping (issue 26) — the pure rules that stop one Project's
 * run/scan/merge state from bleeding into another when the active Project
 * changes.
 *
 * The bug (hardening review 2026-07-03, state-H1 + M4 + M6): switching the
 * active Project changed only `activeRepoPath`; the renderer's `runs`,
 * `afkScan`, `worktreeStatuses`, and `mergeDisplay` all persisted. Because the
 * on-disk `afk/` scan (worktree-scan) is keyed by BARE issue id, Project A's
 * "issue 05 finished-unmerged" marked Project B's issue 05 and offered a bogus
 * Merge against B (running `afk-merge.sh` on an `afk/05-…` branch that only
 * exists in A). On a transient scan error the renderer "kept the last scan" —
 * i.e. the PREVIOUS Project's branches.
 *
 * Two pure rules fix this and are unit-testable in isolation (the renderer just
 * applies them):
 *
 *   1. `isProjectSwitch` — did the active Project actually change to a
 *      different, non-null repo? Gates the imperative reset so a spurious
 *      registry refresh (same active repo) doesn't wipe live Runs.
 *   2. `scanForProject` — tag every scan with the Project it was taken for and
 *      surface it ONLY while that Project is still the active one. This makes
 *      the id-keyed indicators impossible to bleed across Projects: a scan from
 *      A is empty the instant B is active, so nothing shows until B's own fresh
 *      scan lands (and a transient error that leaves A's stale scan in state
 *      shows nothing rather than A's branches).
 */
import type { AfkBranchFacts } from './worktree-scan';
import type { BranchPreview } from './merge-preview';

/**
 * A scan of a Project's on-disk `afk/` state, tagged with the `projectPath` it
 * was taken for. Storing the owning Project alongside the facts is what lets
 * `scanForProject` reject a scan that no longer belongs to the active Project.
 */
export interface ScopedScan {
  /** The Project path this scan was taken for. */
  projectPath: string;
  /** The `afk/` branch facts read for that Project. */
  branches: AfkBranchFacts[];
  /** Whether that Project's `main` is mid-merge (a partial afk-merge conflict). */
  midMerge: boolean;
  /**
   * Per-branch merge-preview verdicts (issue 104), scoped like everything else:
   * a scan from another Project must not badge this one's rows. Optional so
   * callers built before previews existed (and older scans) still type-check.
   */
  previews?: BranchPreview[];
  /** The passive git-floor note (issue 104), or null/absent when previews are on. */
  previewNote?: string | null;
}

/** The safe, Project-scoped view of a scan: empty unless it matches the active Project. */
export interface ActiveScanView {
  branches: AfkBranchFacts[];
  midMerge: boolean;
  previews: BranchPreview[];
  previewNote: string | null;
}

/** An empty view — no indicators, not mid-merge, no previews. */
const EMPTY_VIEW: ActiveScanView = { branches: [], midMerge: false, previews: [], previewNote: null };

/**
 * Whether the active Project genuinely changed — i.e. a switch that should
 * reset all per-Project run/merge state. True only when moving to a different,
 * non-null repo; re-selecting the same repo, or a registry refresh reporting
 * the same active repo, is NOT a switch and must not wipe live Runs.
 */
export function isProjectSwitch(prev: string | null, next: string | null): boolean {
  return next !== null && next !== prev;
}

/**
 * The Project-scoped view of the stored scan. Returns the scan's branches +
 * mid-merge flag ONLY when the scan was taken for the currently-active Project;
 * otherwise an empty view.
 *
 * This is the single guard that makes id-keyed indicators safe across Projects:
 *   - Right after a switch, the stored scan still belongs to the OLD Project (or
 *     was cleared to null) → empty view → no indicator shows until the NEW
 *     Project's fresh scan lands tagged with its path.
 *   - A transient scan error that leaves the previous Project's scan in state →
 *     tag mismatch → empty view, never the previous Project's branches.
 *   - A shared issue id (e.g. `05`) present in both Projects can never
 *     cross-contaminate, because a scan is only ever read against the Project it
 *     was taken for.
 */
export function scanForProject(
  scan: ScopedScan | null,
  activeProjectPath: string | null,
): ActiveScanView {
  if (scan === null || activeProjectPath === null) return EMPTY_VIEW;
  if (scan.projectPath !== activeProjectPath) return EMPTY_VIEW;
  return {
    branches: scan.branches,
    midMerge: scan.midMerge,
    previews: scan.previews ?? [],
    previewNote: scan.previewNote ?? null,
  };
}
