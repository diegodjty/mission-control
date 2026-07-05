import { useMemo, useState } from 'react';
import type {
  AttentionSnapshot,
  LauncherProject,
  QuickFixCreateResult,
} from '../../shared/ipc-contract';
import { projectStateLine } from '../../shared/launcher-model';

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
  /** New project — wired by issue 82; until then the classic folder picker. */
  onNewProject: () => void;
  /** Big feature — wired by issue 83; until then the classic folder picker. */
  onBigFeature: () => void;
  /** Just talk: one warm bare Pane on this project (CORE.md injected). */
  onJustTalkProject: (project: LauncherProject) => void;
  /** Just talk on a bare folder (native picker; no memory, no tracking). */
  onJustTalkFolder: () => void;
  /** Run the freshly created quick-fix issue now (single bare Run). */
  onQuickFixRunNow: (project: LauncherProject, issue: QuickFixIssueRef) => void;
}

type LauncherMode = 'menu' | 'quickfix' | 'talk';

/**
 * The Launcher (issue 81, ADR-0016): every empty Window IS this surface —
 * *what are we doing?* — and the home affordance returns any Window to it
 * without closing its project. Five actions: New project / Big feature
 * (present; wired by issues 82/83 — until then they open the classic folder
 * picker), and the three this issue fully implements — Quick fix (one
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
  onNewProject,
  onBigFeature,
  onJustTalkProject,
  onJustTalkFolder,
  onQuickFixRunNow,
}: LauncherProps): JSX.Element {
  const [mode, setMode] = useState<LauncherMode>('menu');

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
                onClick={onNewProject}
                title="Set up a new project (guided onboarding lands with issue 82 — for now this opens the classic folder picker)"
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
