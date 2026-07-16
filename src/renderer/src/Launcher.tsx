import { useEffect, useMemo, useState } from 'react';
import type {
  AttentionSnapshot,
  LauncherProject,
  OnboardingCreateResult,
  ProjectCardView,
} from '../../shared/ipc-contract';
import {
  normalizeProjectView,
  projectStateLine,
  PROJECT_VIEW_KEY,
  type ProjectViewMode,
} from '../../shared/launcher-model';
import { defaultWorkspaceRoot, repoKeyFor } from '../../shared/onboarding-model';
import type { QuickFixIssueRef } from './QuickFixForm';

// Re-exported so existing importers (App) keep their `./Launcher` import path.
export type { QuickFixIssueRef };

interface LauncherProps {
  /** Active workbench-registry projects, most recently active first. */
  projects: LauncherProject[];
  /**
   * The project-first home grid's cards (issue 115, ADR-0019): a superset of
   * `projects` carrying the card model's display labels (open·wip·done +
   * relative last-activity), in grid order. This is the home page's lead
   * content — since issue 117 the only other home affordances are New project
   * and a quiet Just talk link (the per-Project verbs moved to the Map).
   */
  cards: ProjectCardView[];
  /**
   * Open a card's project in place — switch this Window to that project's Map
   * (issue 115), the same in-place flow Continue uses.
   */
  onOpenCard: (card: ProjectCardView) => void;
  /** The app-wide attention snapshot — parked counts per project. */
  attention: AttentionSnapshot;
  /** Set when this Window has a project open (the home affordance's origin). */
  activeProjectLabel: string | null;
  /** Return to the open project's Map (null when no project is open). */
  onBackToProject: (() => void) | null;
  /**
   * New project (issue 82): the guided flow just created and committed this
   * workbench project — land the Window on it.
   */
  onProjectCreated: (created: { workbenchDir: string; label: string }) => void;
  /** Just talk: one warm bare Pane on this project (CORE.md injected). */
  onJustTalkProject: (project: LauncherProject) => void;
  /** Just talk on a bare folder (native picker; no memory, no tracking). */
  onJustTalkFolder: () => void;
}

type LauncherMode = 'menu' | 'newproject' | 'talk';

/** One repo row of the New project form. */
interface RepoRow {
  key: string;
  path: string;
  /** True once the user edited the key by hand — stop auto-deriving it. */
  keyTouched: boolean;
}

const EMPTY_ROW: RepoRow = { key: '', path: '', keyTouched: false };

/**
 * Read the persisted cards⇄list choice (issue 119), mirroring `loadTheme` in
 * App: cards is the default on first run and whenever storage is unavailable
 * (private mode) or holds a stale/unknown value.
 */
function loadProjectView(): ProjectViewMode {
  try {
    return normalizeProjectView(window.localStorage.getItem(PROJECT_VIEW_KEY));
  } catch {
    return 'cards';
  }
}

/**
 * The Launcher (issue 81, ADR-0016; project-first per issue 115/117, ADR-0019):
 * every empty Window IS this surface, and the home affordance returns any Window
 * to it without closing its project. Since issue 117 the home page is noun-first:
 * the grid of registered projects is the lead content (click a card → its Map),
 * with just two project-agnostic affordances beneath it — New project (issue 82:
 * the guided onboarding flow that scaffolds a workbench project and lands on it)
 * as the one primary action, and a quiet Just talk link (one warm bare Pane).
 * The per-Project verbs (Grill a feature / Simple issue) moved onto the Map's
 * ＋ Start something (issue 116).
 */
