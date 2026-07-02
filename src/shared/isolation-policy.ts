/**
 * Isolation Policy — the pure encoding of ADR-0002's isolation lifecycle.
 *
 * Mission Control owns isolation, keyed on concurrency: a **lone Run works
 * directly on `main`** (solo, no worktree); the moment **2+ Runs** need to be
 * live at once it enables parallel mode (`issues/.afk-parallel`) and gives each
 * Run its own git worktree on an `afk/NN-slug` branch — the worktree tax is
 * paid only when actually running in parallel.
 *
 * This module is PURE (no git, no fs, no Electron): it turns "the set of Runs
 * that currently need isolation" into a *desired state* (`decideIsolation`) and
 * turns the gap between the on-disk state and that desired state into a list of
 * *commands* (`reconcile`) for the Git/Worktree Adapter to execute. Keeping the
 * decision here — free of I/O — is what makes it unit-testable in isolation
 * (see PRD "Testing Decisions"). The adapter (main process) does the real git.
 *
 * What counts as a Run "needing isolation" is the CALLER's policy, not this
 * module's: it passes the set of Runs whose worktrees should currently exist
 * (a live Run, plus — once issue 08 lands — a finished Run whose branch is not
 * yet merged, so its work is never removed out from under a pending Merge).
 * This module only counts the set it is given: `>= 2` ⇒ parallel, `<= 1` ⇒ solo.
 */

/** One Run that currently needs a placement decision. */
export interface IsolationRun {
  issueId: number;
  /**
   * The full `NN-slug` stem (e.g. `03-run-issue-in-pane`), matching
   * afk-merge.sh's branch/worktree key so a Merge (issue 08) can find them.
   */
  slug: string;
}

/** Where a Run does its work. */
export type Placement =
  | { kind: 'main' }
  | { kind: 'worktree'; branch: string };

export interface PlacedRun {
  issueId: number;
  slug: string;
  placement: Placement;
}

export interface IsolationDecision {
  /** True when 2+ Runs are concurrent ⇒ parallel mode (`issues/.afk-parallel`). */
  parallel: boolean;
  /** Placement per Run, ascending by issueId. */
  placements: PlacedRun[];
}

/** The `afk/NN-slug` branch a Run's worktree lives on. */
export function branchFor(slug: string): string {
  return `afk/${slug}`;
}

/**
 * The `NN-slug` for an `afk/NN-slug` branch, or null for any other branch — the
 * inverse of `branchFor`, used to recognise our own worktrees on disk.
 */
export function worktreeSlugFrom(branch: string): string | null {
  const prefix = 'afk/';
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : null;
}

/**
 * Decide the desired isolation state for a set of Runs.
 *
 * `<= 1` Run ⇒ solo: parallel disabled, the lone Run (if any) works on `main`.
 * `>= 2` Runs ⇒ parallel: parallel enabled, every Run gets its own worktree on
 * an `afk/NN-slug` branch. Deterministic (sorted by issueId) so re-deciding the
 * same input yields the same decision.
 */
export function decideIsolation(runs: IsolationRun[]): IsolationDecision {
  const sorted = [...runs].sort((a, b) => a.issueId - b.issueId);
  const parallel = sorted.length >= 2;
  const placements: PlacedRun[] = sorted.map((run) => ({
    issueId: run.issueId,
    slug: run.slug,
    placement: parallel
      ? { kind: 'worktree', branch: branchFor(run.slug) }
      : { kind: 'main' },
  }));
  return { parallel, placements };
}

/** The isolation-relevant facts the adapter reads off disk before reconciling. */
export interface IsolationState {
  /** Is `issues/.afk-parallel` present? */
  parallel: boolean;
  /** The `NN-slug`s that currently have a worktree registered. */
  worktreeSlugs: string[];
}

/** A single side-effecting step for the Git/Worktree Adapter to execute. */
export type IsolationCommand =
  | { type: 'enable-parallel' }
  | { type: 'disable-parallel' }
  | { type: 'create-worktree'; issueId: number; slug: string; branch: string }
  | { type: 'remove-worktree'; slug: string; branch: string };

/**
 * Diff the current on-disk state against the desired decision and emit the
 * commands that close the gap. Pure and idempotent: if the disk already matches
 * the decision it returns `[]`, so the caller can reconcile on every change.
 *
 * Ordering is chosen so the disk is never in a nonsensical intermediate state:
 *   1. enable parallel first (so worktrees are created under an enabled mode),
 *   2. remove worktrees that are no longer wanted,
 *   3. create newly-wanted worktrees,
 *   4. disable parallel last (only after its worktrees are gone).
 *
 * Removing a worktree drops only the *worktree*, never its branch — unmerged
 * work stays on `afk/NN-slug` for the Merge step (issue 08) to integrate.
 */
export function reconcile(
  current: IsolationState,
  desired: IsolationDecision,
): IsolationCommand[] {
  const commands: IsolationCommand[] = [];

  const desiredWorktrees = desired.placements.filter(
    (p): p is PlacedRun & { placement: { kind: 'worktree'; branch: string } } =>
      p.placement.kind === 'worktree',
  );
  const desiredSlugs = new Set(desiredWorktrees.map((p) => p.slug));
  const currentSlugs = new Set(current.worktreeSlugs);

  if (desired.parallel && !current.parallel) {
    commands.push({ type: 'enable-parallel' });
  }

  for (const slug of [...current.worktreeSlugs].sort()) {
    if (!desiredSlugs.has(slug)) {
      commands.push({ type: 'remove-worktree', slug, branch: branchFor(slug) });
    }
  }

  for (const placed of desiredWorktrees) {
    if (!currentSlugs.has(placed.slug)) {
      commands.push({
        type: 'create-worktree',
        issueId: placed.issueId,
        slug: placed.slug,
        branch: placed.placement.branch,
      });
    }
  }

  if (!desired.parallel && current.parallel) {
    commands.push({ type: 'disable-parallel' });
  }

  return commands;
}
