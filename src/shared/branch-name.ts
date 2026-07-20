/**
 * Branch Name — pure suggestion + sanitization for the create-branch prompt
 * (issue 167's dialog, refined by issue 174).
 *
 * Two independent halves:
 *  - `suggestBranchName`: given the issue(s) about to Run/drain, derive a
 *    sensible default so the human never has to hand-craft a slug.
 *  - `checkBranchName`: turn whatever the human types (or the suggestion,
 *    unedited) into a git-legal ref plus a friendly rejection reason when one
 *    applies — so a typo, a stray space, or an already-existing branch name
 *    never reaches `git checkout -b` and surfaces as a raw `fatal:`.
 *
 * This module is PURE (no I/O, no git, no Electron): the sanitizer encodes the
 * subset of `git check-ref-format` rules relevant to a human-typed branch
 * name. The adapter (`git-worktree-adapter.ts`) still runs the real git
 * command, but only ever with a name this module has already validated.
 */
import type { BacklogIssue } from './backlog-model';

const MAX_LENGTH = 60;

/** Strip a PRD/ADR file name down to its theme slug: `PRD-ui-redesign.md` -> `ui-redesign`. */
function themeFromParent(parent: string): string {
  const base = parent.split('/').pop() ?? parent;
  const stem = base.replace(/\.md$/i, '');
  return stem
    .replace(/^(PRD|ADR)-/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Suggest a branch name from the issue(s) about to Run/drain (issue 174):
 *  - a single issue -> `feat/<id>-<slug>`.
 *  - multiple issues sharing one `## Parent` -> `feat/<theme>` from that
 *    PRD/ADR's own file name (the batch's theme, not any one issue's slug).
 *  - multiple issues with no shared parent -> `feat/<lowId>-<highId>-<slug>`,
 *    the id range plus the lowest issue's slug as the theme.
 * Always prefixed `feat/`. Empty input falls back to a generic `feat/branch`
 * rather than an empty suggestion.
 */
export function suggestBranchName(issues: BacklogIssue[]): string {
  if (issues.length === 0) return 'feat/branch';
  const sorted = [...issues].sort((a, b) => a.id - b.id);
  const lowest = sorted[0];

  if (sorted.length === 1) {
    return `feat/${lowest.id}-${lowest.slug}`;
  }

  const parents = new Set(sorted.map((i) => i.parent));
  if (parents.size === 1) {
    const [onlyParent] = parents;
    const theme = onlyParent !== null ? themeFromParent(onlyParent) : '';
    if (theme.length > 0) return `feat/${theme}`;
  }

  const highest = sorted[sorted.length - 1];
  return `feat/${lowest.id}-${highest.id}-${lowest.slug}`;
}

/** Split on `/`, drop empty/illegal path components (never lets `..`, a bare `.`, or an empty segment through). */
function cleanSegments(name: string): string {
  return name
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !/^\.+$/.test(seg))
    .join('/');
}

/**
 * Slugify raw input into a git-legal ref: lowercase, collapse whitespace/
 * underscores into hyphens, drop every character `git check-ref-format`
 * forbids (control chars, space, `~^:?*[\`, `@{`), collapse repeated
 * separators, and trim stray leading/trailing slashes/dots/hyphens. Never
 * throws; the empty string is a valid (if useless) result, caught by
 * `checkBranchName`.
 */
export function sanitizeBranchName(raw: string): string {
  const lowered = (typeof raw === 'string' ? raw : '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const stripped = lowered
    .replace(/@\{/g, '-')
    .replace(/[^a-z0-9/.-]+/g, '')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/');
  const segmented = cleanSegments(stripped);
  return segmented
    .replace(/^[/.-]+|[/.-]+$/g, '')
    .replace(/\.lock$/i, '')
    .slice(0, MAX_LENGTH)
    .replace(/[/.-]+$/g, '');
}

/** The result of checking a candidate branch name before it reaches git. */
export interface BranchNameCheck {
  /** The git-legal ref this input sanitizes to (may be `''` if nothing legal survives). */
  sanitized: string;
  /** True when `raw` was already exactly `sanitized` — nothing needed correcting. */
  wasClean: boolean;
  /** Non-null when `sanitized` cannot be used as-is; a friendly, non-git message. */
  error: string | null;
}

/**
 * Check a raw, human-typed branch name: sanitize it, then validate the result
 * — empty after sanitizing, or a collision with an existing branch — into a
 * friendly inline message instead of a `git checkout -b` `fatal:`. Callers use
 * `sanitized` as the actual `git` argument only when `error` is null.
 */
export function checkBranchName(
  raw: string,
  existingBranches: readonly string[] = [],
): BranchNameCheck {
  const sanitized = sanitizeBranchName(raw);
  const wasClean = sanitized === raw;

  if (sanitized === '') {
    return {
      sanitized,
      wasClean,
      error: 'Enter a branch name — letters, numbers, and hyphens.',
    };
  }
  if (existingBranches.includes(sanitized)) {
    return {
      sanitized,
      wasClean,
      error: `Branch "${sanitized}" already exists — pick another name.`,
    };
  }
  return { sanitized, wasClean, error: null };
}
