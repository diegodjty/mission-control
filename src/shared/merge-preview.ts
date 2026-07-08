/**
 * Merge-preview decision module (pure — the deep module) — issues 104, 105 & 106, ADR-0018.
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
 * Artifact supersession (issue 106). The install-artifact hygiene check (issue
 * 98 — a branch that would add a committed `node_modules` symlink or `dist`/`out`
 * build output to the default branch) is folded in PER OFFENDER: such a branch
 * badges `won't merge — adds install artifacts` with the offending paths, and
 * that verdict SUPERSEDES whatever textual verdict the sequence gave it (a lone
 * merge-tree run would call it `clean`, the worst badge lie). It is a per-branch
 * STABLE fact — a diff against the default tip, order-independent — because the
 * press-time hygiene refusal fires for ANY requested offender regardless of merge
 * order (issue 98). Two invariants keep the supersession honest: it touches only
 * the offender's OWN badge (innocent siblings keep their real `clean`/`conflicts`
 * verdicts — one bad branch never smears the batch), and it is overlaid AFTER the
 * textual sequence is decided, so later branches' `blocked behind NN` (computed
 * from the textual conflict positions) is unchanged by it. The batch-level
 * refusal (pressing Merge with any offender refuses EVERYTHING) stays a press-time
 * message, never a badge — the badges stay per-branch.
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
 * The raw outcome of recomputing a batch's whole preview (issues 105 & 106, from
 * the adapter), cached and stamped as one unit.
 *
 * `steps` is the merge-tree sequence (issue 105): one entry per candidate IN
 * MERGE ORDER, up to and INCLUDING the first conflict — a clean chain has one
 * `clean` per candidate; a conflict at index k gives `steps.length === k + 1`
 * with `steps[k]` the conflict and everything before it `clean`. Candidates after
 * the first conflict are deliberately NOT simulated — the real merge stops there.
 *
 * `artifactPaths` is the per-branch install-artifact hygiene fact (issue 106):
 * one entry PER CANDIDATE in merge order (parallel to the stamp's `branchTips`),
 * holding the ignored-artifact paths that branch would add to the default branch,
 * `[]` when it adds none. Unlike `steps`, it is computed for EVERY candidate —
 * including any past the sequence's first-conflict stop — because it is a diff
 * against the default tip, order-independent, and the press-time refusal fires
 * regardless of position. Optional so pre-106 cache fixtures (steps only) read as
 * "no offenders".
 */
export interface SequenceSimOutcome {
  steps: RawSimOutcome[];
  artifactPaths?: string[][];
}

/**
 * A settled (cacheable/displayable) verdict — the transient `recalculating`
 * excluded. `blocked` names the first-conflicting branch (issue 105): this
 * branch never merges because the sequence stops before it. `artifact` names the
 * ignored install-artifact paths this branch would add (issue 106): it would be
 * refused at the press-time hygiene preflight, so it "won't merge" regardless of
 * its textual merge outcome.
 */
export type SettledVerdict =
  | { kind: 'clean' }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'blocked'; behindIssueId: number }
  | { kind: 'artifact'; paths: string[] };

/** A branch's displayed merge-preview verdict, including the transient state. */
export type MergePreviewVerdict = SettledVerdict | { kind: 'recalculating' };

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
 * Overlay the per-branch install-artifact hygiene verdict on the textual
 * sequence verdicts (issue 106) — the supersession described in the module
 * header. For each candidate, a NON-EMPTY `artifactPaths[i]` replaces its
 * verdict with `{ kind: 'artifact', paths }`; everything else is returned
 * UNCHANGED. Kept a separate pass (rather than folded into `sequenceVerdicts`)
 * so the two invariants are structural: only offenders are touched (clean
 * siblings keep their real verdict), and the textual verdicts — including every
 * `blocked behind NN` — are already decided before the overlay, so the
 * supersession cannot move them. `artifactPaths` absent (a pre-106 cache) is a
 * no-op.
 */
export function applyArtifactVerdicts(
  verdicts: SettledVerdict[],
  artifactPaths: string[][] | undefined,
): SettledVerdict[] {
  if (artifactPaths === undefined) return verdicts;
  return verdicts.map((verdict, i) => {
    const paths = artifactPaths[i];
    return paths && paths.length > 0 ? { kind: 'artifact', paths } : verdict;
  });
}

/**
 * Decide every candidate's displayed verdict (issues 105 & 106). A FRESH cache (same
 * ordered batch, matching stamp) maps its settled sequence to per-branch
 * verdicts via `sequenceVerdicts`; anything else (cold, stale, or a changed
 * batch) shows `recalculating` for EVERY branch — never a stale verdict, and
 * never a mix of fresh-and-stale rows, because the sequence is recomputed as one
 * unit. `candidates` MUST already be ordered ascending by issue id (as
 * `mergeReadinessOnDisk(...).mergeable` supplies them).
 */
export function decidePreviews(input: {
  candidates: MergeCandidate[];
  currentStamp: PreviewStamp;
  cached: CachedPreview | null;
}): BranchPreview[] {
  const { candidates, currentStamp, cached } = input;
  if (candidates.length === 0) return [];
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
  const verdicts = applyArtifactVerdicts(
    sequenceVerdicts(candidates, cached.outcome),
    cached.outcome.artifactPaths,
  );
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
  if (a.kind === 'artifact' && b.kind === 'artifact') {
    return a.paths.length === b.paths.length && a.paths.every((p, i) => p === b.paths[i]);
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
  tone: 'clean' | 'conflicts' | 'blocked' | 'artifact' | 'recalculating';
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
 * before this one; `artifact` (issue 106) names the ignored install-artifact
 * paths the branch would add, the reason the press-time hygiene preflight refuses
 * it.
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
    case 'artifact':
      return {
        label:
          verdict.paths.length > 0
            ? `won't merge — adds install artifacts (${verdict.paths.join(', ')})`
            : "won't merge — adds install artifacts",
        title:
          `Merging this branch would add ignored install artifact(s) to the default branch` +
          (verdict.paths.length > 0 ? `: ${verdict.paths.join(', ')}` : '') +
          `. A committed node_modules is a self-referential symlink that corrupts the install ` +
          `on merge (issue 98), so pressing Merge refuses the whole batch — remove the ` +
          `artifact path(s) from the branch, then Merge again.`,
        tone: 'artifact',
      };
    case 'recalculating':
      return {
        label: 'recalculating…',
        title: 'The default branch or a finished branch moved — recomputing the merge preview.',
        tone: 'recalculating',
      };
  }
}
