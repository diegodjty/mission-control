/**
 * Launcher model (PURE) — the front door's decisions (issue 81, ADR-0016).
 *
 * Every empty Window IS the Launcher: *what are we doing?* This module holds
 * the pure pieces behind its three fully-wired actions:
 *
 *  - **Quick fix** — turn one sentence into a well-formed STANDALONE issue
 *    (`## Source`, no `## Parent`) in a project's workbench backlog: the next
 *    free issue number, the `NN-slug.md` file name, and the full markdown
 *    content. The content round-trips through `backlog-model`'s `buildBacklog`
 *    as `standalone: true, status: 'open'` — the same shape the afk-issue-
 *    runner skill picks up as fallthrough work.
 *  - **Continue** — the truthful one-line state for a recent project ("3 open
 *    · 1 parked awaiting you"), and the recency ordering of the project list.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a
 * value, never a throw. The file writes / registry reads live in the main
 * process; the UI in `renderer/src/Launcher.tsx`.
 */

/** Matches issue files (`NN-slug.md`); everything else is not an issue. */
const ISSUE_FILE = /^(\d+)-.+\.md$/;

/**
 * The next free issue number given a backlog directory's file names: one past
 * the highest `NN` prefix present (gaps are never reused — numbers are
 * history), or 1 for an empty/issue-less directory. Non-issue names
 * (CONFIG.md, completions/, dotfiles) are ignored.
 */
export function nextIssueNumber(fileNames: readonly string[]): number {
  let max = 0;
  for (const name of fileNames) {
    const match = ISSUE_FILE.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

/** Issue numbers are zero-padded to at least two digits (`05`, `112`). */
export function padIssueNumber(id: number): string {
  return String(id).padStart(2, '0');
}

/**
 * A file-name slug for a quick-fix sentence: lowercased, non-alphanumerics
 * collapsed to `-`, capped at a few words so the file name stays scannable.
 * A sentence with nothing usable degrades to `quick-fix`, never ''.
 */
export function quickFixSlug(sentence: string): string {
  const words = (typeof sentence === 'string' ? sentence : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  const slug = words.join('-').slice(0, 48).replace(/-+$/, '');
  return slug.length > 0 ? slug : 'quick-fix';
}

/** The `NN-slug.md` file name for a quick-fix issue. */
export function quickFixFileName(id: number, sentence: string): string {
  return `${padIssueNumber(id)}-${quickFixSlug(sentence)}.md`;
}

export interface QuickFixIssueInput {
  /** The issue number this file claims (from `nextIssueNumber`). */
  id: number;
  /** The user's one sentence, verbatim (newlines are collapsed). */
  sentence: string;
  /** The creation date, `YYYY-MM-DD`, for the `## Source` line. */
  date: string;
}

/**
 * The full markdown content of a quick-fix issue: `status: open`, no
 * dependencies, a `## Source` section naming the Launcher and date, and NO
 * `## Parent` — which is exactly what makes it standalone (backlog-model) and
 * afk-eligible as fallthrough work (the skill's eligibility rule).
 */
export function buildQuickFixIssue(input: QuickFixIssueInput): string {
  const sentence = (typeof input.sentence === 'string' ? input.sentence : '')
    .replace(/\s+/g, ' ')
    .trim();
  const num = padIssueNumber(input.id);
  return [
    '---',
    'status: open',
    'depends_on: []',
    '---',
    '',
    `# ${num} — ${sentence}`,
    '',
    '## Source',
    '',
    `Launcher quick fix, ${input.date}`,
    '',
    '## What to build',
    '',
    sentence,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The one-sentence request above is implemented and verified per the afk-issue-runner verify gate.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Continue — truthful one-line project state + recency ordering
// ---------------------------------------------------------------------------

/** A backlog's status counts, as the Launcher list carries them. */
export interface BacklogCounts {
  open: number;
  wip: number;
  done: number;
}

/**
 * The one-line state a Continue row shows for a project. Truthful and quiet:
 * only what is non-zero, with parked HITL items (awaiting the human) called
 * out explicitly; a fully-done backlog says so; an empty one says so.
 */
export function projectStateLine(counts: BacklogCounts, parked: number): string {
  const open = Math.max(0, counts?.open ?? 0);
  const wip = Math.max(0, counts?.wip ?? 0);
  const done = Math.max(0, counts?.done ?? 0);
  const parks = Math.max(0, parked ?? 0);

  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (wip > 0) parts.push(`${wip} wip`);
  if (parks > 0) parts.push(`${parks} parked awaiting you`);
  if (parts.length > 0) return parts.join(' · ');
  if (done > 0) return `all ${done} done`;
  return 'empty backlog';
}

/** The subset of a Launcher project row the ordering needs. */
export interface RecencySortable {
  /** ISO-8601 stamp of the most recent backlog/Receipt change, or null. */
  lastActivity: string | null;
  /** Display label — the deterministic tiebreak. */
  label: string;
}

/**
 * Order Continue's project list most-recently-active first; projects with no
 * observable activity sort last, alphabetically. Stable and pure — returns a
 * new array, never mutates the input.
 */
export function sortLauncherProjects<T extends RecencySortable>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    const aStamp = a.lastActivity ?? '';
    const bStamp = b.lastActivity ?? '';
    if (aStamp !== bStamp) return aStamp < bStamp ? 1 : -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}
