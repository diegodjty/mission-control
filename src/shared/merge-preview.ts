/**
 * Merge-preview decision module (pure — the deep module) — issue 104, ADR-0018.
 *
 * The entire Merge-preview badge contract is decided HERE, with no git, fs, or
 * Electron: given the ordered merge candidates, the tips the scan just observed
 * (the "stamp"), and the coordinator's cached verdict, emit each branch's
 * displayed verdict and answer "does the first branch need recomputing?".
 *
 * This slice (the tracer bullet) badges only the FIRST branch in merge order
 * (ascending issue id) — the one branch whose pairwise-against-default preview
 * is EXACT, because it merges first so its sequence position cannot change the
 * outcome. Later branches carry `verdict: null` (no badge yet): a pairwise guess
 * there would violate the sequence semantics ADR-0018 settled, and full-batch
 * verdicts are issue 105.
 *
 * Freshness rides the ~1.5 s scan poll (no `.git` watcher): every settled verdict
 * is stamped with the (default-branch tip, ordered finished-branch tips) it was
 * computed against; a stamp mismatch shows `recalculating` — never a stale
 * verdict — and the coordinator queues a recompute. Pure so the whole verdict
 * matrix is unit-testable in isolation (see the PRD "Testing Decisions").
 */
import type { MergeCandidate } from './merge-plan';

export type { MergeCandidate };

/**
 * The tips a verdict was computed against (ADR-0018 freshness): the default
 * branch tip plus the ordered finished-branch tips (ascending issue id). The
 * scan re-reads these each tick; any change means a cached verdict is stale.
 */
export interface PreviewStamp {
  /** The default/integration branch tip (a commit OID). */
  defaultTip: string;
  /** Each finished-unmerged branch's tip OID, ordered ascending by issue id. */
  branchTips: string[];
}

/** The raw outcome of simulating one branch's merge (from the adapter). */
export type RawSimOutcome =
  | { kind: 'clean' }
  | { kind: 'conflict'; files: string[] };

/** A settled (cacheable/displayable) verdict — the transient `recalculating` excluded. */
export type SettledVerdict = { kind: 'clean' } | { kind: 'conflicts'; files: string[] };

/** A branch's displayed merge-preview verdict, including the transient state. */
export type MergePreviewVerdict = SettledVerdict | { kind: 'recalculating' };

/**
 * One branch's preview as it travels with the scan result to the Map. A null
 * verdict means "no badge yet" — a later branch in this tracer slice (issue 105
 * fills these in).
 */
export interface BranchPreview {
  issueId: number;
  slug: string;
  verdict: MergePreviewVerdict | null;
}

/** The coordinator's cached verdict for a repo's first branch + its stamp. */
export interface CachedPreview {
  stamp: PreviewStamp;
  /** The slug the verdict is for — a different first branch invalidates it. */
  firstSlug: string;
  /** A settled verdict only — `recalculating` is display-only, never cached. */
  verdict: SettledVerdict;
}

/** Turn a raw simulation outcome into the settled verdict to cache/display. */
export function verdictFromSimulation(raw: RawSimOutcome): SettledVerdict {
  return raw.kind === 'clean' ? { kind: 'clean' } : { kind: 'conflicts', files: raw.files };
}

/** Value-equality of two stamps (default tip + ordered branch tips). */
export function stampsEqual(a: PreviewStamp, b: PreviewStamp): boolean {
  if (a.defaultTip !== b.defaultTip) return false;
  if (a.branchTips.length !== b.branchTips.length) return false;
  for (let i = 0; i < a.branchTips.length; i++) {
    if (a.branchTips[i] !== b.branchTips[i]) return false;
  }
  return true;
}

/**
 * Whether the first branch's verdict must be recomputed: no cache, a different
 * first branch, or a stamp mismatch (main or a branch tip moved). The coordinator
 * consults this to decide whether to queue a (coalesced) recompute.
 */
export function previewNeedsRecompute(
  cached: CachedPreview | null,
  firstSlug: string,
  currentStamp: PreviewStamp,
): boolean {
  return (
    cached === null ||
    cached.firstSlug !== firstSlug ||
    !stampsEqual(cached.stamp, currentStamp)
  );
}

/**
 * Decide each candidate's displayed verdict for the tracer slice (issue 104).
 *
 * Only the FIRST candidate (candidates[0], lowest issue id) carries a verdict. A
 * FRESH cache (same first branch, matching stamp) shows its settled verdict;
 * anything else (cold, stale, or a changed first branch) shows `recalculating` —
 * never a stale verdict. Every later candidate carries `verdict: null` — no badge
 * yet (issue 105). `candidates` MUST already be ordered ascending by issue id
 * (as `mergeReadinessOnDisk(...).mergeable` supplies them).
 */
export function decidePreviews(input: {
  candidates: MergeCandidate[];
  currentStamp: PreviewStamp;
  cached: CachedPreview | null;
}): BranchPreview[] {
  const { candidates, currentStamp, cached } = input;
  if (candidates.length === 0) return [];
  const first = candidates[0];
  const fresh =
    cached !== null &&
    cached.firstSlug === first.slug &&
    stampsEqual(cached.stamp, currentStamp);
  const firstVerdict: MergePreviewVerdict = fresh ? cached.verdict : { kind: 'recalculating' };
  return candidates.map((c, i) => ({
    issueId: c.issueId,
    slug: c.slug,
    verdict: i === 0 ? firstVerdict : null,
  }));
}

/** Value-equality of two verdicts (or nulls), including the conflict file list. */
export function verdictEqual(
  a: MergePreviewVerdict | null,
  b: MergePreviewVerdict | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'conflicts' && b.kind === 'conflicts') {
    return a.files.length === b.files.length && a.files.every((f, i) => f === b.files[i]);
  }
  return true;
}

/**
 * Value-equality of two branch-preview lists — the guard the ~1.5 s scan poll
 * uses so a fresh scan object is kept only when NOTHING changed (branches,
 * mid-merge, AND previews). Without previews in the comparison, a verdict
 * flipping `recalculating → clean` on an otherwise-unchanged tick would be
 * dropped and the badge would never refresh (issue 104).
 */
export function branchPreviewsEqual(a: BranchPreview[], b: BranchPreview[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].issueId !== b[i].issueId || a[i].slug !== b[i].slug) return false;
    if (!verdictEqual(a[i].verdict, b[i].verdict)) return false;
  }
  return true;
}

/** The Map badge's text, tooltip, and tone for a verdict (pure display mapping). */
export interface PreviewBadge {
  label: string;
  title: string;
  tone: 'clean' | 'conflicts' | 'recalculating';
}

/**
 * Map a verdict to its Map badge (pure display selector, mirroring merge-display).
 * `conflicts` names the files it found so the blast radius — a lockfile vs. the
 * module two Runs both rewrote — is visible without pressing Merge.
 */
export function previewBadge(verdict: MergePreviewVerdict): PreviewBadge {
  switch (verdict.kind) {
    case 'clean':
      return {
        label: 'merges clean',
        title: 'Previewed against the current default-branch tip: this branch merges cleanly.',
        tone: 'clean',
      };
    case 'conflicts':
      return {
        label: verdict.files.length > 0 ? `conflicts (${verdict.files.join(', ')})` : 'conflicts',
        title:
          verdict.files.length > 0
            ? `Merging this branch would conflict in: ${verdict.files.join(', ')}`
            : 'Merging this branch would conflict.',
        tone: 'conflicts',
      };
    case 'recalculating':
      return {
        label: 'recalculating…',
        title: 'The default branch or this branch moved — recomputing the merge preview.',
        tone: 'recalculating',
      };
  }
}
