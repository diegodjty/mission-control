/**
 * Drain interruption (PURE) — releasing the claims a project-switch teardown is
 * about to orphan (issue 112).
 *
 * The bug: a drain runs Workers, each of which flips its issue to `wip` in the
 * workbench (its claim) and works on it. When the user switches the active
 * Project, `resetForProjectSwitch` (issue 26) clears the tracked Runs — which
 * unmounts their Panes and KILLS their PTY sessions. Issue 26's reset was written
 * assuming those Runs are inert trackers; but a Worker killed mid-flight has
 * already claimed its issue `wip`, and that claim is now orphaned: no live Worker
 * to finish it, no running drain (the drain is torn down too), and nothing to
 * un-claim it. The issue sits `wip` forever — exactly the "I came back to the
 * project and the runner had stopped leaving an issue wip" report.
 *
 * A killed claim is void, so the clean recovery (the same one the afk-issue-runner
 * skill prescribes for a stranded `wip`: "flip it back to open") is to reopen it,
 * so a later drain — or the user — picks it up fresh instead of finding a stranded
 * `wip` with no owner. This module is the pure half of that:
 *
 *   1. `orphanedClaims` — which of the Runs being torn down hold a live claim: a
 *      Run still `running` on an issue still `wip`. A `finished`/`parked`/
 *      `blocked`/`stopped` Run has a settled disposition (its issue is `done`, or
 *      deliberately left `wip` for the human, or a genuine blocker to surface) and
 *      is left exactly as-is.
 *   2. `reopenWipToOpen` — flip an issue file's frontmatter `status: wip` back to
 *      `open`, verbatim otherwise; null when it is not currently `wip` (so a
 *      Worker that flipped `done` in the same beat as the switch is never
 *      clobbered by a stale release).
 *   3. `describeReleasedClaims` — the one-line human note for the release.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a value,
 * never a throw. The fs edge (re-read each file, write the flip) is the renderer's
 * app wiring, through the existing `readIssueFile`/`editIssueFile` IPC.
 */
import type { IssueStatus } from './backlog-model';
import type { RunStatus } from './run-state';

/** One tracked Run reduced to just what the orphan decision needs. */
export interface TrackedClaim {
  /** The issue this Run targets. */
  issueId: number;
  /** The issue's `NN-slug.md` file name (what the release IPC edits). */
  fileName: string;
  /** The Run's derived status (`deriveRunStatus`) right now. */
  runStatus: RunStatus;
  /** The issue's current status on disk, or null if not yet observed. */
  issueStatus: IssueStatus | null;
}

/** An issue whose live claim a teardown would orphan — release it to `open`. */
export interface ReleasableClaim {
  issueId: number;
  fileName: string;
}

/**
 * The claims a project-switch teardown is about to orphan: every Run that is
 * `running` (in-flight, no settled outcome) on an issue still `wip` on disk.
 * Killing such a Run's Pane voids its claim, so it must be reopened — whereas a
 * `finished` (issue `done`), `parked` (HITL, left `wip` for the human on purpose),
 * `blocked` (a genuine blocker to surface), or `stopped` (user-ended) Run has a
 * disposition already and is left untouched.
 */
export function orphanedClaims(claims: readonly TrackedClaim[]): ReleasableClaim[] {
  if (!Array.isArray(claims)) return [];
  return claims
    .filter((c) => c && c.runStatus === 'running' && c.issueStatus === 'wip')
    .map((c) => ({ issueId: c.issueId, fileName: c.fileName }));
}

/** Frontmatter block at the very start of an issue file (mirrors issue-file-ops). */
const FRONTMATTER_BLOCK = /^(---\s*\n)([\s\S]*?)(\n---\s*(?:\n|$))/;
/** A frontmatter `status: wip` line — value captured so trailing space survives. */
const STATUS_WIP_LINE = /^(\s*status\s*:\s*)wip([^\S\n]*)$/m;

/**
 * Flip an issue file's frontmatter `status: wip` back to `open`, returning the new
 * full text — or null when the file has no leading frontmatter block or its
 * frontmatter `status:` is not `wip` (so a release that races a Worker's `done`
 * flip is a no-op, never a `done`→`open` clobber). Only the FRONTMATTER status
 * line is touched: a `status:` mention in the body is left alone, and everything
 * else round-trips byte-for-byte (so the existing edit validator still accepts it).
 */
export function reopenWipToOpen(text: string): string | null {
  if (typeof text !== 'string') return null;
  const block = FRONTMATTER_BLOCK.exec(text);
  if (!block) return null;
  const [full, opener, inner, closer] = block;
  if (!STATUS_WIP_LINE.test(inner)) return null;
  const reopenedInner = inner.replace(STATUS_WIP_LINE, '$1open$2');
  return opener + reopenedInner + closer + text.slice(full.length);
}

/** Zero-pad an issue id to the 2-digit `NN` label the UI uses. */
function label(issueId: number): string {
  return String(issueId).padStart(2, '0');
}

/**
 * A one-line, plain-language note for a release: what stopped the drain and which
 * issues were reopened so nothing is left stranded. Ids are sorted and 2-digit
 * padded; singular/plural agree. Empty input yields '' (nothing to say).
 */
export function describeReleasedClaims(claims: readonly ReleasableClaim[]): string {
  if (!Array.isArray(claims) || claims.length === 0) return '';
  const ids = claims.map((c) => c.issueId).sort((a, b) => a - b);
  const noun = ids.length === 1 ? 'issue' : 'issues';
  return (
    `Leaving this project stopped the drain — released ${ids.length} in-flight ` +
    `${noun} back to open (${ids.map(label).join(', ')}) so no claim is left stranded.`
  );
}
