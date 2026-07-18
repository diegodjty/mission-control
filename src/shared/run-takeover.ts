/**
 * Take-over — the pure decision behind "grab a live headless Run mid-flight, or
 * reopen a finished one post-mortem, as an interactive Pane" (issue 144, PRD
 * headless-lane story 8/10).
 *
 * A drain Run executes headless (issue 139): a `claude -p` child watched through
 * a read-only Feed. Take-over flips that ONE Run from Feed to Pane in place — it
 * kills the headless child and re-attaches interactively to the SAME claude
 * session (`claude --resume <captured-session-id>`) in the SAME working
 * directory. The Run keeps its identity: same issue, same drain generation, same
 * slot, same cwd. Everything the drain coordinator sees (issue id + running
 * status) is unchanged, so the slot count and the issue guard are preserved by
 * construction — the coordinator can't tell a Feed Run from a Pane Run, it only
 * sees an occupied slot for that issue.
 *
 * Two entry points, one mechanism:
 *   - **live** — the Run is still `running`: kill the child, resume interactively.
 *     It keeps occupying its drain slot until it ends (PRD story 9), so the drain
 *     schedules around it exactly as before.
 *   - **post-mortem** — the Run is `finished`: there is no live child to kill; a
 *     Pane resumes the session purely for interrogation (PRD story 10). Its issue
 *     is already `done`, so the resumed Run still reads `finished` (done wins in
 *     run-state) — no slot is taken, no new Run is created, the backlog is not
 *     touched.
 *
 * Pure (no I/O, no Electron, no React) so the "is take-over offered, and what
 * does the resumed target look like" decision is unit-testable in isolation; the
 * renderer applies the resulting target to its tracked Run and the session
 * manager spawns `resolveResumeRunCommand`.
 */
import type { RunTarget } from './ipc-contract';
import type { RunStatus } from './run-state';

/** Which flavour of take-over an affordance offers, or null when none is. */
export type TakeoverKind = 'live' | 'post-mortem';

/**
 * Whether — and how — a Run may be taken over into a Pane, given its derived
 * status and whether a claude session id was captured for it.
 *
 * Requires BOTH a captured claude session id (there is nothing to `--resume`
 * without one — a headless Run whose `system`/`init` event hasn't landed yet
 * cannot be taken over) AND a headless Run (a Run already running as a Pane is
 * the thing take-over produces; offering it again is meaningless). Only two
 * statuses qualify:
 *   - `running`  ⇒ `live` — grab the wheel mid-flight.
 *   - `finished` ⇒ `post-mortem` — reopen for interrogation.
 * A `blocked` / `stopped` / `parked` Run is deliberately NOT offered here: a
 * post-mortem resume of one (issue still `wip`) would flip it back to `running`
 * and wrongly re-occupy a drain slot — those are handled by the existing
 * dismiss/discard/attention paths, not by resume.
 */
export function takeoverKindFor(
  status: RunStatus,
  headless: boolean | undefined,
  claudeSessionId: string | null | undefined,
): TakeoverKind | null {
  if (headless !== true) return null;
  if (claudeSessionId === null || claudeSessionId === undefined || claudeSessionId === '') {
    return null;
  }
  if (status === 'running') return 'live';
  if (status === 'finished') return 'post-mortem';
  return null;
}

/** Whether a take-over/resume affordance should be offered for this Run. */
export function canTakeover(
  status: RunStatus,
  headless: boolean | undefined,
  claudeSessionId: string | null | undefined,
): boolean {
  return takeoverKindFor(status, headless, claudeSessionId) !== null;
}

/**
 * The Run target that resumes an interactive Pane on `claudeSessionId`, derived
 * from the headless Run's own target. Everything that gives the Run its identity
 * is preserved verbatim — issue id, file name, title, cwd (`projectPath`), and
 * the workbench paths — so the resumed Pane runs in the SAME working directory
 * and stays the SAME tracked Run. Only two things change:
 *   - `headless` is cleared (false) — the tile now hosts a Pane, not a Feed.
 *   - `resume` names the session to re-attach to, so the session manager spawns
 *     `claude --resume <id>` instead of a fresh Worker seed.
 *
 * The `claudeSessionId` must be present (guard with `canTakeover` first); an
 * empty id would resume nothing.
 */
export function takeoverTarget(target: RunTarget, claudeSessionId: string): RunTarget {
  return {
    ...target,
    headless: false,
    resume: { claudeSessionId },
  };
}
