import type { ProjectView } from '../../shared/ipc-contract';

/**
 * The Project switcher (issue 09, ADR-0004). One Window manages one Project at
 * a time; this bar lets you switch the active Project, open a new repo (in this
 * Window or a new one), and shows why a switch was refused (another Window
 * already manages that repo). It is a thin control over the single backend's
 * Project Registry — the registry itself decides; this only surfaces choices.
 */
export interface ProjectBarProps {
  /** Every registered Project, with ownership relative to this Window. */
  projects: ProjectView[];
  /** The repo this Window actively manages, or null while bootstrapping. */
  activeRepoPath: string | null;
  /** The repo-path text in the "open" input. */
  newRepoPath: string;
  onNewRepoPathChange: (value: string) => void;
  /** Switch this Window to an already-registered repo. */
  onSwitch: (repoPath: string) => void;
  /**
   * Open the native OS folder chooser to Browse… for a repo (issue 19); the
   * chosen path lands in the input via `onNewRepoPathChange`, so Open here /
   * Open in new Window then act on it. Cancel is a no-op.
   */
  onBrowse: () => void;
  /** Open (register-if-needed + claim) the entered repo in this Window. */
  onOpenHere: () => void;
  /** Open the entered repo in a brand-new Window on the same backend. */
  onOpenNewWindow: () => void;
  /** The last rejection/error message, or null. */
  error: string | null;
}

const STAGE_LABEL: Record<ProjectView['stage'], string> = {
  planning: 'planning',
  backlog: 'backlog',
  executing: 'executing',
  'merge-qa': 'merge/QA',
};

export function ProjectBar({
  projects,
  activeRepoPath,
  newRepoPath,
  onNewRepoPathChange,
  onSwitch,
  onBrowse,
  onOpenHere,
  onOpenNewWindow,
  error,
}: ProjectBarProps): JSX.Element {
  const active = projects.find((p) => p.repoPath === activeRepoPath) ?? null;

  return (
    <div className="projectbar">
      <span className="projectbar__label">Project</span>

      <select
        className="projectbar__select"
        value={activeRepoPath ?? ''}
        onChange={(e) => {
          const next = e.target.value;
          if (next && next !== activeRepoPath) onSwitch(next);
        }}
        title="Switch the active Project in this Window"
      >
        {activeRepoPath === null && <option value="">(no Project open)</option>}
        {projects.map((p) => (
          <option
            key={p.repoPath}
            value={p.repoPath}
            // A repo owned by ANOTHER Window can't be switched to — that's the
            // no-double-managing rule surfaced in the UI.
            disabled={p.ownership === 'other'}
          >
            {basename(p.repoPath)} — {STAGE_LABEL[p.stage]}
            {p.ownership === 'other' ? ' (open elsewhere)' : ''}
          </option>
        ))}
      </select>

      {active && (
        <span className="projectbar__stage" title={active.repoPath}>
          {STAGE_LABEL[active.stage]}
        </span>
      )}

      <input
        className="projectbar__input"
        type="text"
        placeholder="repo path to open"
        value={newRepoPath}
        onChange={(e) => onNewRepoPathChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpenHere();
        }}
      />
      <button
        className="projectbar__browse"
        onClick={onBrowse}
        title="Browse… for a Project folder with the native file chooser"
      >
        Browse…
      </button>
      <button className="projectbar__open" onClick={onOpenHere} disabled={!newRepoPath.trim()}>
        Open here
      </button>
      <button
        className="projectbar__open-new"
        onClick={onOpenNewWindow}
        disabled={!newRepoPath.trim()}
        title="Open this repo in a new Window on the same backend"
      >
        Open in new Window
      </button>

      {error && <span className="projectbar__error">{error}</span>}
    </div>
  );
}

/** Last path segment for a compact label; falls back to the whole path. */
function basename(repoPath: string): string {
  const parts = repoPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || repoPath;
}
