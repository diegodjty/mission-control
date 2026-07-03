/**
 * afk-merge.sh output parser (pure) — issue 23.
 *
 * The Merge adapter (`run-merge.ts`) used to treat the script's exit 0 as "every
 * requested slug merged" and detect conflicts with a `/conflict/i` substring.
 * Both are wrong: `afk-merge.sh` exits 0 while *skipping* branches that are
 * missing ("no afk/<slug> — skipping") or already on main, so a stale-scan Merge
 * reported "Merged 1 branch" when zero merged and then mis-cleaned-up branches
 * it never touched. And the substring gave a generic result for preflight
 * refusals (dirty tree / wrong branch) instead of naming the real cause.
 *
 * This module turns the script's STRUCTURED output into facts the adapter keys
 * off — which slugs actually merged (its `=== summary ===` block) and, on a
 * non-zero exit, what actually went wrong (its `die`/conflict lines). Pure (no
 * git, no fs) so the parsing is unit-tested in isolation against the real
 * strings the script emits.
 *
 * The exact strings parsed here (verified against afk-merge.sh):
 *   summary rows:  "  <slug>   <label>   <result>"  where <result> is one of
 *                  "merged clean" | "merged (kept both: …)" | "already merged"
 *                  | "skip (no branch)" | "would merge (dry-run)"
 *   conflict:      "x <label>: conflict in afk/<slug> needs you — not a clean append:"
 *   dirty tree:    "x <label> has uncommitted changes in <path>. …"
 *   wrong branch:  "x <label> is on '<br>', not main. …"
 */

/** One row parsed from the script's `=== summary ===` block. */
export interface MergeSummaryRow {
  slug: string;
  label: string;
  /** The raw result phrase, e.g. "merged clean", "already merged", "skip (no branch)". */
  result: string;
  /** True only for a fresh integration THIS run ("merged clean" / "merged (kept both: …)"). */
  merged: boolean;
  /** A short, human-readable reason a row was NOT freshly merged (undefined when merged). */
  skipReason?: string;
}

export interface MergeSummary {
  /** Every parsed summary row, in the order the script printed them. */
  rows: MergeSummaryRow[];
  /** Distinct slugs freshly merged this run (across all repos/labels), first-seen order. */
  mergedSlugs: string[];
}

/**
 * Why a merge failed, read from the script's structured lines rather than a
 * loose substring — so the adapter can name the real cause.
 */
export type MergeFailureCause = 'conflict' | 'dirty-tree' | 'wrong-branch' | 'tool-error';

/** Strip ANSI SGR sequences (present only when the script writes to a TTY; absent when piped). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/** A result phrase names a fresh integration when it begins with the word "merged". */
function isFreshMerge(result: string): boolean {
  return /^merged\b/.test(result);
}

/** Map a non-merge result phrase to a short reason for the user-facing message. */
function reasonFor(result: string): string {
  if (/^skip \(no branch\)/.test(result)) return 'no branch';
  if (/^already merged/.test(result)) return 'already in main';
  if (/dry-run/.test(result)) return 'dry run';
  return result;
}

/**
 * Parse the script's `=== summary ===` block. Rows are printed with a two-space
 * indent as `<slug> <label> <result>` (padded with spaces); the result phrase
 * itself may contain spaces, so slug + label are the first two whitespace tokens
 * and the rest is the result. Only present on a clean (exit 0) run — a conflict
 * or preflight `die` exits before the summary, yielding no rows.
 */
export function parseMergeSummary(output: string): MergeSummary {
  const lines = stripAnsi(output).split('\n');
  const start = lines.findIndex((l) => l.trim() === '=== summary ===');
  const rows: MergeSummaryRow[] = [];
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      // Rows are indented with two spaces; the trailing "+ done." line and the
      // blank separators are not, so they naturally end the block.
      const m = line.match(/^ {2,}(\S+)\s+(\S+)\s+(\S.*?)\s*$/);
      if (!m) {
        if (line.trim() === '') continue; // tolerate a blank line inside the block
        break;
      }
      const [, slug, label, result] = m;
      const merged = isFreshMerge(result);
      rows.push({ slug, label, result, merged, skipReason: merged ? undefined : reasonFor(result) });
    }
  }

  const mergedSlugs: string[] = [];
  for (const row of rows) {
    if (row.merged && !mergedSlugs.includes(row.slug)) mergedSlugs.push(row.slug);
  }
  return { rows, mergedSlugs };
}

/**
 * Classify a non-zero-exit merge from the script's structured lines. Order is
 * most-specific-first, though the script's preflight only ever prints one cause
 * (it `die`s at the first failing guard), so these are effectively exclusive.
 */
export function classifyMergeFailure(output: string): MergeFailureCause {
  const clean = stripAnsi(output);
  if (/conflict in .* needs you/.test(clean)) return 'conflict';
  if (/is on .*, not main/.test(clean)) return 'wrong-branch';
  if (/has uncommitted changes/.test(clean)) return 'dirty-tree';
  return 'tool-error';
}
