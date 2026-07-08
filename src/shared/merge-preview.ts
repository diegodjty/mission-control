/**
 * Merge-preview decision module (pure — the deep module) — issues 104 & 105, ADR-0018.
 *
 * The entire Merge-preview badge contract is decided HERE, with no git, fs, or
 * Electron: given the ordered merge candidates, the tips the scan just observed
 * (the "stamp"), and the coordinator's cached sequence outcome, emit each
 * branch's displayed verdict and answer "does this batch need recomputing?".
 *
 * Sequence semantics (issue 105). The preview simulates the FULL merge sequence
 * in current merge order (ascending issue id) — exactly what pressing Merge does
 * via `afk-merge.sh`: merge the first branch, then each subsequent branch on top
 * of the running result, STOPPING at the first predicted conflict. So the
 * verdicts a settled sequence produces are:
 *   - a clean chain  → every branch `clean`;
 *   - a conflict at position k → branches before k `clean`, branch k
 *     `conflicts (files…)`, and every branch AFTER k `blocked behind NN` (NN =
 *     the first conflicting branch), because the real merge exits at k and later
 *     branches never merge — no speculative verdicts past the stop.
 * (Issue 104's tracer badged only the first branch; 105 fills in the rest.)
 *
 * Freshness rides the ~1.5 s scan poll (no `.git` watcher): every settled
 * sequence is stamped with the (default-branch tip, ordered finished-branch
 * tips) it was computed against — so ANY batch change (a new finished branch, a
 * discarded one, a re-run moving a tip) is a stamp/slug mismatch that shows
 * `recalculating` (never a stale verdict) and makes the coordinator recompute
 * the whole sequence. Pure so the whole verdict matrix is unit-testable in
 * isolation (see the PRD "Testing Decisions").
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

/** The raw outcome of simulating one branch's merge step (from the adapter). */
export type RawSimOutcome =
  | { kind: 'clean' }
  | { kind: 'conflict'; files: string[] };

/**
 * The raw outcome of simulating the WHOLE merge sequence (issue 105, from the
 * adapter). `steps` holds one entry per candidate IN MERGE ORDER, up to and
 * INCLUDING the first conflict: a clean chain has one `clean` per candidate; a
 * conflict at index k gives `steps.length === k + 1` with `steps[k]` the
 * conflict and everything before it `clean`. Candidates after the first
 * conflict are deliberately NOT simulated — the real merge stops there.
 */
export interface SequenceSimOutcome {
  steps: RawSimOutcome[];
}

/**
 * A settled (cacheable/displayable) verdict — the transient `recalculating`
 * excluded. `blocked` names the first-conflicting branch (issue 105): this
 * branch never merges because the sequence stops before it.
 */
export type SettledVerdict =
  | { kind: 'clean' }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'blocked'; behindIssueId: number };

/**
 * A branch's displayed merge-preview verdict, including the two transient states:
 * `recalculating` (a tip moved; the sequence is being recomputed) and `suspended`
 * (the repo is mid-merge, so no verdict can be computed — ADR-0018, issue 107).
 * Neither transient state is a `SettledVerdict`: neither is cached.
 */
export type MergePreviewVerdict =
  | SettledVerdict
  | { kind: 'recalculating' }
  | { kind: 'suspended' };

/**
 * One branch's preview as it travels with the scan result to the Map. A null
 * verdict means "no verdict" — a defensive state the renderer simply shows no
 * badge for; in normal operation every candidate carries a verdict (issue 105).
 */
export interface BranchPreview {
  issueId: number;
  slug: string;
  verdict: MergePreviewVerdict | null;
}

/**
 * The coordinator's cached SEQUENCE outcome for a repo's whole batch + the tips
 * and the ordered candidate identity it was computed against. A different batch
 * (branch added/discarded/reordered) or a moved tip invalidates it.
 */
export interface CachedPreview {
  stamp: PreviewStamp;
  /** The ordered candidate slugs the sequence was computed for (batch identity). */
  slugs: string[];
  /** The raw per-step sequence outcome (clean chain, or clean…+first conflict). */
  outcome: SequenceSimOutcome;
}

/** Value-equality of two ordered slug lists (the batch identity). */
export function slugsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
 * Whether the sequence must be recomputed: no cache, a changed batch (candidate
 * slug set/order), or a stamp mismatch (the default tip or any branch tip
 * moved). The coordinator consults this to decide whether to queue a (coalesced)
 * recompute. A single mismatch invalidates the WHOLE sequence — a conflict on an
 * early branch reshuffles every downstream `blocked behind NN`.
 */
export function previewNeedsRecompute(
  cached: CachedPreview | null,
  candidateSlugs: string[],
  currentStamp: PreviewStamp,
): boolean {
  return (
    cached === null ||
    !slugsEqual(cached.slugs, candidateSlugs) ||
    !stampsEqual(cached.stamp, currentStamp)
  );
}

/**
 * Turn a settled sequence outcome into each candidate's verdict (pure). The
 * first `conflict` step is the stop point: before it, `clean`; at it,
 * `conflicts`; after it, `blocked behind <first conflicting issue id>`. A
 * conflict-free sequence badges every candidate `clean`.
 */
