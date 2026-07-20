import type { RunStatus } from '../../../shared/run-state';

/** localStorage key for the persisted UI theme (Atlas design language). */
export const THEME_KEY = 'mc.theme';
/** localStorage key for the persisted rail-collapsed preference (issue 124). */
export const RAIL_COLLAPSED_KEY = 'mc.railCollapsed';
export type Theme = 'dark' | 'light';

/** Read the persisted theme; the navy dark stage is the default. */
export function loadTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Grace window before the Receipt audits conclude anything (issue 57,
 * ADR-0012's debounce discipline). A Worker's Receipt can land a beat after
 * its issue's `done` flip is observed (write → watch debounce → stability
 * reads), and a `done` flip can land a beat after its Receipt — so both the
 * finished-without-receipt note and the Receipt/state-mismatch note re-check
 * the live facts after this window and stay silent when reality caught up.
 */
export const RECEIPT_AUDIT_GRACE_MS = 5000;

/**
 * Collapse a (possibly multi-line) fact into one quiet ambient-log line (issue
 * 48): the activity log renders `label` as a single row, so newlines become ` · `
 * separators the way the chat feed flattens its messages.
 */
export function oneLineNote(text: string): string {
  return text.trim().replace(/\s*[\r\n]+\s*/g, ' · ');
}

/**
 * The prominent "big warning" (issue 113) shown as a `protected-branch-land`
 * proposal label and typed into the chat: landing a Run's work on a protected
 * branch (`main`/`master`) needs an explicit click because such a branch is
 * usually wired to production/deploy workflows.
 */
export function protectedLandWarning(branch: string): string {
  return (
    `⚠️ About to land Run work on the protected branch '${branch}'. ` +
    `'${branch}' may be tied to production/deploy workflows — approve to proceed, ` +
    `or reject to leave the finished work on its branch/worktree unmerged.`
  );
}

/** The `NN-slug` for a Run, from its issue file name (`NN-slug.md`). */
export function slugOf(fileName: string): string {
  return fileName.replace(/\.md$/, '');
}

/** The status-dot tone for a Run's derived status (issue 129 tile header): the
 * at-a-glance liveness colour on each tile, the same dot idiom the Map uses for
 * its issues (issue 127). Maps to the `.app__tile-dot--*` tokens in Pane.css. */
export function dotTone(status: RunStatus): 'amber' | 'green' | 'red' | 'teal' | 'neutral' {
  switch (status) {
    case 'running':
      return 'amber';
    case 'finished':
      return 'green';
    case 'blocked':
      return 'red';
    case 'parked':
      return 'teal';
    case 'stopped':
    default:
      return 'neutral';
  }
}

/** The maximize / restore glyph for a tile's per-tile control (issue 129, the
 * approved `pane` mock). Inline SVG stroked in `currentColor` so it follows the
 * active Atlas theme; arrows point outward to maximize, inward to restore. */
export function MaximizeIcon({ maximized }: { maximized: boolean }): JSX.Element {
  return maximized ? (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="10" y1="14" x2="3" y2="21" />
    </svg>
  ) : (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
