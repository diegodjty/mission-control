import { useMemo, useState } from 'react';
import type {
  AttentionSnapshot,
  LauncherProject,
  OnboardingCreateResult,
  QuickFixCreateResult,
} from '../../shared/ipc-contract';
import { projectStateLine } from '../../shared/launcher-model';
import { repoKeyFor } from '../../shared/onboarding-model';

/** What a successful Quick fix hands back for the Run-now offer. */
export interface QuickFixIssueRef {
  issueId: number;
  fileName: string;
  title: string;
}

interface LauncherProps {
  /** Active workbench-registry projects, most recently active first. */
  projects: LauncherProject[];
  /** The app-wide attention snapshot — parked counts per project. */
  attention: AttentionSnapshot;
  /** Set when this Window has a project open (the home affordance's origin). */
  activeProjectLabel: string | null;
  /** Return to the open project's Map (null when no project is open). */
  onBackToProject: (() => void) | null;
  /** Continue: open this project in this Window through the normal flow. */
  onContinue: (project: LauncherProject) => void;
  /**
   * New project (issue 82): the guided flow just created and committed this
   * workbench project — land the Window on it (with the Big feature /
   * Quick fix nudge).
   */
  onProjectCreated: (created: { workbenchDir: string; label: string }) => void;
  /** Big feature — wired by issue 83; until then the classic folder picker. */
  onBigFeature: () => void;
  /** Just talk: one warm bare Pane on this project (CORE.md injected). */
  onJustTalkProject: (project: LauncherProject) => void;
  /** Just talk on a bare folder (native picker; no memory, no tracking). */
  onJustTalkFolder: () => void;
  /** Run the freshly created quick-fix issue now (single bare Run). */
  onQuickFixRunNow: (project: LauncherProject, issue: QuickFixIssueRef) => void;
}

type LauncherMode = 'menu' | 'newproject' | 'quickfix' | 'talk';

/** One repo row of the New project form. */
interface RepoRow {
  key: string;
  path: string;
  /** True once the user edited the key by hand — stop auto-deriving it. */
  keyTouched: boolean;
}

const EMPTY_ROW: RepoRow = { key: '', path: '', keyTouched: false };

/**
 * The Launcher (issue 81, ADR-0016): every empty Window IS this surface —
 * *what are we doing?* — and the home affordance returns any Window to it
 * without closing its project. Five actions: New project (issue 82 — the
 * guided onboarding flow: name + repo paths → workbench project + registry
 * entries + one commit, then land on the new project), Big feature (present;
 * wired by issue 83 — until then the classic folder picker), Quick fix (one
 * sentence → a standalone workbench issue, auto-committed, with a Run-now
 * offer), Just talk (one warm bare Pane), and Continue (recent projects with
 * a truthful one-line state).
 */
