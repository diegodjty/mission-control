/**
 * Window bootstrap decision (issue 14) — the pure "which repo, if any, does a
 * freshly-loaded Project Window open?" rule.
 *
 * A new Window's renderer, on mount, asks the backend for its registry view and
 * must decide what to manage. There are exactly three outcomes and NO fourth:
 *
 *   1. **open** — the opener queued a target repo for this Window (`pendingOpen`);
 *      open exactly that repo. This is the "Open in new Window" path.
 *   2. **reattach** — no queued target, but this Window already owns a repo
 *      (e.g. a re-render / registry refresh after it claimed one); keep showing
 *      it.
 *   3. **empty** — no queued target and no owned repo; open NO Project and show
 *      an empty "open or choose a Project" state.
 *
 * The bug this fixes: the old bootstrap fell through to opening `process.cwd()`
 * (the app's own repo) whenever there was no pending target — which happened
 * both for a plain new Window AND whenever a racing/duplicate `ProjectList`
 * read had already consumed the pending path. The result was a phantom claim on
 * the mission-control repo and an "already open in another Window" error. This
 * decision never resolves to the backend cwd: the app's own repo is opened only
 * when the user explicitly enters that path (which arrives as a real
 * `pendingOpen`/open request, not as this empty fallthrough).
 *
 * Pure (no React, no Electron, no fs) so the decision is unit-testable in
 * isolation; the renderer's bootstrap effect just executes the result.
 */

/** The registry facts a Window has on bootstrap (from a `ProjectList` read). */
export interface WindowBootstrapInput {
  /**
   * A path (repo or workbench dir) the opener queued for this Window to
   * auto-open, or null. Resolved to a Project identity when opened.
   */
  pendingOpen: string | null;
  /** The key of the Project this Window already owns, or null if none yet. */
  activeProjectKey: string | null;
}

/** What the Window should do on bootstrap. */
export type WindowBootstrapDecision =
  /** Open (resolve + register + claim) the queued target path. */
  | { kind: 'open'; path: string }
  /** Re-attach to the Project this Window already owns (by key). */
  | { kind: 'reattach'; key: string }
  /** Open no Project; show the empty "open a Project" state. */
  | { kind: 'empty' };

/**
 * Decide what a freshly-loaded Window opens. A queued target wins; failing
 * that, an already-owned Project; failing that, nothing (empty state). Never
 * the backend cwd — a blank/whitespace `pendingOpen` is treated as "no
 * target", not as "open here".
 */
export function decideWindowBootstrap(
  input: WindowBootstrapInput,
): WindowBootstrapDecision {
  const pending = input.pendingOpen?.trim();
  if (pending) return { kind: 'open', path: pending };
  if (input.activeProjectKey !== null) {
    return { kind: 'reattach', key: input.activeProjectKey };
  }
  return { kind: 'empty' };
}
