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
  /**
   * The code repo this Run targets (issue 72, ADR-0015): a workbench Project's
   * issues may declare different `repo:` targets, and isolation keys on
   * concurrency PER REPO — two concurrent Runs in different repos don't contend
   * and need no mutual worktrees. Absent for a legacy Project (every Run in
   * the one repo), where the caller supplies the repo out-of-band as before.
   */
  repoPath?: string;
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
 * The commit message Mission Control uses when it auto-commits a finished
 * isolated Run's worktree onto its `afk/NN-slug` branch (issue 15). Identifies
 * the issue by its number and descriptive slug, e.g. a `04-tracer-bullet` slug
 * yields `afk: complete issue 04 — tracer-bullet`. Falls back gracefully for a
 * slug without the conventional `NN-` prefix.
 */
export function commitMessageForRun(slug: string): string {
  const match = /^(\d+)-(.*)$/.exec(slug);
  if (match) return `afk: complete issue ${match[1]} — ${match[2]}`;
  return `afk: complete issue — ${slug}`;
}

/** Options for a single isolation decision. */
export interface DecideIsolationOptions {
  /**
   * Whether the target can host git worktrees. Default `true` — a real git
   * repo, decided by concurrency as always. `false` marks an **unisolatable
   * target** (ADR-0017): a repo-less project's workspace root, where Runs
   * scaffold code but there is no repo to cut worktrees from. An unisolatable
   * target stays SOLO no matter the concurrency — `parallel` is false and every
   * Run is placed on the shared tree (`main`), so `reconcile` emits no worktree
   * commands. Such Runs still serialize (the coordinator runs them one at a
   * time because they mutate one un-isolated tree), but that scheduling is the
   * caller's; this module only refuses to cut worktrees where none can exist.
   */
  isolatable?: boolean;
}

/**
 * Decide the desired isolation state for a set of Runs.
 *
 * `<= 1` Run ⇒ solo: parallel disabled, the lone Run (if any) works on `main`.
 * `>= 2` Runs ⇒ parallel: parallel enabled, every Run gets its own worktree on
 * an `afk/NN-slug` branch. Deterministic (sorted by issueId) so re-deciding the
 * same input yields the same decision.
 *
 * When the target is **unisolatable** (`options.isolatable === false`, ADR-0017)
 * the concurrency check is skipped entirely: the decision is always solo, so a
 * repo-less project's workspace root never has worktrees cut from it.
 */
export function decideIsolation(
  runs: IsolationRun[],
  options: DecideIsolationOptions = {},
): IsolationDecision {
  const isolatable = options.isolatable ?? true;
  const sorted = [...runs].sort((a, b) => a.issueId - b.issueId);
  const parallel = isolatable && sorted.length >= 2;
  const placements: PlacedRun[] = sorted.map((run) => ({
    issueId: run.issueId,
    slug: run.slug,
    placement: parallel
      ? { kind: 'worktree', branch: branchFor(run.slug) }
      : { kind: 'main' },
  }));
  return { parallel, placements };
}

/** One repo's slice of a per-repo isolation decision (issue 72, ADR-0015). */
export interface RepoIsolationGroup {
  /** The code repo these Runs execute in. */
  repoPath: string;
  /** The Runs targeting this repo, ascending by issueId. */
  runs: IsolationRun[];
  /** The isolation decision for THIS repo's concurrency alone. */
  decision: IsolationDecision;
}

/** Options for a per-repo isolation decision. */
export interface DecideIsolationByRepoOptions {
  /**
   * Target paths that cannot host git worktrees (ADR-0017): a repo-less
   * project's workspace root, where Runs scaffold code but there is no repo to
   * cut worktrees from. Any group keyed on one of these SERIALIZES — it stays
   * solo on the shared tree no matter how many Runs it holds, emitting no
   * worktree commands — while groups keyed on real repos isolate exactly as
   * before. This is the single new rule ADR-0017 adds to the per-target keying.
   */
  unisolatablePaths?: Iterable<string>;
}

/**
 * Decide isolation PER REPO (issue 72, ADR-0015): group the Runs by the repo
 * each targets and make the concurrency decision independently for each group.
 * Two concurrent Runs in different repos don't contend — each is the lone Run
 * in its own repo and stays solo on that repo's default branch, no worktree —
 * while 2+ Runs in the SAME repo isolate into worktrees exactly as
 * `decideIsolation` always decided. A Run without a `repoPath` falls into the
 * caller-supplied `defaultRepoPath` group (the legacy single-repo behavior).
 * Groups are returned sorted by repoPath; deterministic, like the per-repo
 * decisions themselves.
 *
 * A group whose key is an **unisolatable target** (ADR-0017 — listed in
 * `options.unisolatablePaths`, i.e. a repo-less project's workspace root) is the
 * one exception: it stays solo regardless of concurrency (no worktrees), so two
 * no-repo Runs serialize against each other on the shared workspace-root tree,
 * while a no-repo group and a real-repo group — different keys — still run
 * concurrently. Real-repo groups are unchanged.
 */
