/**
 * Ghost-commit guard (PURE) — issue 153, the defense-in-depth companion of
 * issue 195.
 *
 * On 2026-07-21, draining the HITL walkthrough 183 reproducibly ghost-deleted
 * four core files (CONTEXT.md, electron.vite.config.ts, tsconfig.node.json,
 * vitest.e2e.config.ts): a stale worktree the drain never should have cut still
 * had those tracked files missing from its working tree, and Mission Control's
 * `git add -A` auto-commit swept the deletions onto the branch as a "completion"
 * commit. Issue 195 stops the drain from cutting that worktree in the first
 * place; THIS guard is the belt-and-braces backstop that would have blocked the
 * ghost-deletion regardless of how the worktree came to be:
 *
 *   **No worker commit may delete tracked files it did not create.**
 *
 * The auto-commit compares the staged tree against the branch tip it is
 * committing onto (`git diff --cached`). A staged deletion (`D`) there removes a
 * file that was tracked at that tip — i.e. one that existed before the Worker's
 * session and that the Worker therefore did not create. A rename (`R`) or copy
 * (`C`) is a MOVE, not a deletion of a file the Worker didn't create, so it is
 * allowed; a genuinely new file (`A`) or an edit (`M`) is obviously fine. Only
 * pure deletions of pre-existing tracked files carry the ghost-deletion
 * signature, and the guard refuses exactly those — leaving the work uncommitted
 * (the Run reads "commit failed") for the human to inspect rather than silently
 * corrupting the branch.
 *
 * PURE: no I/O. The adapter runs `git diff --cached --name-status` and hands the
 * raw output here; any input yields a value, never a throw.
 */

/** How many deleted paths to name in the refusal message before eliding. */
const MAX_LISTED = 8;

/**
 * The tracked files a staged commit would DELETE, parsed from
 * `git diff --cached --name-status` output. Only pure deletions (status `D`)
 * count: a rename (`R100\told\tnew`) / copy (`C…`) is a move and is excluded,
 * an add (`A`) / modify (`M`) is not a deletion. Returns the deleted paths
 * ascending, deduped. Tolerant: non-string / empty / malformed input yields
 * an empty list.
 */
export function stagedDeletions(nameStatus: unknown): string[] {
  if (typeof nameStatus !== 'string' || nameStatus.trim() === '') return [];
  const deleted = new Set<string>();
  for (const rawLine of nameStatus.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const code = (parts[0] ?? '').trim();
    // A pure deletion is exactly `D`. `R`/`C` (rename/copy, with a similarity
    // score suffix) are moves — the delete-half is not a ghost deletion, so
    // they never trip the guard.
    if (code !== 'D') continue;
    const path = (parts[1] ?? '').trim();
    if (path.length > 0) deleted.add(path);
  }
  return [...deleted].sort();
}

/**
 * The human-facing refusal message when a commit would delete tracked files the
 * Worker did not create (issue 153). Names up to `MAX_LISTED` of them, then
 * elides the rest, so the message stays a one-liner even for a large sweep.
 * Returns '' for an empty list — the caller only builds this when there IS a
 * deletion to refuse.
 */
export function ghostCommitRefusal(slug: string, deletions: readonly string[]): string {
  if (!Array.isArray(deletions) || deletions.length === 0) return '';
  const named = deletions.slice(0, MAX_LISTED).join(', ');
  const rest = deletions.length - MAX_LISTED;
  const list = rest > 0 ? `${named}, +${rest} more` : named;
  const noun = deletions.length === 1 ? 'a tracked file' : `${deletions.length} tracked files`;
  return (
    `Refused to commit issue ${slug}: the worktree would delete ${noun} it did not ` +
    `create (${list}). This is the ghost-deletion signature (issue 153) — the commit was ` +
    `blocked and the work left uncommitted for you to inspect.`
  );
}