export function Launcher({
  projects,
  attention,
  activeProjectLabel,
  onBackToProject,
  onContinue,
  onProjectCreated,
  onBigFeature,
  onJustTalkProject,
  onJustTalkFolder,
  onQuickFixRunNow,
}: LauncherProps): JSX.Element {
  const [mode, setMode] = useState<LauncherMode>('menu');

  // --- New project state (issue 82) ------------------------------------------
  const [projName, setProjName] = useState('');
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
      repos: repoRows
        .filter((r) => r.path.trim().length > 0 || r.key.trim().length > 0)
        .map((r) => ({ key: r.key.trim(), path: r.path.trim() })),
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
        setRepoRows([EMPTY_ROW]);
        setOnboardWarnings([]);
      })
      .catch((err: unknown) => {
        setOnboardErrors([err instanceof Error ? err.message : String(err)]);
      })
      .finally(() => setOnboarding(false));
  };

  // --- Quick fix state ------------------------------------------------------
  const [quickFixDir, setQuickFixDir] = useState<string>('');
  const [sentence, setSentence] = useState('');
  const [creating, setCreating] = useState(false);
  const [quickFixError, setQuickFixError] = useState<string | null>(null);
  // The created issue awaiting the Run-now / leave-queued choice.
  const [created, setCreated] = useState<{
    project: LauncherProject;
    issue: QuickFixIssueRef;
  } | null>(null);
  // A quiet confirmation after "leave it queued".
  const [queuedNote, setQueuedNote] = useState<string | null>(null);

  /** Parked HITL items awaiting the human, per workbench project dir name. */
  const parkedByProject = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of attention.items) {
      if (item.kind !== 'hitl-park') continue;
      map[item.project] = (map[item.project] ?? 0) + 1;
    }
    return map;
  }, [attention.items]);

  const quickFixProject = useMemo(
    () => projects.find((p) => p.workbenchDir === quickFixDir) ?? projects[0] ?? null,
    [projects, quickFixDir],
  );

  const createQuickFix = (): void => {
    if (quickFixProject === null || creating) return;
    const text = sentence.trim();
    if (text.length === 0) {
      setQuickFixError('Type one sentence describing the fix.');
      return;
    }
    setCreating(true);
    setQuickFixError(null);
    void window.mc
      .createQuickFix({ workbenchDir: quickFixProject.workbenchDir, sentence: text })
      .then((res: QuickFixCreateResult) => {
        if (!res.ok || res.issueId === null || res.fileName === null) {
          setQuickFixError(res.error ?? 'Could not create the issue.');
          return;
        }
        setCreated({
          project: quickFixProject,
          issue: { issueId: res.issueId, fileName: res.fileName, title: res.title ?? text },
        });
        setSentence('');
      })
      .catch((err: unknown) => {
        setQuickFixError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setCreating(false));
  };

  const backToMenu = (): void => {
    setMode('menu');
    setQuickFixError(null);
    setCreated(null);
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
            <h1 className="launcher__title">What are we doing?</h1>
            {queuedNote !== null && <p className="launcher__note">{queuedNote}</p>}
            <div className="launcher__actions">
              <button
                className="launcher__action"
                onClick={() => {
                  setMode('newproject');
                  setQueuedNote(null);
                }}
                title="Set up a new workbench project (or register an existing repo): name + repo paths → CONFIG, registry entries, one commit"
              >
                <span className="launcher__action-name">New project</span>
                <span className="launcher__action-hint">start or register a project</span>
              </button>
              <button
                className="launcher__action"
                onClick={onBigFeature}
                title="Plan a big feature (the Planning view lands with issue 83 — for now this opens the classic folder picker)"
              >
                <span className="launcher__action-name">Big feature</span>
                <span className="launcher__action-hint">grill → PRD → issues</span>
              </button>
              <button
                className="launcher__action"
                onClick={() => {
                  setMode('quickfix');
                  setQueuedNote(null);
                  setQuickFixDir(quickFixProject?.workbenchDir ?? '');
                }}
                title="One sentence becomes a standalone issue in a project's backlog"
              >
                <span className="launcher__action-name">Quick fix</span>
                <span className="launcher__action-hint">one sentence → one issue</span>
              </button>
              <button
                className="launcher__action"
                onClick={() => {
                  setMode('talk');
                  setQueuedNote(null);
                }}
                title="One warm claude session — no issue, no tracking"
              >
                <span className="launcher__action-name">Just talk</span>
                <span className="launcher__action-hint">a warm session, nothing tracked</span>
              </button>
            </div>

            <h2 className="launcher__subtitle">Continue</h2>
            {projectRows(onContinue, 'Open')}
          </>
        )}

        {mode === 'newproject' && (
          <>
            <h1 className="launcher__title">New project</h1>
            <p className="launcher__hint">
              Start a project — or register a repo you&apos;ve been working in. This creates
              ~/Workbench/&lt;project&gt; (CONFIG, empty backlog, memory), adds the registry
              entries, and commits the workbench.
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

              <span className="launcher__label">
                Code repos — the first is the default
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

        {mode === 'quickfix' && (
          <>
            <h1 className="launcher__title">Quick fix</h1>
            {created === null ? (
              <div className="launcher__form">
                <label className="launcher__label">
                  Project
                  <select
                    className="launcher__select"
                    value={quickFixProject?.workbenchDir ?? ''}
                    onChange={(e) => setQuickFixDir(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.workbenchDir} value={p.workbenchDir}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="launcher__label">
                  One sentence — what needs fixing?
                  <input
                    className="launcher__input"
                    type="text"
                    value={sentence}
                    placeholder="e.g. The drain message overflows the Map header"
                    onChange={(e) => setSentence(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createQuickFix();
                    }}
                    autoFocus
                  />
                </label>
                {quickFixError !== null && <p className="launcher__error">{quickFixError}</p>}
                <div className="launcher__row">
                  <button
                    className="launcher__primary"
                    onClick={createQuickFix}
                    disabled={creating || quickFixProject === null}
                  >
                    {creating ? 'Adding…' : 'Add to backlog'}
                  </button>
                  <button className="launcher__secondary" onClick={backToMenu}>
                    Cancel
                  </button>
                </div>
                {projects.length === 0 && (
                  <p className="launcher__empty">
                    Quick fix needs an active workbench project — none is registered yet.
                  </p>
                )}
              </div>
            ) : (
              <div className="launcher__form">
                <p className="launcher__note">
                  Issue {String(created.issue.issueId).padStart(2, '0')} added to{' '}
                  {created.project.label} ({created.issue.fileName}) and committed to the
                  workbench.
                </p>
                <div className="launcher__row">
                  <button
                    className="launcher__primary"
                    onClick={() => onQuickFixRunNow(created.project, created.issue)}
                    title="Open the project and launch exactly one bare Run on this issue (no Dispatcher)"
                  >
                    Run now
                  </button>
                  <button
                    className="launcher__secondary"
                    onClick={() => {
                      setQueuedNote(
                        `Issue ${String(created.issue.issueId).padStart(2, '0')} is queued in ${created.project.label} — the next drain (or a manual Run) picks it up.`,
                      );
                      backToMenu();
                    }}
                  >
                    Leave it queued
                  </button>
                </div>
              </div>
            )}
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