export function decideIsolationByRepo(
  runs: IsolationRun[],
  defaultRepoPath: string,
  options: DecideIsolationByRepoOptions = {},
): RepoIsolationGroup[] {
  const unisolatable = new Set(options.unisolatablePaths ?? []);
  const byRepo = new Map<string, IsolationRun[]>();
  for (const run of runs) {
    const repo = run.repoPath ?? defaultRepoPath;
    const group = byRepo.get(repo);
    if (group) group.push(run);
    else byRepo.set(repo, [run]);
  }
  return [...byRepo.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([repoPath, group]) => {
      const sorted = [...group].sort((a, b) => a.issueId - b.issueId);
      const decision = decideIsolation(sorted, {
        isolatable: !unisolatable.has(repoPath),
      });
      return { repoPath, runs: sorted, decision };
    });
}

/**
 * The set of Runs that need isolation once `added` joins the ones already
 * live — the concurrency input the *manual* "▶ Run" path feeds to isolation,
 * exactly as the drain builds its own set (issue 20). Deduped by issueId (so
 * re-triggering an already-live issue doesn't double-count it and inflate the
 * concurrency), then sorted ascending — the same normalization `decideIsolation`
 * expects. Isolation keys on the *resulting concurrency*, never on which button
 * started the Run, so this is the single place both entry points describe "who
 * is live now".
 */
export function isolationRunSetWith(
  active: IsolationRun[],
  added: IsolationRun,
): IsolationRun[] {
  const set = active.some((r) => r.issueId === added.issueId)
    ? [...active]
    : [...active, added];
  return set.sort((a, b) => a.issueId - b.issueId);
}

/**
 * The isolation decision for the Run set that results from adding one more Run
 * to those already live — the manual "▶ Run" path's entry into the very same
 * concurrency-keyed reconcile the drain uses (issue 20). Starting a second Run
 * while one is active flips the whole set to parallel, so BOTH the already-live
 * Run and the new one get a worktree (neither stays on the shared `main`
 * checkout); adding to an empty set keeps the lone Run solo on `main`. A
 * convenience over `decideIsolation(isolationRunSetWith(...))` so the manual
 * path's decision is exercised — and unit-tested — on its own terms.
 */
export function decideIsolationWith(
  active: IsolationRun[],
  added: IsolationRun,
): IsolationDecision {
  return decideIsolation(isolationRunSetWith(active, added));
}

/**
 * When `applyIsolation` rejects — a git/worktree error, a disk error, a partial
 * reconcile that threw mid-apply — may the caller fall back to running on the
 * shared `main` checkout instead?
 *
 * Only for a LONE Run. The moment 2+ Runs would be live at once, `main` is the
 * exact shared-checkout collision isolation exists to prevent (ADR-0002):
 * silently draining every startable Run onto `main` runs multiple agents on top
 * of each other in one working tree. So `<= 1` ⇒ true (a single Run may still
 * proceed solo on `main`); `>= 2` ⇒ false — the caller must STOP and surface the
 * error for the user to retry/resolve rather than degrade to concurrent `main`.
 *
 * `runCount` is the number of Runs that would end up live on `main` if the
 * fallback proceeded, which the caller counts for its own entry point (issue 28).
 */
export function canFallBackToMain(runCount: number): boolean {
  return runCount <= 1;
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
 *
 * Removals are scoped to the batch's OWN Runs (issue 28). A worktree on disk
 * whose slug is not among this decision's Runs is a LEFTOVER — a finished,
 * still-unmerged Run from a previous batch whose work a pending Merge needs. It
 * is left intact (worktree AND branch), and its presence keeps `.afk-parallel`
 * on: a fresh solo Run must never tear down another batch's worktrees or pull
 * the parallel marker out from under branches still waiting to merge. So the
 * only worktree reconcile removes is one whose Run is in THIS set but has
 * dropped back to `main` (a 2→1 concurrency fall).
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
  // The slugs THIS batch owns — every Run in the decision, whether it lands on
  // `main` or in a worktree. Any on-disk worktree outside this set is a leftover
  // and must be preserved (not this batch's to remove).
  const ownedSlugs = new Set(desired.placements.map((p) => p.slug));

  if (desired.parallel && !current.parallel) {
    commands.push({ type: 'enable-parallel' });
  }

  const removed = new Set<string>();
  for (const slug of [...current.worktreeSlugs].sort()) {
    if (ownedSlugs.has(slug) && !desiredSlugs.has(slug)) {
      commands.push({ type: 'remove-worktree', slug, branch: branchFor(slug) });
      removed.add(slug);
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

  // Disable parallel only once NO worktree remains on disk. Leftover worktrees
  // (from a pending Merge) keep the marker on, so an unrelated solo Run never
  // disables parallel mode out from under branches still awaiting merge.
  const worktreesRemain =
    desiredWorktrees.length > 0 || [...currentSlugs].some((s) => !removed.has(s));
  if (!desired.parallel && current.parallel && !worktreesRemain) {
    commands.push({ type: 'disable-parallel' });
  }

  return commands;
}
