/**
 * Merge display selector (pure) — issue 17.
 *
 * The Merge adapter (`run-merge.ts`) returns a `MergeRunsResult` whose real
 * error/conflict detail lives in `output` (the verbatim `afk-merge.sh`
 * stdout+stderr) while `message` is only a one-line headline. The renderer used
 * to show `message` alone, so a failure's "see details below" had no below.
 *
 * This module is the single, unit-tested decision for *what the Merge UI shows*
 * for each outcome — headline, whether a details panel appears, and the tone
 * that drives styling — so the on-screen panel (Map.tsx) is a thin render of
 * this result. Keeping it pure means the ok/conflict/empty/error branching is
 * testable without a DOM or a real git repo.
 */
import type { MergeRunsResult } from './ipc-contract';

export type MergeDisplayTone = 'pending' | 'success' | 'conflict' | 'error' | 'empty';

export interface MergeDisplay {
  /** The concise one-line headline shown next to the Merge button. */
  headline: string;
  /** The verbatim script output for the details panel ('' when there is none). */
  output: string;
  /** Whether the (scrollable/collapsible) details panel should be rendered. */
  showOutput: boolean;
  /** Drives the message/panel styling. */
  tone: MergeDisplayTone;
}

/** Shown while a Merge is in flight. */
export function pendingMergeDisplay(count: number): MergeDisplay {
  return {
    headline: `Merging ${count} finished Run${count === 1 ? '' : 's'} into main…`,
    output: '',
    showOutput: false,
    tone: 'pending',
  };
}

/**
 * Shown when Merge is triggered but there is nothing mergeable on disk (e.g.
 * stale in-memory readiness after the branches were already removed). A plain
 * "nothing to merge" — never the alarming "could not run — see details below".
 */
export function emptyMergeDisplay(): MergeDisplay {
  return {
    headline: 'Nothing to merge — no finished branches on disk.',
    output: '',
    showOutput: false,
    tone: 'empty',
  };
}

/** Shown when the Merge call itself threw (IPC/adapter error, before a result). */
export function mergeThrewDisplay(detail: string): MergeDisplay {
  const output = detail.trim();
  return {
    headline: 'Merge failed to run.',
    output,
    showOutput: output.length > 0,
    tone: 'error',
  };
}

/**
 * Map a completed `MergeRunsResult` to what the UI shows.
 *
 * - clean merge → the concise merged-N headline, no output dump.
 * - conflict → the "resolve then Merge again" headline plus the script's
 *   conflicting-files output.
 * - a non-conflict failure that merged nothing because no branch was present →
 *   treated as the empty "nothing to merge" case, not "could not run".
 * - any other failure → the headline plus the verbatim output so the user can
 *   see the preflight refusal / error the script printed.
 */
export function mergeResultDisplay(result: MergeRunsResult): MergeDisplay {
  const output = result.output.trim();

  if (result.ok) {
    return { headline: result.message, output, showOutput: false, tone: 'success' };
  }

  if (result.conflicted) {
    return { headline: result.message, output, showOutput: output.length > 0, tone: 'conflict' };
  }

  // A non-conflict failure whose output is only "no branch" skips (nothing was
  // actually mergeable) reads as empty, not as a hard error.
  if (result.merged.length === 0 && mentionsOnlyMissingBranches(output)) {
    return emptyMergeDisplay();
  }

  return { headline: result.message, output, showOutput: output.length > 0, tone: 'error' };
}

/**
 * True when every non-blank line of the script output is a "no branch — skipping"
 * style notice (and there is at least one) — i.e. the run failed with no real
 * error, just nothing to integrate. Anything else (a preflight `die`, a test
 * failure, an unexpected message) is a genuine error we must surface verbatim.
 */
function mentionsOnlyMissingBranches(output: string): boolean {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => /no\s+afk\/|no\s+branch|skip \(no branch\)|no finished branches/i.test(l));
}
