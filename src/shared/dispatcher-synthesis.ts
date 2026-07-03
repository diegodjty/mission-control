/**
 * Cross-Run synthesis helpers (PURE) — issue 38.
 *
 * The Dispatcher's reason-for-being beyond relaying (PRD-dispatcher, user
 * stories 9–11): looking ACROSS the stream of Completion blocks and spotting
 * what no single block says on its own —
 *
 *   (a) **doc-drift** — a block that reports a PRD/reality contradiction, which
 *       the Dispatcher surfaces and turns into an approval-gated plan-amendment
 *       proposal (the PRD is the human's to change — afk-issue-runner §4);
 *   (b) **cross-Run patterns** — several Runs touching the SAME seam (a file, a
 *       named seam like "the merge seam", a shared identifier) or a recurring
 *       class of finding;
 *   (c) **consolidation** — related findings from multiple Runs folded into one
 *       summary instead of left as raw per-Run cards for the user to re-derive.
 *
 * Most of that judgement is the LLM Dispatcher session's job (verified via the
 * QA walkthrough). What lives here is the small set of PURE, deterministic
 * primitives behind it, shaped data-in / structure-out so they unit-test without
 * the LLM, Electron, or git:
 *
 *   - `extractDocDrift` / `groupDocDrift` — pull the doc-drift findings out of the
 *     captured records and group co-referencing ones;
 *   - `detectCrossRunOverlap` — find seams (file / named-seam / identifier) that
 *     ≥2 distinct Runs touched, from the records' structured text;
 *   - `synthesizeAcrossRuns` + `renderCrossRunSynthesis` — the consolidated
 *     summary as one structure / one plain-text block;
 *   - `proposeDocDriftAmendment` — the approval-gated `amend-plan` activity.
 *
 * These REUSE the Run-log records (issue 34/42) directly — `RunLogRecord`
 * (extends `CompletionRecord`, carrying `docDrift` and `detail`) is assignable to
 * the `RunFinding` input, so nothing here re-parses or duplicates them.
 *
 * PURE: no I/O, no Electron, no LLM. Unit-testable in isolation and safe to
 * share across main/renderer.
 */
import { recordActivity, type DispatcherActivity } from './dispatcher-proposal';

/**
 * The structural subset of a captured Run record this module reads. Every field
 * is a WHITELISTED structured field from the completion parser (issue 34/42) —
 * there is deliberately no raw-Pane-scroll field. A `RunLogRecord` (which
 * extends `CompletionRecord`) satisfies this shape, so callers pass their Run-log
 * records straight in without adapting them.
 */
export interface RunFinding {
  /** Stable per-Run id (the PTY session id). */
  id: string;
  issueId: number | null;
  /** The `NN — slug` descriptor from the block heading, when known. */
  issue: string | null;
  whatChanged: string | null;
  bookkeeping: string | null;
  verified: string | null;
  docDrift: string | null;
  detail: string | null;
}

/** Which Run a finding came from, carried through every synthesis output. */
export interface RunRef {
  runId: string;
  issueId: number | null;
  issue: string | null;
}

/** One Run's doc-drift finding: the Run it came from plus the drift text. */
export interface DocDriftEntry extends RunRef {
  /** The block's "Doc drift" body, trimmed (never a "none" marker). */
  text: string;
}

/**
 * A group of doc-drift findings that co-reference the same seam — several Runs
 * reporting drift about the same file/PRD section, which is a stronger signal
 * than one isolated flag (a recurring contradiction, not a one-off).
 */
export interface DocDriftGroup {
  /** The shared seam token the grouped findings all mention. */
  seam: string;
  entries: DocDriftEntry[];
}

/**
 * A seam (a file path, a named "… seam", or a shared code identifier) that ≥2
 * distinct Runs touched — the cross-Run pattern the Dispatcher surfaces ("these
 * three Runs all hit the merge seam — consider a hardening pass").
 */
export interface OverlapGroup {
  /** The normalised seam token shared across the Runs. */
  seam: string;
  /** The Runs that touched it, in first-seen order, de-duped by Run. */
  runs: RunRef[];
}

/** The consolidated cross-Run picture: doc-drift findings + shared-seam overlaps. */
export interface CrossRunSynthesis {
  docDrift: DocDriftEntry[];
  docDriftGroups: DocDriftGroup[];
  overlaps: OverlapGroup[];
}

/** A "Doc drift" body that means "nothing to report" rather than a real finding. */
const NONE_MARKER = /^(none|n\/a|nothing|no drift|—|-)\.?$/i;

/** Reference to the Run a finding came from, for output rows. */
function refOf(record: RunFinding): RunRef {
  return { runId: record.id, issueId: record.issueId, issue: record.issue };
}