export function sequenceVerdicts(
  candidates: MergeCandidate[],
  outcome: SequenceSimOutcome,
): SettledVerdict[] {
  const conflictIndex = outcome.steps.findIndex((s) => s.kind === 'conflict');
  return candidates.map((_c, i) => {
    if (conflictIndex === -1 || i < conflictIndex) return { kind: 'clean' };
    if (i === conflictIndex) {
      const step = outcome.steps[i];
      return { kind: 'conflicts', files: step.kind === 'conflict' ? step.files : [] };
    }
    return { kind: 'blocked', behindIssueId: candidates[conflictIndex].issueId };
  });
}

/**
 * Decide every candidate's displayed verdict (issue 105). A FRESH cache (same
 * ordered batch, matching stamp) maps its settled sequence to per-branch
 * verdicts via `sequenceVerdicts`; anything else (cold, stale, or a changed
 * batch) shows `recalculating` for EVERY branch — never a stale verdict, and
 * never a mix of fresh-and-stale rows, because the sequence is recomputed as one
 * unit. `candidates` MUST already be ordered ascending by issue id (as
 * `mergeReadinessOnDisk(...).mergeable` supplies them).
 *
 * Mid-merge suspension (issue 107, ADR-0018) takes precedence over everything: a
 * repo whose partial Merge hit a conflict (MERGE_HEAD set) can't be Merge-pressed
 * at all, so any verdict would predict a press that cannot happen. When `midMerge`
 * is set, EVERY branch shows `suspended` ("merge in progress") regardless of
 * cache or stamp — never `recalculating`, never a stale verdict. Previews resume
 * on their own once the mid-merge clears: Abort or resolve+commit moves main's
 * tip, the stamp mismatch catches it, and the next tick recomputes.
 */
export function decidePreviews(input: {
  candidates: MergeCandidate[];
  currentStamp: PreviewStamp;
  cached: CachedPreview | null;
  /** The repo is mid-merge ⇒ suspend every branch, compute nothing. Omitted ⇒ no. */
  midMerge?: boolean;
}): BranchPreview[] {
  const { candidates, currentStamp, cached, midMerge = false } = input;
  if (candidates.length === 0) return [];
  if (midMerge) {
    return candidates.map((c) => ({
      issueId: c.issueId,
      slug: c.slug,
      verdict: { kind: 'suspended' },
    }));
  }
  const slugs = candidates.map((c) => c.slug);
  const fresh =
    cached !== null && slugsEqual(cached.slugs, slugs) && stampsEqual(cached.stamp, currentStamp);
  if (!fresh) {
    return candidates.map((c) => ({
      issueId: c.issueId,
      slug: c.slug,
      verdict: { kind: 'recalculating' },
    }));
  }
  const verdicts = sequenceVerdicts(candidates, cached.outcome);
  return candidates.map((c, i) => ({ issueId: c.issueId, slug: c.slug, verdict: verdicts[i] }));
}

/** Value-equality of two verdicts (or nulls), including verdict-specific fields. */
export function verdictEqual(
  a: MergePreviewVerdict | null,
  b: MergePreviewVerdict | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'conflicts' && b.kind === 'conflicts') {
    return a.files.length === b.files.length && a.files.every((f, i) => f === b.files[i]);
  }
  if (a.kind === 'blocked' && b.kind === 'blocked') {
    return a.behindIssueId === b.behindIssueId;
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
  tone: 'clean' | 'conflicts' | 'blocked' | 'recalculating' | 'suspended';
}

/** Format an issue id the way the Map shows it (`NN`, zero-padded to two). */
function issueLabel(issueId: number): string {
  return String(issueId).padStart(2, '0');
}

/**
 * Map a verdict to its Map badge (pure display selector, mirroring merge-display).
 * `conflicts` names the files it found so the blast radius — a lockfile vs. the
 * module two Runs both rewrote — is visible without pressing Merge; `blocked`
 * names the earlier branch (issue 105) whose predicted conflict stops the merge
 * before this one.
 */
export function previewBadge(verdict: MergePreviewVerdict): PreviewBadge {
  switch (verdict.kind) {
    case 'clean':
      return {
        label: 'merges clean',
        title:
          'Previewed against the full merge sequence in merge order: this branch merges cleanly.',
        tone: 'clean',
      };
    case 'conflicts':
      return {
        label: verdict.files.length > 0 ? `conflicts (${verdict.files.join(', ')})` : 'conflicts',
        title:
          verdict.files.length > 0
            ? `Merging this branch (in sequence) would conflict in: ${verdict.files.join(', ')}`
            : 'Merging this branch (in sequence) would conflict.',
        tone: 'conflicts',
      };
    case 'blocked':
      return {
        label: `blocked behind ${issueLabel(verdict.behindIssueId)}`,
        title:
          `Issue ${issueLabel(verdict.behindIssueId)} is predicted to conflict earlier in the ` +
          `merge sequence, so pressing Merge stops there — this branch never merges.`,
        tone: 'blocked',
      };
    case 'recalculating':
      return {
        label: 'recalculating…',
        title: 'The default branch or a finished branch moved — recomputing the merge preview.',
        tone: 'recalculating',
      };
    case 'suspended':
      return {
        label: 'merge in progress',
        title:
          'This repo is mid-merge — a merge stopped on a conflict, so a preview would ' +
          'predict a Merge press that can’t happen. Previews are suspended until you ' +
          'resolve and commit, or Abort; fresh verdicts return once main is clean again.',
        tone: 'suspended',
      };
  }
}
