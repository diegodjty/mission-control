/**
 * Stray-Receipt adoption decision (PURE) — issue 62, ADR-0013.
 *
 * The second failed walkthrough's root cause: a Worker (an LLM — occasionally
 * misplacing a file is a *when*, not an *if*) wrote its Receipt into the MAIN
 * checkout's `issues/completions/` instead of its own worktree's copy. One stray
 * untracked file made `main` "dirty", the merge preflight refused every
 * subsequent merge, and the drain looked broken.
 *
 * The posture change this module encodes: **Mission Control repairs known
 * artifacts and halts only on genuinely unknown state.**
 *
 *   - A dirty path under `issues/completions/` is a KNOWN artifact (a Receipt —
 *     the one file kind Workers write outside their code scope, ingested from
 *     both locations already). It is ADOPTED: auto-committed with a dedicated
 *     `chore: adopt stray Receipt(s) — …` message, then the merge proceeds.
 *   - Anything dirty OUTSIDE that set is UNKNOWN state and keeps issue 59's
 *     behavior: a truthful "uncommitted changes on main: <paths>" halt, never
 *     auto-committed. The adopted-path set is exactly `issues/completions/` —
 *     deliberately NOT generalized to other paths.
 *
 * The git side effects (status read, add, commit) live in the Git/Worktree
 * Adapter (`main/git-worktree-adapter.ts`); this module is the pure, unit-tested
 * decision. PURE: no I/O, no Electron — safe to share across main/renderer.
 */

/** The one adoptable directory (repo-relative, with trailing slash). */
export const RECEIPT_DIR = 'issues/completions/';

/** The dirty working-tree paths split into the adopt set and the foreign rest. */
export interface AdoptionSplit {
  /** Dirty paths under `issues/completions/` — safe to auto-commit (adopt). */
  adopt: string[];
  /**
   * Dirty paths OUTSIDE the adoptable set — unknown state that keeps the
   * issue-59 halt ("uncommitted changes on main: <paths>"), never auto-committed.
   */
  foreign: string[];
}

/** Is this repo-relative path a file under `issues/completions/`? */
function isReceiptPath(path: string): boolean {
  return path.startsWith(RECEIPT_DIR) && path.length > RECEIPT_DIR.length;
}

/**
 * Split the dirty paths (from `git status --porcelain`) into the Receipts to
 * adopt and the foreign rest. `ownReceiptPath` — the Run's OWN expected Receipt
 * (`issues/completions/NN-slug.md`) on the SOLO finished path — is excluded from
 * BOTH sets: issue 59's contract is that the ONE run commit captures the
 * deliverable, the `done` flip AND the Run's own Receipt, so it is not a stray
 * to adopt separately; and it is certainly not an unknown-state halt cause.
 * Deduped, first-seen order preserved.
 */
export function splitAdoptablePaths(
  dirtyPaths: readonly string[],
  ownReceiptPath: string | null = null,
): AdoptionSplit {
  const adopt: string[] = [];
  const foreign: string[] = [];
  for (const path of dirtyPaths) {
    if (path === ownReceiptPath) continue;
    if (isReceiptPath(path)) {
      if (!adopt.includes(path)) adopt.push(path);
    } else if (path !== RECEIPT_DIR && !foreign.includes(path)) {
      foreign.push(path);
    }
  }
  return { adopt, foreign };
}

/**
 * The dedicated commit message an adoption lands under — greppable, and clearly
 * distinct from a Run's own `afk: complete issue NN — …` commit, so the history
 * shows exactly which files were repaired rather than authored.
 */
export function adoptionCommitMessage(paths: readonly string[]): string {
  return `chore: adopt stray Receipt(s) — ${paths.join(', ')}`;
}
