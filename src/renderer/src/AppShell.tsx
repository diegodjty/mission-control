/**
 * AppShell (issue 123, ADR-0020) — the Window's chrome, extracted from the
 * monolithic root component: the brand header, the Project bar slot, the
 * view navigation, the theme toggle, and the view-hosting container. Every
 * decision the chrome renders — which tabs exist, their labels and badges —
 * comes from the pure `shell-model`; this component just draws it.
 *
 * Behavior-preserving by design: the tab-bar visuals, the view-switch
 * semantics, and ADR-0004's one-backend/many-Windows model are exactly what
 * the root component rendered before the extraction. View switching stays
 * local state (no routing library): the parent owns the active view and
 * hands it down with a navigate callback.
 *
 * The view hosts render as children inside `.app__view`; their keep-mounted
 * vs remount-on-visit hosting is the parent's render decision, driven by
 * `shell-model`'s `isSlotMounted` (Map/Pane/Planning survive navigation with
 * live terminals and watchers intact — the invariant shell-model pins).
 */
import type { ReactNode } from 'react';
import { shellTabs, type ShellContext, type ViewId } from '../../shared/shell-model';

interface AppShellProps {
  /** The active view (local state owned by the parent). */
  view: ViewId;
  /** The live facts the shell's tabs and badges derive from. */
  shellCtx: ShellContext;
  /** A tab was clicked: the parent routes it through shell-model. */
  onNavigate: (to: ViewId) => void;
  /** The Atlas theme, mirrored onto <html data-theme> by the parent. */
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** The ProjectBar element (its state and callbacks live with the parent). */
  projectBar: ReactNode;
  /** Header status area: the Pane info / status readout, when relevant. */
  statusArea?: ReactNode;
  /** Fixed-position overlays (dialogs) rendered outside the view host. */
  dialogs?: ReactNode;
  /** The view hosts, mounted per shell-model policy by the parent. */
  children: ReactNode;
}

export function AppShell({
  view,
  shellCtx,
  onNavigate,
  theme,
  onToggleTheme,
  projectBar,
  statusArea,
  dialogs,
  children,
}: AppShellProps): JSX.Element {
  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand" title="Mission Control">
          <span className="app__mark" aria-hidden="true" />
          <span className="app__wordmark">Mission Control</span>
          <span className="app__presence">
            <span className="app__pulse" aria-hidden="true" />
            <span className="app__presence-text">all systems steady</span>
          </span>
        </div>
        {projectBar}
        <nav className="app__nav">
          {/* The registry decides which tabs exist (the Plan tab only while a
              planning session does — issue 83) and what they carry (the Pane
              tab's Run count); the chrome just renders it. The Home tab
              returns to the Launcher without closing the open Project (issue
              81); the Inbox is deliberately unbadged (ADR-0012). */}
          {shellTabs(shellCtx).map((tab) => (
            <button
              key={tab.id}
              className={`app__tab${view === tab.id ? ' app__tab--active' : ''}`}
              onClick={() => onNavigate(tab.id)}
              title={tab.title}
            >
              {tab.label}
              {tab.badge !== null ? ` (${tab.badge})` : ''}
            </button>
          ))}
          <button
            className="app__theme-toggle"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label="Toggle light / dark theme"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            )}
          </button>
        </nav>
        {statusArea}
      </header>

      <div className="app__view">{children}</div>
      {dialogs}
    </div>
  );
}
