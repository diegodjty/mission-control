import { useMemo, useState } from 'react';
import type { LauncherProject, QuickFixCreateResult } from '../../shared/ipc-contract';

/** What a successful Quick fix hands back for the Run-now offer. */
export interface QuickFixIssueRef {
  issueId: number;
  fileName: string;
  title: string;
}

interface QuickFixFormProps {
  /**
   * The projects the fix can target. The Launcher passes every workbench
   * project (with the picker shown); the Map passes just the one project it has
   * open (picker hidden — `pickable={false}`).
   */
  projects: LauncherProject[];
  /**
   * The initially-selected project's workbench dir. `''` renders an unchosen
   * "Pick a project…" placeholder that blocks submit until an explicit pick
   * (issue 88 — never a silent `projects[0]`).
   */
  initialDir: string;
  /** Show the project picker (Launcher) or fix to `initialDir` (Map). */
  pickable: boolean;
  /** Run the freshly created issue now (a single bare Run — no Dispatcher). */
  onRunNow: (project: LauncherProject, issue: QuickFixIssueRef) => void;
  /** Leave the created issue queued; the caller shows any note and dismisses. */
  onLeaveQueued: (project: LauncherProject, issue: QuickFixIssueRef) => void;
  /** Cancel out of the form (before or after creation). */
  onCancel: () => void;
}

/**
 * The Quick fix form (issue 81, ADR-0016; relocated by issue 116): one sentence
 * → a well-formed STANDALONE issue in a workbench backlog, auto-committed, with
 * a Run-now / leave-queued offer. Extracted from the Launcher so the Map's
 * ＋ Start something "Simple issue" verb reuses the SAME machinery rather than a
 * copy — the two never drift. The impure create call lives in main
 * (`createQuickFix`); this component only drives the form state.
 */
export function QuickFixForm({
  projects,
  initialDir,
  pickable,
  onRunNow,
  onLeaveQueued,
  onCancel,
}: QuickFixFormProps): JSX.Element {
  const [quickFixDir, setQuickFixDir] = useState<string>(initialDir);
  const [sentence, setSentence] = useState('');
  const [creating, setCreating] = useState(false);
  const [quickFixError, setQuickFixError] = useState<string | null>(null);
  // The created issue awaiting the Run-now / leave-queued choice.
  const [created, setCreated] = useState<{
    project: LauncherProject;
    issue: QuickFixIssueRef;
  } | null>(null);

  // The chosen project, or null while nothing is chosen (issue 88): NO silent
  // projects[0] fallback. Null keeps submit disabled until an explicit pick.
  const quickFixProject = useMemo(
    () => projects.find((p) => p.workbenchDir === quickFixDir) ?? null,
    [projects, quickFixDir],
  );

  const createQuickFix = (): void => {
    if (creating) return;
    if (quickFixProject === null) {
      // Reachable via Enter in the sentence field — the button is disabled.
      setQuickFixError('Pick the project this fix belongs to.');
      return;
    }
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

  if (created !== null) {
    return (
      <div className="launcher__form">
        <p className="launcher__note">
          Issue {String(created.issue.issueId).padStart(2, '0')} added to {created.project.label} (
          {created.issue.fileName}) and committed to the workbench.
        </p>
        <div className="launcher__row">
          <button
            className="launcher__primary"
            onClick={() => onRunNow(created.project, created.issue)}
            title="Open the project and launch exactly one bare Run on this issue (no Dispatcher)"
          >
            Run now
          </button>
          <button
            className="launcher__secondary"
            onClick={() => onLeaveQueued(created.project, created.issue)}
          >
            Leave it queued
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="launcher__form">
      {pickable && (
        <label className="launcher__label">
          Project
          <select
            className="launcher__select"
            value={quickFixDir}
            onChange={(e) => setQuickFixDir(e.target.value)}
          >
            {/* No silent default (issue 88): with no project visibly open, the
                placeholder holds until an explicit pick — and it blocks submit. */}
            {quickFixProject === null && (
              <option value="" disabled>
                Pick a project…
              </option>
            )}
            {projects.map((p) => (
              <option key={p.workbenchDir} value={p.workbenchDir}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
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
        <button className="launcher__secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {pickable && projects.length === 0 && (
        <p className="launcher__empty">
          Quick fix needs an active workbench project — none is registered yet.
        </p>
      )}
    </div>
  );
}
