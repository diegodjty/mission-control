/**
 * Receipt parser (PURE) — frontmatter-first, block-parser fallback (issue 55,
 * ADR-0013).
 *
 * A Worker's exit leaves a **Receipt** file (`issues/completions/NN-slug.md`):
 * YAML frontmatter declaring the machine-facing facts (`issue`, `slug`,
 * `outcome: completed | needs-verification | blocked`, `finished` ISO-8601)
 * followed by the verbatim final block the Worker emitted. This module turns
 * that file's text into the structured record the Dispatcher feed consumes.
 *
 * **Declared facts win.** When the frontmatter carries a valid `outcome`,
 * classification is a field read — no heading regexes, no heuristics — and a
 * body whose prose *looks* like a different shape cannot override it. When the
 * frontmatter is missing or unreadable, we degrade to the existing §5-block
 * parser (`parseCompletionBlock`) over the body, and the record flags the
 * outcome as `inferred` so downstream can tell a declaration from a guess.
 *
 * Tolerant by contract: any input (empty, malformed YAML, junk, non-strings)
 * yields a record — never a throw. ANSI stripping is deliberately NOT
 * load-bearing here: Receipts are files, not PTY scroll (the fallback path
 * reuses `parseCompletionBlock`, whose stripping is a harmless no-op on clean
 * file text).
 *
 * PURE: no file/network/Electron I/O, so it is unit-testable in isolation and
 * safe to share across main/renderer. The capture edge (watching
 * `issues/completions/`, debounce, dedupe — issue 56) lives in an adapter;
 * this only turns text into structure.
 */
import { parseCompletionBlock, type RunOutcome } from './completion-parser';

/** Whether the record's `outcome` was declared in frontmatter or inferred. */
export type OutcomeSource = 'declared' | 'inferred';

/**
 * The structured record parsed out of a Receipt file. A superset of the
 * completion-parser's record shape (same section/detail fields), plus the
 * frontmatter's declared facts and the declared-vs-inferred flag.
 */
export interface ReceiptRecord {
  /** Display descriptor (`NN — <slug>`), from declared fields or the heading. */
  issue: string | null;
  /** The numeric issue id: declared `issue` field, else the body's heading. */
  issueId: number | null;
  /** The issue slug: declared `slug` field, else the body's heading slug. */
  slug: string | null;
  /** The declared `finished` timestamp (ISO-8601), or null when not declared. */
  finished: string | null;
  /** The classified outcome (declared when possible, else inferred). */
  outcome: RunOutcome;
  /** How `outcome` was determined: a frontmatter read, or the block parser. */
  outcomeSource: OutcomeSource;
  /** The "What changed" section body, or null when absent. */
  whatChanged: string | null;
  /** The "Try it yourself" section body, or null when absent. */
  tryIt: string | null;
  /** The "Verified" section body, or null when absent. */
  verified: string | null;
  /** The "Bookkeeping" section body, or null when absent. */
  bookkeeping: string | null;
  /** The "Doc drift" section body, or null when absent. */
  docDrift: string | null;
  /** The free-form report body for non-completed shapes (see completion-parser). */
  detail: string | null;
}

// A Receipt's frontmatter fence: `---` on the first line, then the raw block,
// then a closing `---`. Same shape the backlog model accepts for issue files.
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// The three outcomes a Worker can declare (ADR-0013). `unknown` is never
// declared — it is what the parser reports, not what a Worker claims.
const DECLARED_OUTCOMES: readonly RunOutcome[] = ['completed', 'needs-verification', 'blocked'];

/** Split the frontmatter block from the body; null when there is no fence. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * Read one `key: value` line out of a raw frontmatter block, tolerating
 * surrounding whitespace and single/double quotes. Line-based on purpose: one
 * unreadable line must not take down the readable ones (never-throw contract).
 */
