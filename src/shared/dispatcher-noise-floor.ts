/**
 * Dispatcher noise floor (PURE) — issue 47, ADR-0012.
 *
 * The dogfood run flooded the user with non-blocking noise: ≈15 boot-screen
 * "unclassifiable" Runs, dozens of garbled "consolidate?" proposals, and
 * doc-drift flagged on "none". ADR-0012 raises the bar for what the Dispatcher
 * surfaces AT ALL. Routine facts are fine as passive notes, but anything
 * inferred/speculative must clear a HIGH CONFIDENCE bar — **if in doubt, stay
 * silent** (the user can always ask).
 *
 * This module is that confidence bar, expressed as three small PURE predicates
 * the surfacing pipeline gates on. The raw detectors stay where they are
 * (`parseCompletionBlock`, `detectCrossRunOverlap`, `reportsDocDrift`); this only
 * decides whether a given detection has earned a surfaced line:
 *
 *   - `isRealCapture`   — (a) does a captured block deserve to become a Run in
 *                         the log at all, or is it an empty / boot-screen /
 *                         unclassifiable capture that should be dropped silently?
 *   - `isRealDocDrift`  — (b) does a "Doc drift" body report a real contradiction,
 *                         or is it a "none"/empty marker that surfaces nothing?
 *                         (re-exported from `dispatcher-synthesis` under the
 *                         noise-floor vocabulary — same predicate, one source.)
 *   - `isStrongOverlap` — (c) is a cross-Run seam overlap a STRONG concrete signal
 *                         (≥2 distinct Runs genuinely touching the same file/seam),
 *                         or a weak/boilerplate one that should stay silent?
 *
 * PURE: no I/O, no Electron, no LLM, no timers. Unit-testable in isolation
 * (including the exact dogfood noise cases) and safe to share across main/renderer.
 */
import type { CompletionRecord } from './completion-parser';
import type { OverlapGroup } from './dispatcher-synthesis';

/**
 * (b) Whether a "Doc drift" body reports a REAL contradiction worth surfacing —
 * a non-empty body that isn't a "none"/"n/a" marker. This is the exact predicate
 * behind the "doc-drift-on-none surfaces nothing" fix; re-exported here so the
 * noise-floor gate reads as one vocabulary, without duplicating the logic.
 */
export { reportsDocDrift as isRealDocDrift } from './dispatcher-synthesis';

/** The structural subset of a captured record the capture gate reads. */
type CaptureShape = Pick<
  CompletionRecord,
  'outcome' | 'whatChanged' | 'tryIt' | 'verified' | 'bookkeeping' | 'docDrift'
>;

/**
 * (a) Whether a captured block is a REAL capture that should become a Run in the
 * log (and therefore a card / a note / a needs-a-look item), or noise to drop
 * silently.
 *
 * A capture that parsed to a real terminal outcome — `completed`, `blocked`, or
 * `needs-verification` (HITL) — always surfaces: those shapes carry their
 * substance by construction (completion sections, a blocker, verification steps).
 *
 * An `unknown` capture is the noise risk (the ≈15 boot-screen Runs). It surfaces
 * ONLY when it still parsed genuine completion-block SUBSTANCE — at least one
 * recognised section body (What changed / Try it / Verified / Bookkeeping / Doc
 * drift). A genuinely empty capture, or raw boot-screen / terminal scroll that
 * matched no section, parses to an `unknown` with no sections and is dropped. This
 * deliberately NARROWS issue 43's "convey unknowns as needs-a-look": a real
 * unknown with substance is still conveyed; an empty one is silence.
 *
 * Note the `detail` (raw block body) is deliberately NOT treated as substance — a
 * boot screen has a non-empty body too. Only PARSED section content counts, which
 * is exactly what distinguishes a malformed-but-real block from terminal noise.
 */
export function isRealCapture(record: CaptureShape): boolean {
  if (record.outcome !== 'unknown') return true;
  return hasParsedSubstance(record);
}

/** Whether any recognised completion-block section body is present and non-blank. */
function hasParsedSubstance(record: CaptureShape): boolean {
  return [
    record.whatChanged,
    record.tryIt,
    record.verified,
    record.bookkeeping,
    record.docDrift,
  ].some((field) => !!field && field.trim().length > 0);
}

// Manifest / lock / config files quoted structurally by most completion blocks
// (test commands, bookkeeping boilerplate) rather than as genuine shared work.
const GENERIC_SEAM_EXACT = new Set<string>([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.node.json',
  'readme.md',
  '.gitignore',
  'context.md',
  'issues/config.md',
]);

/**
 * Whether a seam is generic BOILERPLATE — referenced by (nearly) every block for
 * structural reasons (a Parent link, a doc-drift line, test commands, the skill
 * quote), not because ≥2 Runs genuinely worked the same surface. An overlap on
 * these is a false signal, so it is held below the confidence bar.
 */
function isGenericSeam(seam: string): boolean {
  if (GENERIC_SEAM_EXACT.has(seam)) return true;
  // PRD / plan docs — every in-batch block links its Parent PRD and carries a Doc
  // drift line that names it; a shared mention is boilerplate, not shared work.
  if (/(?:^|\/)prd[\w-]*\.md$/.test(seam)) return true;
  // ADR docs are cited far more often than co-edited.
  if (seam.includes('/adr/')) return true;
  // The afk-issue-runner skill file is quoted by most completion blocks.
  if (seam.includes('afk-issue-runner')) return true;
  return false;
}

/**
 * Whether a seam token is CONCRETE enough to anchor an overlap: a real file path
 * (contains a `/`), a file name (has a `.ext`), or a named "… seam" phrase. Guards
 * against a bare junk word ever being treated as a shared seam.
 */
function looksConcrete(seam: string): boolean {
  return seam.includes('/') || /\.[a-z0-9]+$/i.test(seam) || / seam$/.test(seam);
}

/**
 * (c) Whether a cross-Run overlap is a STRONG, concrete signal that has earned a
 * single passive note: ≥2 DISTINCT Runs genuinely touching the SAME concrete file
 * or seam. A single-Run "overlap", a boilerplate seam (the PRD, a config/manifest,
 * the skill file), or a non-concrete junk token all fall below the bar and surface
 * nothing — killing the per-tick "consolidate?" firehose. Deduping a surfaced seam
 * so it is noted at most once is the caller's concern (a per-seam guard); this is
 * the confidence gate on whether it is worth noting in the first place.
 */
export function isStrongOverlap(group: OverlapGroup): boolean {
  return group.runs.length >= 2 && looksConcrete(group.seam) && !isGenericSeam(group.seam);
}
