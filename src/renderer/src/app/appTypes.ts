import type { RunTarget } from '../../../shared/ipc-contract';

/**
 * What the Planning view (issue 83) is planning: the chosen project's two
 * planning roots plus its label. Per-Project state — cleared on a switch.
 */
export interface PlanningTargetState {
  workbenchDir: string;
  repoPath: string;
  label: string;
}

/**
 * An Inbox click-through's focus request (issue 80): the thing the clicked
 * item referenced, to be surfaced once its project is open — the issue is
 * selected in the Map; the file reference shows as a quiet dismissible line.
 */
export interface InboxFocus {
  project: string;
  issueId: number | null;
  fileRef: string | null;
}

/**
 * One Run the UI is tracking: its target plus the observable facts
 * (`deriveRunStatus` in run-state turns these into running/finished/blocked/
 * stopped). `stopSignal` is bumped to kill its session on demand.
 */
export interface TrackedRun {
  target: RunTarget;
  sessionAlive: boolean;
  stoppedByUser: boolean;
  stopSignal: number;
  /**
   * The drain generation (`drainSeq`) that started this Run, or null for a
   * manual "▶ Run" that no drain owns (issue 132). It's how the drain re-plan
   * tells a Run it started this generation (counts against the cap) from a
   * LEFTOVER Pane carried over from a PRIOR drain — a `claude` session lingering
   * alive at its prompt from yesterday, which run-state still reads `running`.
   * Such a phantom must not silently shrink a fresh drain's effective cap.
   */
  drainGeneration: number | null;
  /**
   * The MC-internal spawn session id, once its Feed/Pane reports it (issue 139).
   * Null until spawned. Paired with `claudeSessionId` for a headless Run's
   * future take-over (kill this process, `claude --resume <claudeSessionId>`).
   */
  sessionId?: string | null;
  /**
   * A headless drain Run's claude session id, captured from its stream-json
   * (issue 139, AC3) and persisted here on the Run record for resume/take-over.
   * Null for a manual (Pane) Run and until the headless Run's init event lands.
   */
  claudeSessionId?: string | null;
  /**
   * Why this Run's headless process ended with no declared outcome (issue
   * 141): `timeout` (the Headless Session Manager killed it for exceeding
   * `run_timeout`), `crashed` (it exited non-zero on its own), or null (a
   * clean exit, a user stop, or an interactive Pane — none of which name a
   * cause). Fed to the missing-Receipt audit so its note can name the cause.
   */
  endCause?: 'timeout' | 'crashed' | null;
}

export function newRun(target: RunTarget, drainGeneration: number | null = null): TrackedRun {
  return {
    target,
    sessionAlive: true,
    stoppedByUser: false,
    stopSignal: 0,
    drainGeneration,
    sessionId: null,
    claudeSessionId: null,
    endCause: null,
  };
}