/**
 * Whether a record actually reports doc-drift: a non-empty "Doc drift" body that
 * isn't a "none"/"n/a" marker. The completion block almost always carries a Doc
 * drift line (afk-issue-runner §5), overwhelmingly "none" — so filtering the
 * markers is what keeps the Dispatcher from flagging every Run.
 */
export function reportsDocDrift(record: Pick<RunFinding, 'docDrift'>): boolean {
  const body = record.docDrift?.trim();
  return !!body && body.length > 0 && !NONE_MARKER.test(body);
}

/**
 * Extract the real doc-drift findings from a set of captured records, in input
 * order. Records with no drift (or a "none" marker) are dropped, so the result is
 * exactly the contradictions the Dispatcher should surface.
 */
export function extractDocDrift(records: readonly RunFinding[]): DocDriftEntry[] {
  const out: DocDriftEntry[] = [];
  for (const record of records) {
    if (!reportsDocDrift(record)) continue;
    out.push({ ...refOf(record), text: record.docDrift!.trim() });
  }
  return out;
}

// A file/path token: at least one `/`, so a bare word or a version number
// ("4.8") can't masquerade as a path. Matches `src/shared/foo.ts`, `docs/PRD.md`.
const FILE_PATH = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g;
// A backtick-wrapped token — a seam only when it looks path-ish or file-ish
// (contains a `/` or a `.ext`), so an inline `code` word isn't a false seam.
const BACKTICK = /`([^`]+)`/g;
// A named seam the way the PRD phrases it: "the merge seam", "integration
// seams". The negative lookahead rejects hyphen/word continuations so a compound
// like "seam-worthy" is not mistaken for a seam named "… seam".
const SEAM_PHRASE = /\b([A-Za-z][A-Za-z0-9_-]*)[ \t]+seams?(?![\w-])/gi;

/** Normalise a seam token: strip wrapping punctuation/backticks, lowercase. */
function normSeam(token: string): string {
  return token
    .trim()
    .replace(/^[`'"(<[]+/, '')
    .replace(/[`'")>\].,;:]+$/, '')
    .toLowerCase();
}

/** Does a backtick-wrapped token look like a file/path (vs an inline code word)? */
function looksFileish(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z][A-Za-z0-9]*$/.test(token.trim());
}

/**
 * Extract the seam tokens mentioned in a piece of text: file paths, file-ish
 * backticked tokens, and named "… seam" phrases. De-duped, normalised. This is
 * the shared primitive behind overlap detection and doc-drift grouping —
 * "same file / same seam / same finding class" all reduce to a shared seam token.
 */
export function extractSeams(text: string | null | undefined): string[] {
  if (!text) return [];
  const seams = new Set<string>();
  for (const m of text.matchAll(FILE_PATH)) seams.add(normSeam(m[0]));
  for (const m of text.matchAll(BACKTICK)) {
    if (looksFileish(m[1])) seams.add(normSeam(m[1]));
  }
  for (const m of text.matchAll(SEAM_PHRASE)) seams.add(normSeam(`${m[1]} seam`));
  seams.delete('');
  return [...seams];
}

/** The union of seams a single record touches, across all its structured fields. */
export function recordSeams(record: RunFinding): string[] {
  const seams = new Set<string>();
  for (const field of [
    record.whatChanged,
    record.bookkeeping,
    record.verified,
    record.docDrift,
    record.detail,
  ]) {
    for (const seam of extractSeams(field)) seams.add(seam);
  }
  return [...seams];
}

/**
 * Build seam → the distinct Runs that touched it, preserving first-seen order for
 * both the seams and the Runs within each. Shared by overlap detection and
 * doc-drift grouping. `seamsOf` picks which text a given pass keys on (all fields
 * for overlaps; just the drift body for drift groups).
 */
function seamsToRuns(
  records: readonly RunFinding[],
  seamsOf: (record: RunFinding) => string[],
): Map<string, RunRef[]> {
  const bySeam = new Map<string, RunRef[]>();
  const seen = new Map<string, Set<string>>();
  for (const record of records) {
    const ref = refOf(record);
    for (const seam of seamsOf(record)) {
      let runs = bySeam.get(seam);
      let ids = seen.get(seam);
      if (!runs || !ids) {
        runs = [];
        ids = new Set<string>();
        bySeam.set(seam, runs);
        seen.set(seam, ids);
      }
      if (!ids.has(record.id)) {
        ids.add(record.id);
        runs.push(ref);
      }
    }
  }
  return bySeam;
}

/**
 * Detect cross-Run overlap: seams that ≥2 DISTINCT Runs touched. A single Run
 * mentioning a seam in several fields counts once. Sorted most-shared first (then
 * by seam name) so the strongest pattern leads. This is the pure signal behind
 * "several Runs touching the same seam / a recurring finding class".
 */
export function detectCrossRunOverlap(records: readonly RunFinding[]): OverlapGroup[] {
  const bySeam = seamsToRuns(records, recordSeams);
  const groups: OverlapGroup[] = [];
  for (const [seam, runs] of bySeam) {
    if (runs.length >= 2) groups.push({ seam, runs });
  }
  return groups.sort(
    (a, b) => b.runs.length - a.runs.length || a.seam.localeCompare(b.seam),
  );
}

/**
 * Group doc-drift findings that co-reference the same seam — two Runs both
 * flagging drift about `docs/PRD.md` is a recurring contradiction worth one
 * consolidated amendment, not two. Only groups of ≥2 findings are returned (an
 * isolated flag is already in `extractDocDrift`). A finding that mentions several
 * seams can appear in more than one group.
 */
export function groupDocDrift(entries: readonly DocDriftEntry[]): DocDriftGroup[] {
  const bySeam = new Map<string, DocDriftEntry[]>();
  const order: string[] = [];
  for (const entry of entries) {
    for (const seam of extractSeams(entry.text)) {
      let bucket = bySeam.get(seam);
      if (!bucket) {
        bucket = [];
        bySeam.set(seam, bucket);
        order.push(seam);
      }
      bucket.push(entry);
    }
  }
  return order
    .map((seam) => ({ seam, entries: bySeam.get(seam)! }))
    .filter((group) => group.entries.length >= 2)
    .sort((a, b) => b.entries.length - a.entries.length || a.seam.localeCompare(b.seam));
}

/**
 * The full consolidated picture across a set of captured Runs: the doc-drift
 * findings (flat + grouped by co-referenced seam) and the shared-seam overlaps.
 * One structure the Dispatcher (or the UI) can render instead of the user
 * re-deriving it from N raw cards.
 */
export function synthesizeAcrossRuns(records: readonly RunFinding[]): CrossRunSynthesis {
  const docDrift = extractDocDrift(records);
  return {
    docDrift,
    docDriftGroups: groupDocDrift(docDrift),
    overlaps: detectCrossRunOverlap(records),
  };
}

/** Whether a synthesis has anything worth surfacing (drift or an overlap). */
export function hasSynthesis(synthesis: CrossRunSynthesis): boolean {
  return synthesis.docDrift.length > 0 || synthesis.overlaps.length > 0;
}

/** `issue NN` label for a Run ref, falling back to the descriptor or the Run id. */
function runLabel(ref: RunRef): string {
  if (ref.issueId !== null) return `issue ${String(ref.issueId).padStart(2, '0')}`;
  if (ref.issue) return ref.issue;
  return `run ${ref.runId}`;
}

/** Comma list of the Runs in a group, e.g. "issues 04, 09, 12". */
function runsList(runs: readonly RunRef[]): string {
  return runs.map(runLabel).join(', ');
}

/**
 * Surface one doc-drift finding as the plain-language line the Dispatcher relays
 * before proposing the amendment — names the Run and quotes the contradiction.
 */
export function describeDocDrift(entry: DocDriftEntry): string {
  return `Doc-drift flagged by ${runLabel(entry)}: ${entry.text}`;
}

/**
 * Turn a doc-drift finding into the approval-gated plan-amendment PROPOSAL
 * (`amend-plan`, always `needs-approval` — the PRD is the human's to change). The
 * activity id is keyed to the Run so the same finding can't queue two proposals.
 */
export function proposeDocDriftAmendment(entry: DocDriftEntry): DispatcherActivity {
  return recordActivity(`amend-plan:${entry.runId}`, 'amend-plan');
}

/**
 * Render the consolidated synthesis as ONE plain-text summary (user story 11):
 * the doc-drift findings then the shared seams, instead of N raw per-Run cards.
 * Empty string when there is nothing to synthesize, so the caller can skip it.
 */
export function renderCrossRunSynthesis(synthesis: CrossRunSynthesis): string {
  if (!hasSynthesis(synthesis)) return '';
  const lines: string[] = ['Cross-Run synthesis:'];

  if (synthesis.docDrift.length > 0) {
    lines.push(`Doc-drift flagged by ${synthesis.docDrift.length} Run(s):`);
    for (const entry of synthesis.docDrift) {
      lines.push(`- ${runLabel(entry)}: ${entry.text}`);
    }
    for (const group of synthesis.docDriftGroups) {
      lines.push(
        `  (recurring around ${group.seam}: ${runsList(group.entries)})`,
      );
    }
  }

  if (synthesis.overlaps.length > 0) {
    lines.push('Shared seams across Runs:');
    for (const group of synthesis.overlaps) {
      lines.push(`- ${group.seam} — ${runsList(group.runs)}`);
    }
  }

  return lines.join('\n');
}