export function Launcher({
  projects,
  cards,
  onOpenCard,
  attention,
  activeProjectLabel,
  onBackToProject,
  onProjectCreated,
  onJustTalkProject,
  onJustTalkFolder,
}: LauncherProps): JSX.Element {
  const [mode, setMode] = useState<LauncherMode>('menu');

  // --- Cards ⇄ list toggle (issue 119) ---------------------------------------
  // The home grid's density: cards (default) or a dense list. Seeded from
  // localStorage (`mc.projectView`) on mount and written back on every change,
  // mirroring App's `mc.theme` — so the choice survives app restarts. The
  // Launcher re-mounts each time Home is shown, so a fresh mount re-reads the
  // persisted value.
  const [projectView, setProjectView] = useState<ProjectViewMode>(loadProjectView);
  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_VIEW_KEY, projectView);
    } catch {
      /* private mode / storage disabled — the choice still applies this session */
    }
  }, [projectView]);

  // The per-card ⋯ overflow menu (issue 119): at most one open at a time, keyed
  // by the card's `workbenchDir`. Secondary to the card body — a single click
  // on the card still switches in place (issue 115). Any click elsewhere or
  // Escape closes it; the trigger and menu items stopPropagation so their own
  // clicks don't immediately re-close it.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  useEffect(() => {
    if (openMenuKey === null) return;
    const close = (): void => setOpenMenuKey(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenMenuKey(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenuKey]);

  // A refusal from Remove from list (issue 119) — e.g. the project is open in a
  // Window, which `removeProject` (issue 92) rejects. Shown as a quiet line;
  // cleared on the next menu open. Success needs no notice: the registry-changed
  // broadcast re-shapes the grid and the card simply drops out.
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);

  /**
   * Open a card's Project in a NEW Window (issue 119) — the same `openWindow`
   * the interrupt overlay uses, handed the project's workbench dir. Leaves this
   * Window (and any live runner) untouched.
   */
  const openCardInNewWindow = (card: ProjectCardView): void => {
    void window.mc.openWindow({ path: card.workbenchDir });
  };

  /**
   * Remove a card's Project from the list (issue 119) — the existing
   * `removeProject` handler (issue 92): drop its registry entries (the workbench
   * dir and repos stay on disk, reversible via git). Non-destructive, so no
   * confirm; a refusal (open in a Window) surfaces as the quiet notice.
   */
  const removeCard = (card: ProjectCardView): void => {
    void window.mc
      .removeProject({ dirName: card.dirName })
      .then((res) => {
        if (!res.ok) setRemoveNotice(res.error ?? `Could not remove ${card.label}.`);
        else if (res.warning) setRemoveNotice(res.warning);
      })
      .catch((err: unknown) => {
        setRemoveNotice(err instanceof Error ? err.message : String(err));
      });
  };

  /** Toggle the ⋯ menu for a card, closing any other and clearing the notice. */
  const toggleMenu = (key: string): void => {
    setRemoveNotice(null);
    setOpenMenuKey((cur) => (cur === key ? null : key));
  };

  // --- New project state (issue 82; repo-less projects issue 93/ADR-0017) ----
  const [projName, setProjName] = useState('');
  // The workspace root the user typed; empty = accept the default the hint shows
  // (~/Developer/<name>). Where the project's code lives / will live (ADR-0017).
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [repoRows, setRepoRows] = useState<RepoRow[]>([EMPTY_ROW]);
  const [onboardErrors, setOnboardErrors] = useState<string[]>([]);
  // Warnings awaiting the human's "Create anyway" (non-git / missing paths).
  const [onboardWarnings, setOnboardWarnings] = useState<string[]>([]);
  const [onboarding, setOnboarding] = useState(false);

  const setRow = (index: number, patch: Partial<RepoRow>): void => {
    setRepoRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    // Any edit invalidates a pending warnings confirmation.
    setOnboardWarnings([]);
  };

  /** Fill a row's path (typed or browsed), deriving key/name when untouched. */
  const fillRowPath = (index: number, path: string): void => {
    setRepoRows((rows) =>
      rows.map((r, i) =>
        i === index ? { ...r, path, key: r.keyTouched ? r.key : repoKeyFor(path) } : r,
      ),
    );
    setOnboardWarnings([]);
    // Registering an existing repo: the picked folder pre-fills the name too.
    if (index === 0 && projName.trim().length === 0) {
      const base = path.split('/').filter(Boolean).pop();
      if (base) setProjName(base);
    }
  };

  const browseRow = (index: number): void => {
    void window.mc.pickProjectFolder().then(({ path }) => {
      if (path) fillRowPath(index, path);
    });
  };

  /**
   * Submit the New project form. First pass validates (dryRun): refusals show
   * as errors; non-git / missing-path warnings show with the button switched
   * to "Create anyway" (warn, allow — ADR-0016). The confirmed pass creates
   * for real and lands the Window on the new project.
   */
  const createProject = (confirmedWarnings: boolean): void => {
    if (onboarding) return;
    setOnboarding(true);
    setOnboardErrors([]);
    const req = {
      name: projName,
      // Zero repos is valid (ADR-0017): a repo-less project is name + workspace
      // root. Empty rows are dropped, so leaving them blank submits no repos.
      repos: repoRows
        .filter((r) => r.path.trim().length > 0 || r.key.trim().length > 0)
        .map((r) => ({ key: r.key.trim(), path: r.path.trim() })),
      workspaceRoot: workspaceRoot.trim(),
    };
    void window.mc
      .createProject({ ...req, dryRun: !confirmedWarnings })
      .then(async (res: OnboardingCreateResult): Promise<OnboardingCreateResult | null> => {
        if (!res.ok) return res;
        if (!confirmedWarnings) {
          if (res.warnings.length > 0) {
            setOnboardWarnings(res.warnings); // pause for "Create anyway"
            return null;
          }
          return window.mc.createProject(req); // clean dry run → create for real
        }
        return res;
      })
      .then((res) => {
        if (res === null) return;
        if (!res.ok || res.workbenchDir === null) {
          setOnboardErrors(res.errors.length > 0 ? res.errors : ['Could not create the project.']);
          setOnboardWarnings([]);
          return;
        }
        onProjectCreated({ workbenchDir: res.workbenchDir, label: res.dirName ?? projName });
        setProjName('');
        setWorkspaceRoot('');
        setRepoRows([EMPTY_ROW]);
        setOnboardWarnings([]);
      })
      .catch((err: unknown) => {
        setOnboardErrors([err instanceof Error ? err.message : String(err)]);
      })
      .finally(() => setOnboarding(false));
  };

  /** Parked HITL items awaiting the human, per workbench project dir name. */
  const parkedByProject = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of attention.items) {
      if (item.kind !== 'hitl-park') continue;
      map[item.project] = (map[item.project] ?? 0) + 1;
    }
    return map;
  }, [attention.items]);

  const backToMenu = (): void => {
    setMode('menu');
    setOnboardErrors([]);
    setOnboardWarnings([]);
  };

  const projectRows = (onPick: (p: LauncherProject) => void, verb: string): JSX.Element =>
    projects.length === 0 ? (
      <p className="launcher__empty">
        No active workbench projects in ~/Workbench/registry.md yet — use New project, or open a
        folder from the project bar above.
      </p>
    ) : (
      <ul className="launcher__list">
        {projects.map((p) => (
          <li key={p.workbenchDir}>
            <button
              className="launcher__project"
              onClick={() => onPick(p)}
              title={`${verb} ${p.label}`}
            >
              <span className="launcher__project-name">{p.label}</span>
              <span className="launcher__project-state">
                {projectStateLine(p.counts, parkedByProject[p.dirName] ?? 0)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  // The per-card/row ⋯ overflow menu (issue 119). Rendered as a sibling of the
  // clickable card/row (never nested — a <button> can't contain a <button>), so
  // its own clicks stopPropagation to avoid switching the Window or re-closing
  // via the document listener. Shared by cards and list rows so the two never
  // drift.
  const cardMenu = (c: ProjectCardView): JSX.Element => {
    const open = openMenuKey === c.workbenchDir;
    return (
      <span className="launcher__menu">
        <button
          className="launcher__menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`More actions for ${c.label}`}
          title={`More actions for ${c.label}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu(c.workbenchDir);
          }}
        >
          ⋯
        </button>
        {open && (
          <span className="launcher__menu-popup" role="menu">
            <button
              className="launcher__menu-item"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenuKey(null);
                openCardInNewWindow(c);
              }}
            >
              Open in new Window
            </button>
            <button
              className="launcher__menu-item launcher__menu-item--danger"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenuKey(null);
                removeCard(c);
              }}
            >
              Remove from list
            </button>
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="launcher">
      <div className="launcher__body">
        {onBackToProject !== null && (
          <button className="launcher__back" onClick={onBackToProject}>
            ← Back to {activeProjectLabel ?? 'the open project'}
          </button>
        )}

        {mode === 'menu' && (
          <>
            {/* Project-first home (issue 115/117, ADR-0019): the grid of
                registered projects is the home page's lead content — clicking a
                card switches this Window in place to that project's Map. Beneath
                it sit the only two project-agnostic affordances (issue 117): New
                project as the one primary action, and a quiet Just talk link.
                Everything per-Project now lives on the Map's ＋ Start something
                (issue 116). With no projects registered, the empty line still
                leads with New project, not a blank grid. */}
            {/* The title carries the cards⇄list toggle (issue 119). The toggle
                only appears once there's a grid to reshape; the choice persists
                in localStorage (cards is the default on first run). */}
            <div className="launcher__grid-head">
              <h1 className="launcher__title">Projects</h1>
              {cards.length > 0 && (
                <div className="launcher__view-toggle" role="group" aria-label="Project view">
                  <button
                    className={`launcher__view-btn${projectView === 'cards' ? ' launcher__view-btn--on' : ''}`}
                    aria-pressed={projectView === 'cards'}
                    onClick={() => setProjectView('cards')}
                    title="Show projects as cards"
                  >
                    Cards
                  </button>
                  <button
                    className={`launcher__view-btn${projectView === 'list' ? ' launcher__view-btn--on' : ''}`}
                    aria-pressed={projectView === 'list'}
                    onClick={() => setProjectView('list')}
                    title="Show projects as a dense list"
                  >
                    List
                  </button>
                </div>
              )}
            </div>
            {removeNotice !== null && <p className="launcher__notice">{removeNotice}</p>}
            {cards.length === 0 ? (
              <p className="launcher__empty">No projects yet — set one up to get started.</p>
            ) : projectView === 'list' ? (
              /* Dense list view (issue 119): one row per Project carrying the
                 SAME fields the card shows — name, open·wip·done, needs-you,
                 liveness, stage. A single click on the row switches in place
                 (issue 115); the ⋯ menu is the secondary affordance. */
              <ul className="launcher__rows">
                {cards.map((c) => (
                  <li key={c.workbenchDir} className="launcher__row-cell">
                    <button
                      className="launcher__row"
                      onClick={() => onOpenCard(c)}
                      title={`Open ${c.label}`}
                    >
                      <span className="launcher__row-name">{c.label}</span>
                      <span className="launcher__row-counts">{c.countsLabel}</span>
                      {c.needsYou > 0 && (
                        <span
                          className="launcher__card-needsyou"
                          title={`${c.needsYou} attention item${c.needsYou === 1 ? '' : 's'} awaiting you`}
                        >
                          {c.needsYou} needs you
                        </span>
                      )}
                      <span className="launcher__row-liveness">{c.livenessLabel}</span>
                      {c.stageLabel && <span className="launcher__card-stage">{c.stageLabel}</span>}
                    </button>
                    {cardMenu(c)}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="launcher__grid">
                {cards.map((c) => (
                  <li key={c.workbenchDir} className="launcher__card-cell">
                    <button
                      className="launcher__card"
                      onClick={() => onOpenCard(c)}
                      title={`Open ${c.label}`}
                    >
                      {/* Full card stats (issue 118): the header carries the
                          name, the pipeline-stage badge, and — when the Project
                          has attention awaiting the human — the needs-you badge
                          (no badge at zero; the same count the rail and the
                          attention surface show, issue 125). The liveness line
                          reads "N running" / a relative last-activity /
                          "not started". */}
                      <span className="launcher__card-header">
                        <span className="launcher__card-name">{c.label}</span>
                        {c.stageLabel && <span className="launcher__card-stage">{c.stageLabel}</span>}
                        {c.needsYou > 0 && (
                          <span
                            className="launcher__card-needsyou"
                            title={`${c.needsYou} attention item${c.needsYou === 1 ? '' : 's'} awaiting you`}
                          >
                            {c.needsYou} needs you
                          </span>
                        )}
                      </span>
                      <span className="launcher__card-counts">{c.countsLabel}</span>
                      <span className="launcher__card-activity">{c.livenessLabel}</span>
                    </button>
                    {cardMenu(c)}
                  </li>
                ))}
              </ul>
            )}

            <div className="launcher__home-actions">
              <button
                className="launcher__primary"
                onClick={() => setMode('newproject')}
                title="Set up a new workbench project (or register an existing repo): name + repo paths → CONFIG, registry entries, one commit"
              >
                New project
              </button>
              <button
                className="launcher__talk-link"
                onClick={() => setMode('talk')}
                title="Open a warm bare Pane for a throwaway question — no issue, no tracking"
              >
                Just talk
              </button>
            </div>
          </>
        )}

        {mode === 'newproject' && (
          <>
            <h1 className="launcher__title">New project</h1>
            <p className="launcher__hint">
              Start a project — with no code yet (just a name + workspace root), or register
              repos you&apos;ve been working in. This creates ~/Workbench/&lt;project&gt;
              (CONFIG, empty backlog, memory), adds a registry entry per repo, and commits the
              workbench.
            </p>
            <div className="launcher__form">
              <label className="launcher__label">
                Project name
                <input
                  className="launcher__input"
                  type="text"
                  value={projName}
                  placeholder="e.g. Billing Platform"
                  onChange={(e) => {
                    setProjName(e.target.value);
                    setOnboardWarnings([]);
                  }}
                  autoFocus
                />
              </label>

              <label className="launcher__label">
                Workspace root — where the code lives (optional)
                <span className="launcher__repo-row">
                  <input
                    className="launcher__input launcher__input--path"
                    type="text"
                    value={workspaceRoot}
                    placeholder={defaultWorkspaceRoot(projName) || '~/Developer/<name>'}
                    title="Where this project's code will live. Leave blank for the default shown."
                    onChange={(e) => {
                      setWorkspaceRoot(e.target.value);
                      setOnboardWarnings([]);
                    }}
                  />
                  <button
                    className="launcher__secondary"
                    onClick={() =>
                      void window.mc.pickProjectFolder().then(({ path }) => {
                        if (path) {
                          setWorkspaceRoot(path);
                          setOnboardWarnings([]);
                        }
                      })
                    }
                    title="Pick the folder where this project's code will live"
                  >
                    Browse…
                  </button>
                </span>
              </label>

              <span className="launcher__label">
                Code repos — optional; the first is the default (a project can start with none)
                {repoRows.map((row, i) => (
                  <span className="launcher__repo-row" key={i}>
                    <input
                      className="launcher__input launcher__input--path"
                      type="text"
                      value={row.path}
                      placeholder={i === 0 ? '~/Developer/my-repo' : 'another repo path'}
                      onChange={(e) => fillRowPath(i, e.target.value)}
                    />
                    <button
                      className="launcher__secondary"
                      onClick={() => browseRow(i)}
                      title="Pick the repo folder (pre-fills the key — and the name, when empty)"
                    >
                      Browse…
                    </button>
                    <input
                      className="launcher__input launcher__input--key"
                      type="text"
                      value={row.key}
                      placeholder="key"
                      title="The short key issues name this repo by (repo: <key>)"
                      onChange={(e) => setRow(i, { key: e.target.value, keyTouched: true })}
                    />
                    {repoRows.length > 1 && (
                      <button
                        className="launcher__secondary"
                        title="Remove this repo row"
                        onClick={() => {
                          setRepoRows((rows) => rows.filter((_, j) => j !== i));
                          setOnboardWarnings([]);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
                <span className="launcher__row">
                  <button
                    className="launcher__secondary"
                    onClick={() => setRepoRows((rows) => [...rows, EMPTY_ROW])}
                  >
                    Add another repo
                  </button>
                </span>
              </span>

              {onboardErrors.length > 0 && (
                <span className="launcher__error">
                  {onboardErrors.map((e, i) => (
                    <span key={i}>
                      {e}
                      <br />
                    </span>
                  ))}
                </span>
              )}
              {onboardWarnings.length > 0 && (
                <span className="launcher__warning">
                  {onboardWarnings.map((w, i) => (
                    <span key={i}>
                      {w}
                      <br />
                    </span>
                  ))}
                </span>
              )}
              <div className="launcher__row">
                <button
                  className="launcher__primary"
                  onClick={() => createProject(onboardWarnings.length > 0)}
                  disabled={onboarding}
                  title={
                    onboardWarnings.length > 0
                      ? 'Create the project despite the warnings above'
                      : 'Validate and create the workbench project'
                  }
                >
                  {onboarding
                    ? 'Creating…'
                    : onboardWarnings.length > 0
                      ? 'Create anyway'
                      : 'Create project'}
                </button>
                <button className="launcher__secondary" onClick={backToMenu}>
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}

        {mode === 'talk' && (
          <>
            <h1 className="launcher__title">Just talk</h1>
            <p className="launcher__hint">
              One warm claude session — project memory injected when it has CORE.md; no issue is
              claimed, nothing is tracked.
            </p>
            {projectRows(onJustTalkProject, 'Talk in')}
            <div className="launcher__row">
              <button className="launcher__secondary" onClick={onJustTalkFolder}>
                Pick a bare folder…
              </button>
              <button className="launcher__secondary" onClick={backToMenu}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
