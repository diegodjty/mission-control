/**
 * AppShell (issue 123, ADR-0020; rail + header per the approved mock, issue
 * 124) — the Window's chrome: a persistent slim navigation **rail**, a header
 * that always names the active **Project** and offers the Cmd+K palette, the
 * theme toggle, and the view-hosting container. Every entry the rail renders —
 * which views exist, their labels and live badges — comes from the pure
 * `shell-model`; this component just draws it.
 *
 * The flat top tab bar it replaced is gone (issue 124). The rail collapses to
 * icons either on demand (the Collapse control) or automatically below a
 * narrow-width breakpoint (CSS, per the mock's narrow variant) — the labels
 * are always in the DOM so nothing about navigation depends on width; only
 * their visibility does.
 *
 * Behavior-preserving otherwise: view switching stays local state (no routing
 * library) — the parent owns the active view and hands it down with a navigate
 * callback — and the keep-mounted vs remount-on-visit hosting is the parent's
 * render decision, driven by `shell-model`'s `isSlotMounted` (Map/Pane/Planning
 * survive navigation with live terminals and watchers intact).
 */
import type { ReactNode } from 'react';
import { shellTabs, type ShellContext, type ViewId } from '../../shared/shell-model';

interface AppShellProps {
  /** The active view (local state owned by the parent). */
  view: ViewId;
  /** The live facts the rail's entries and badges derive from. */
  shellCtx: ShellContext;
  /** A rail entry was clicked: the parent routes it through shell-model. */
  onNavigate: (to: ViewId) => void;
  /** The Atlas theme, mirrored onto <html data-theme> by the parent. */
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** Whether the rail is collapsed to icons on demand (narrow width also
   *  collapses it via CSS, independent of this flag). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The header Project switcher (its state and callbacks live with the parent). */
  projectSwitcher: ReactNode;
  /** The active Project's path, shown as a quiet header breadcrumb. */
  projectPath?: string | null;
  /** Open the Cmd+K command palette. */
  onOpenPalette: () => void;
  /** Header status area: the Pane info / status readout, when relevant. */
  statusArea?: ReactNode;
  /** Fixed-position overlays (dialogs, palette) rendered outside the view host. */
  dialogs?: ReactNode;
  /** The view hosts, mounted per shell-model policy by the parent. */
  children: ReactNode;
}

/** Each view's rail glyph. Icons are a chrome concern, so they live here (not
 *  in the pure shell-model, which owns ids/labels/badges only). */
const RAIL_ICONS: Record<ViewId, JSX.Element> = {
  launcher: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9h14v-9" />
    </svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </svg>
  ),
  pane: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  planning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.5 21a2 2 0 0 1-3 0" />
    </svg>
  ),
};

export function AppShell({
  view,
  shellCtx,
  onNavigate,
  theme,
  onToggleTheme,
  collapsed,
  onToggleCollapsed,
  projectSwitcher,
  projectPath,
  onOpenPalette,
  statusArea,
  dialogs,
  children,
}: AppShellProps): JSX.Element {
  const tabs = shellTabs(shellCtx);

  return (
    <div className="app">
      <nav
        className="app__rail"
        data-collapsed={collapsed ? 'true' : 'false'}
        aria-label="Primary navigation"
      >
        <div className="app__rail-brand" title="Mission Control">
          <span className="app__mark" aria-hidden="true" />
          <span className="app__wordmark app__rail-label">Mission Control</span>
        </div>

        <div className="app__rail-nav">
          {/* shell-model decides which entries exist (Plan only while a planning
              session does — issue 83) and what each carries (the Pane's Run
              count, Attention's needs-you count — issue 124); the rail draws it. */}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`app__rail-item${view === tab.id ? ' app__rail-item--active' : ''}`}
              aria-current={view === tab.id ? 'page' : undefined}
              onClick={() => onNavigate(tab.id)}
              title={tab.title ?? tab.label}
            >
              <span className="app__rail-icon" aria-hidden="true">
                {RAIL_ICONS[tab.id]}
              </span>
              <span className="app__rail-label">{tab.label}</span>
              {tab.badge !== null ? (
                <span className="app__rail-badge" aria-label={`${tab.badge}`}>
                  {tab.badge}
                </span>
              ) : (
                // Plan advertises only its presence — a quiet dot, no count.
                tab.id === 'planning' && <span className="app__rail-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>

        <div className="app__rail-foot">
          <button
            className="app__rail-item app__rail-toggle"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle light / dark theme"
          >
            <span className="app__rail-icon" aria-hidden="true">
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              )}
            </span>
            <span className="app__rail-label">
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </span>
          </button>
          <button
            className="app__rail-item app__rail-toggle"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand the rail' : 'Collapse the rail to icons'}
            aria-label={collapsed ? 'Expand the navigation rail' : 'Collapse the navigation rail'}
          >
            <span className="app__rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </span>
            <span className="app__rail-label">{collapsed ? 'Expand' : 'Collapse'}</span>
          </button>
        </div>
      </nav>

      <div className="app__main">
        <header className="app__topbar">
          {projectSwitcher}
          {projectPath && (
            <span className="app__crumb" title={projectPath}>
              {projectPath}
            </span>
          )}
          {statusArea}
          <button
            className="app__search"
            onClick={onOpenPalette}
            title="Search & run commands (⌘K)"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <span className="app__search-text">Search &amp; commands</span>
            <kbd className="app__search-kbd">⌘K</kbd>
          </button>
        </header>

        <div className="app__view">{children}</div>
      </div>

      {dialogs}
    </div>
  );
}