function frontmatterValue(frontmatter: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(frontmatter);
  if (!match) return null;
  const raw = match[1].trim();
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
  return unquoted.length > 0 ? unquoted : null;
}

/** The declared outcome, when the frontmatter carries a valid one. */
function declaredOutcome(frontmatter: string): RunOutcome | null {
  const raw = frontmatterValue(frontmatter, 'outcome');
  if (raw === null) return null;
  const normalised = raw.toLowerCase();
  return DECLARED_OUTCOMES.find((o) => o === normalised) ?? null;
}

/** Parse a declared numeric issue id; null when absent or non-numeric. */
function declaredIssueId(frontmatter: string): number | null {
  const raw = frontmatterValue(frontmatter, 'issue');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Recover the slug from a parsed record's `NN — <slug>` descriptor, if any. */
function slugFromDescriptor(issue: string | null): string | null {
  if (!issue) return null;
  const match = /^\d+\s*[—–-]\s*(.+)$/.exec(issue);
  return match ? match[1].trim() : null;
}

/** Build the `NN — <slug>` display descriptor from whatever parts exist. */
function descriptor(issueId: number | null, slug: string | null): string | null {
  if (issueId !== null && slug) return `${issueId} — ${slug}`;
  if (issueId !== null) return String(issueId);
  return null;
}

/**
 * Parse a Receipt file's text into a structured record. Frontmatter-first:
 * a valid declared `outcome` classifies the record outright; otherwise the
 * §5-block parser runs over the body and the record is flagged `inferred`.
 * Any input yields a record — never a throw.
 */
export function parseReceipt(input: unknown): ReceiptRecord {
  if (typeof input !== 'string') {
    return inferredRecord('');
  }

  const split = splitFrontmatter(input);
  if (split === null) {
    // No frontmatter fence at all — pure block-parser fallback.
    return inferredRecord(input);
  }

  const outcome = declaredOutcome(split.frontmatter);
  const issueId = declaredIssueId(split.frontmatter);
  const slug = frontmatterValue(split.frontmatter, 'slug');
  const finished = frontmatterValue(split.frontmatter, 'finished');

  if (outcome === null) {
    // Fence present but no valid outcome declared — infer from the body, while
    // keeping any readable declared identity fields (they are still facts).
    const fallback = inferredRecord(split.body);
    const mergedId = issueId ?? fallback.issueId;
    const mergedSlug = slug ?? fallback.slug;
    return {
      ...fallback,
      issueId: mergedId,
      slug: mergedSlug,
      finished,
      issue: descriptor(mergedId, mergedSlug) ?? fallback.issue,
    };
  }

  // Declared path: classification is a field read. The block parser still
  // extracts the body's sections/detail, but its own outcome guess is ignored —
  // a body that *looks* like a different shape does not override the declaration.
  const block = parseCompletionBlock(split.body);
  const finalId = issueId ?? block.issueId;
  const finalSlug = slug ?? slugFromDescriptor(block.issue);
  return {
    issue: descriptor(finalId, finalSlug),
    issueId: finalId,
    slug: finalSlug,
    finished,
    outcome,
    outcomeSource: 'declared',
    whatChanged: block.whatChanged,
    tryIt: block.tryIt,
    verified: block.verified,
    bookkeeping: block.bookkeeping,
    docDrift: block.docDrift,
    detail: block.detail,
  };
}

/** A record built entirely by the fallback block parser over the given body. */
function inferredRecord(body: string): ReceiptRecord {
  const block = parseCompletionBlock(body);
  const slug = slugFromDescriptor(block.issue);
  return {
    issue: block.issue,
    issueId: block.issueId,
    slug,
    finished: null,
    outcome: block.outcome,
    outcomeSource: 'inferred',
    whatChanged: block.whatChanged,
    tryIt: block.tryIt,
    verified: block.verified,
    bookkeeping: block.bookkeeping,
    docDrift: block.docDrift,
    detail: block.detail,
  };
}
