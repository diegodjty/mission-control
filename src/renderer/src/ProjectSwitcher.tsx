/**
 * ProjectSwitcher (issue 124, ADR-0020) — the header control that always
 * names the active **Project** and switches it, absorbing the old top
 * ProjectBar's role into the Atlas shell header. A compact pill (a liveness
 * dot, the Project name, its stage) opens a DropdownMenu of every registered
 * Project plus the two "open another folder" affordances.
 *
 * It adds no authority the ProjectBar didn't have: switching a registered
 * Project still routes through the interrupt guard (via `onSwitch`), and
 * opening a folder still reaches the same open/open-in-new-Window flows —
 * only the presentation changes. A Project owned by another Window is shown
 * disabled, exactly as the old `<select>` disabled it.
 */
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './components';
import type { ProjectView } from '../../shared/ipc-contract';

const STAGE_LABEL: Record<ProjectView['stage'], string> = {
  planning: 'planning',
  backlog: 'backlog',
  executing: 'executing',
  'merge-qa': 'merge/QA',
};

export interface ProjectSwitcherProps {
  /** Every registered Project, with ownership relative to this Window. */
  projects: ProjectView[];
  /** The key of the Project this Window manages, or null while bootstrapping. */
  activeProjectKey: string | null;
  /** Switch this Window to an already-registered Project (routes through the
   *  interrupt guard in the parent). */
  onSwitch: (key: string) => void;
  /** Browse for a folder (native picker) and open it in THIS Window. */
  onBrowseOpenHere: () => void;
  /** Browse for a folder and open it in a brand-new Window. */
  onBrowseOpenNewWindow: () => void;
  /** The last rejection/error message, or null. */
  error: string | null;
}

export function ProjectSwitcher({
  projects,
  activeProjectKey,
  onSwitch,
  onBrowseOpenHere,
  onBrowseOpenNewWindow,
  error,
}: ProjectSwitcherProps): JSX.Element {
  const active = projects.find((p) => p.key === activeProjectKey) ?? null;

  return (
    <div className="shell-project">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="shell-project__pill"
            title={active ? active.key : 'Open a Project'}
            aria-label="Active Project — click to switch"
          >
            <span
              className={`shell-project__dot${active ? ' shell-project__dot--live' : ''}`}
              aria-hidden="true"
            />
            <span className="shell-project__name">
              {active ? active.label || basename(active.key) : 'No project'}
            </span>
            {active && <span className="shell-project__stage">{STAGE_LABEL[active.stage]}</span>}
            <svg
              className="shell-project__chev"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="shell-project__menu">
          <DropdownMenuLabel>Switch project</DropdownMenuLabel>
          {projects.length === 0 && (
            <DropdownMenuItem disabled>No registered projects yet</DropdownMenuItem>
          )}
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.key}
              // A Project owned by ANOTHER Window can't be switched to — the
              // no-double-managing rule, surfaced exactly as the old select did.
              disabled={p.ownership === 'other'}
              onSelect={() => {
                if (p.ownership !== 'other' && p.key !== activeProjectKey) onSwitch(p.key);
              }}
            >
              <span className="shell-project__item-name">{p.label || basename(p.key)}</span>
              <span className="shell-project__item-stage">
                {STAGE_LABEL[p.stage]}
                {p.ownership === 'other' ? ' · open elsewhere' : ''}
                {p.key === activeProjectKey ? ' · here' : ''}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onBrowseOpenHere()}>
            Open a folder here…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onBrowseOpenNewWindow()}>
            Open a folder in a new window…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span className="shell-project__error" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Last path segment for a compact label; falls back to the whole path. */
function basename(key: string): string {
  const parts = key.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || key;
}
