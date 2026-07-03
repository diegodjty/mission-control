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
 *   wrong branch:  "x <label> is on '<br>', not <default> (the default branch). …"
 *                  (the default branch is detected, not hardcoded `main` — issue 27)
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
  // Branch-agnostic (issue 27): the script now names the DETECTED default branch
  // ("not master", "not trunk", …), not the old literal "not main".
  if (/is on '[^']*', not \S+/.test(clean)) return 'wrong-branch';
  if (/has uncommitted changes/.test(clean)) return 'dirty-tree';
  return 'tool-error';
}

/** The current-vs-expected branch a wrong-branch preflight refusal named. */
export interface WrongBranch {
  /** The branch the repo is actually checked out on. */
  current: string;
  /** The default branch afk-merge.sh wanted it on (detected, not hardcoded). */
  expected: string;
}

/**
 * Pull the checked-out branch and the expected default branch out of the
 * script's wrong-branch `die` line (issue 27), so the adapter's user-facing
 * message can name the ACTUAL default branch ("not on 'master'") instead of the
 * old, wrong hardcoded "not on main". Returns null when the line isn't present.
 */
export function parseWrongBranch(output: string): WrongBranch | null {
  // Branch names may contain dots (`release-1.2`) but never a TRAILING one, so
  // this stops before the sentence-ending "." in the legacy "not main." phrasing
  // and before the " (the default branch)" suffix in the current one.
  const m = /is on '([^']*)', not ([^\s.]+(?:\.[^\s.]+)*)/.exec(stripAnsi(output));
  return m ? { current: m[1], expected: m[2] } : null;
}

/** The partial-merge facts recovered from a conflict-exit run (issue 24). */
export interface PartialMergeState {
  /**
   * Slugs the script merged CLEANLY into `main` before it hit the conflict —
   * parsed from the per-slug `+ <label>: merged afk/<slug> cleanly` /
   * `… (kept both …)` lines it prints as it goes (the `=== summary ===` block is
   * never reached on a conflict exit). First-seen order, deduped across repos.
   */
  mergedBeforeConflict: string[];
  /** The slug whose merge conflicted (the one that stopped the run), or null. */
  conflictedSlug: string | null;
  /** The files git reported as conflicting under the conflicted slug. */
  conflictingFiles: string[];
}

/**
 * Recover the partial-merge truth from a conflict-exit run. `afk-merge.sh`
 * merges each requested slug into `main` and commits it before moving to the
 * next, so the FIRST non-append conflict `exit 1`s with EARLIER slugs already on
 * `main` and `main` left mid-merge — but before the `=== summary ===` block is
 * printed, so `parseMergeSummary` sees nothing. This reads the per-slug progress
 * lines instead, so the adapter can report "A merged, B conflicted, main is
 * mid-merge" rather than the wrong "nothing merged".
 *
 * Order-independent by design: the adapter joins the script's stdout and stderr
 * as two blocks (the `+ merged` lines land on stdout, the `x conflict` line on
 * stderr, the `  - <file>` list back on stdout), so their interleaving is lost.
 * Each fact is matched wherever it appears rather than by sequence.
 */
export function parsePartialMerge(output: string): PartialMergeState {
  const lines = stripAnsi(output).split('\n');
  const mergedBeforeConflict: string[] = [];
  let conflictedSlug: string | null = null;
  const conflictingFiles: string[] = [];
  for (const line of lines) {
    const merged = /^\+\s+\S+:\s+merged afk\/(\S+)\s+(?:cleanly|\(kept both)/.exec(line);
    if (merged) {
      if (!mergedBeforeConflict.includes(merged[1])) mergedBeforeConflict.push(merged[1]);
      continue;
    }
    const conflict = /^x\s+\S+:\s+conflict in afk\/(\S+)\s+needs you/.exec(line);
    if (conflict) {
      conflictedSlug = conflict[1];
      continue;
    }
    // Conflict file listing: `    - <file>` (4-space indent + dash). The union
    // fallback annotates unresolved files as `<file> (union did not parse …)` —
    // strip that trailing parenthetical so we keep just the path.
    const file = /^ {4}- (.+?)(?:\s+\(.*\))?\s*$/.exec(line);
    if (file) {
      const path = file[1].trim();
      if (path && !conflictingFiles.includes(path)) conflictingFiles.push(path);
    }
  }
  return { mergedBeforeConflict, conflictedSlug, conflictingFiles };
}
