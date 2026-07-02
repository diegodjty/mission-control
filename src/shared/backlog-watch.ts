/**
 * Backlog watch policy — the pure decisions behind live Map updates (issue 05).
 *
 * The main-process adapter (`backlog-watcher.ts`) owns the OS file watcher and
 * the debounce timer; this module owns the two decisions that don't touch I/O
 * and are worth testing in isolation:
 *
 *   1. `isRelevantChange` — given a raw `fs.watch` event's filename, is it worth
 *      re-reading the backlog at all? (Filters out noise so we don't reload on,
 *      say, a `.DS_Store` touch.)
 *   2. `backlogChanged` — after a re-read, did anything the Map actually renders
 *      change? If not, we skip pushing a redundant update to the renderer.
 *
 * Pure (no fs/Electron imports) so it is unit-testable — see PRD Testing
 * Decisions.
 */
import type { Backlog, BacklogIssue } from './backlog-model';

/**
 * Should an `fs.watch` event on the `issues/` directory trigger a re-read?
 *
 * `fs.watch` reports a `filename` that may be null on some platforms/events —
 * when we can't tell what changed, we err toward reloading (return true). We
 * reload for any `.md` file (issue files *and* `CONFIG.md`, since the active
 * PRD affects in-batch classification) and ignore everything else (editor swap
 * files, `.DS_Store`, etc.).
 */
export function isRelevantChange(filename: string | null | undefined): boolean {
  if (filename === null || filename === undefined) return true;
  return filename.toLowerCase().endsWith('.md');
}

/** The fields the Map renders for a single issue — the diff surface. */
function issueSignature(issue: BacklogIssue): string {
  return JSON.stringify([
    issue.id,
    issue.status,
    issue.title,
    issue.hitl,
    issue.inBatch,
    issue.standalone,
    issue.parent,
    issue.source,
    issue.dependsOn,
    issue.body,
  ]);
}

/**
 * Did a re-read of the backlog change anything the Map shows? Used to suppress
 * redundant renderer pushes when a watch event fires but nothing meaningful
 * changed on disk (e.g. a metadata-only touch, or a write that left content
 * identical).
 */
export function backlogChanged(prev: Backlog | null, next: Backlog | null): boolean {
  if (prev === next) return false; // both null, or same reference
  if (prev === null || next === null) return true;
  if (prev.activePrd !== next.activePrd) return true;
  if (prev.issues.length !== next.issues.length) return true;
  for (let i = 0; i < next.issues.length; i++) {
    if (issueSignature(prev.issues[i]) !== issueSignature(next.issues[i])) return true;
  }
  return false;
}
