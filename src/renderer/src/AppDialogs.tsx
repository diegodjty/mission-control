import { Button, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from './components';
import type { GitBranchStatusResult } from '../../shared/ipc-contract';

export interface GitInitDialogProps {
  projectLabel: string | null;
  projectKey: string | null;
  prompt: { cap: number } | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (error: string | null) => void;
  onProceed: (cap: number) => void;
}

/**
 * Drain cap>1 on a non-git workspace root (issue 158, ADR-0017): explains the
 * limitation instead of silently proceeding, and offers a one-click fix.
 * "Initialize git" runs the IPC then resumes the SAME drain immediately
 * (`onProceed` bypasses the gate — it's what just got fixed); "Drain serially"
 * resumes unchanged, relying on issue 157's engine-side clamp; closing
 * (Escape/backdrop/Cancel) starts nothing.
 */
export function GitInitDialog({
  projectLabel,
  projectKey,
  prompt,
  busy,
  error,
  onClose,
  onBusyChange,
  onErrorChange,
  onProceed,
}: GitInitDialogProps): JSX.Element {
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {prompt !== null && (
        <DialogContent>
          <DialogTitle>Not under git yet</DialogTitle>
          <DialogDescription>
            <strong>{projectLabel ?? 'This project'}</strong>'s workspace root isn't a git
            repository, so Mission Control can't cut worktrees here — a concurrent drain would
            collide on the same tree. Initialize git now to enable up to {prompt.cap} at once, or
            drain one at a time instead.
          </DialogDescription>
          {error && <p className="app__gitinit-error">{error}</p>}
          <DialogActions>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (!projectKey) return;
                const chosenCap = prompt.cap;
                onBusyChange(true);
                onErrorChange(null);
                void window.mc
                  .gitInit({ projectKey })
                  .then((res) => {
                    onBusyChange(false);
                    if (!res.ok) {
                      onErrorChange(res.error ?? 'Could not initialize git.');
                      return;
                    }
                    onClose();
                    onProceed(chosenCap);
                  })
                  .catch((err) => {
                    onBusyChange(false);
                    onErrorChange(err instanceof Error ? err.message : String(err));
                  });
              }}
            >
              {busy ? 'Initializing…' : 'Initialize git'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const chosenCap = prompt.cap;
                onClose();
                onProceed(chosenCap);
              }}
              title="Proceed without initializing git — Runs serialize on this workspace root"
            >
              Drain serially
            </Button>
            <Button variant="ghost" className="ui-btn--end" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );
}

export interface BranchPromptDialogProps {
  projectLabel: string | null;
  projectPath: string | null;
  branchStatus: GitBranchStatusResult | null;
  prompt: { kind: 'run' } | { kind: 'drain' } | { kind: 'schedule' } | null;
  mode: 'choose' | 'create' | 'switch';
  name: string;
  branches: string[];
  selected: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onModeChange: (mode: 'choose' | 'create' | 'switch') => void;
  onNameChange: (name: string) => void;
  onBranchesChange: (branches: string[]) => void;
  onSelectedChange: (selected: string) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (error: string | null) => void;
  onBranchCreated: (branch: string | null) => void;
  onBranchSwitched: (branch: string | null) => void;
  onResume: () => void;
}

/**
 * Pre-start branch-awareness prompt (issue 167): caught by `guardedStartRun` /
 * `guardedStartDrain` when the checkout is on a protected branch
 * (`main`/`master`) or a detached HEAD — BEFORE any Run/drain work starts, so
 * the branch choice is still free (unlike issue 113's merge-time-only
 * warning). Create/Switch perform the git op then resume the held action;
 * Proceed anyway resumes unchanged, landing on the current branch.
 */
export function BranchPromptDialog({
  projectLabel,
  projectPath,
  branchStatus,
  prompt,
  mode,
  name,
  branches,
  selected,
  busy,
  error,
  onClose,
  onModeChange,
  onNameChange,
  onBranchesChange,
  onSelectedChange,
  onBusyChange,
  onErrorChange,
  onBranchCreated,
  onBranchSwitched,
  onResume,
}: BranchPromptDialogProps): JSX.Element {
  const submitCreateBranch = (): void => {
    if (projectPath === null) return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    onBusyChange(true);
    onErrorChange(null);
    void window.mc
      .createGitBranch({ projectPath, name: trimmed })
      .then((res) => {
        onBusyChange(false);
        if (!res.ok) {
          onErrorChange(res.error ?? 'Could not create the branch.');
          return;
        }
        onBranchCreated(res.branch);
        onResume();
      })
      .catch((err) => {
        onBusyChange(false);
        onErrorChange(err instanceof Error ? err.message : String(err));
      });
  };

  const submitSwitchBranch = (): void => {
    if (projectPath === null) return;
    const chosen = selected;
    if (chosen === '') return;
    onBusyChange(true);
    onErrorChange(null);
    void window.mc
      .switchGitBranch({ projectPath, name: chosen })
      .then((res) => {
        onBusyChange(false);
        if (!res.ok) {
          onErrorChange(res.error ?? 'Could not switch branches.');
          return;
        }
        onBranchSwitched(res.branch);
        onResume();
      })
      .catch((err) => {
        onBusyChange(false);
        onErrorChange(err instanceof Error ? err.message : String(err));
      });
  };

  // What the held action is, for the prose: a Run, a drain now, or a scheduled
  // drain (issue 195 — arm-time branch guard reuses this same dialog).
  const actionNoun =
    prompt?.kind === 'run' ? 'Run' : prompt?.kind === 'schedule' ? 'scheduled drain' : 'drain';

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {prompt !== null && (
        <DialogContent>
          <DialogTitle>
            {branchStatus?.detached ? 'Detached HEAD' : `On a protected branch (${branchStatus?.branch ?? ''})`}
          </DialogTitle>
          <DialogDescription>
            {branchStatus?.detached ? (
              <>
                <strong>{projectLabel ?? 'This project'}</strong>'s checkout isn't on any branch
                right now — a {actionNoun} would land its work with nowhere to come back to. Create a
                branch, switch to one, or proceed anyway (work lands on a detached commit).
                {prompt.kind === 'schedule' && (
                  <> If you schedule anyway and are still detached at fire time, the drain is skipped.</>
                )}
              </>
            ) : (
              <>
                <strong>{projectLabel ?? 'This project'}</strong> is checked out on{' '}
                <strong>{branchStatus?.branch}</strong> — a protected branch. A {actionNoun} would
                land its work directly there. Create a new branch, switch to an existing one, or
                proceed anyway.
                {prompt.kind === 'schedule' && (
                  <>
                    {' '}
                    If you schedule anyway and are still on{' '}
                    <strong>{branchStatus?.branch}</strong> at fire time, the drain is skipped.
                  </>
                )}
              </>
            )}
          </DialogDescription>
          {error && <p className="app__gitinit-error">{error}</p>}
          {mode === 'choose' && (
            <DialogActions>
              <Button
                variant="primary"
                onClick={() => {
                  onNameChange('');
                  onErrorChange(null);
                  onModeChange('create');
                }}
              >
                Create a new branch
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  onErrorChange(null);
                  onSelectedChange('');
                  onModeChange('switch');
                  if (projectPath !== null) {
                    void window.mc
                      .listGitBranches({ projectPath })
                      .then((res) => onBranchesChange(res.branches));
                  }
                }}
              >
                Switch to an existing branch
              </Button>
              <Button
                variant="ghost"
                className="ui-btn--end"
                onClick={onResume}
                title={
                  prompt.kind === 'schedule'
                    ? 'Arm the schedule anyway — it will be skipped at fire time if you are still on this branch'
                    : 'Start anyway, landing work on the current branch'
                }
              >
                {prompt.kind === 'schedule' ? 'Schedule anyway' : 'Proceed anyway'}
              </Button>
            </DialogActions>
          )}
          {mode === 'create' && (
            <>
              <label className="launcher__label">
                New branch name
                <input
                  className="launcher__input"
                  type="text"
                  autoFocus
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitCreateBranch();
                  }}
                />
              </label>
              <DialogActions>
                <Button
                  variant="primary"
                  disabled={busy || name.trim() === ''}
                  onClick={submitCreateBranch}
                >
                  {busy ? 'Creating…' : 'Create + check out'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => onModeChange('choose')}>
                  Back
                </Button>
              </DialogActions>
            </>
          )}
          {mode === 'switch' && (
            <>
              <label className="launcher__label">
                Branch
                <select
                  className="launcher__select"
                  value={selected}
                  onChange={(e) => onSelectedChange(e.target.value)}
                >
                  <option value="" disabled>
                    Pick a branch…
                  </option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <DialogActions>
                <Button
                  variant="primary"
                  disabled={busy || selected === ''}
                  onClick={submitSwitchBranch}
                >
                  {busy ? 'Switching…' : 'Switch + check out'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => onModeChange('choose')}>
                  Back
                </Button>
              </DialogActions>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

export interface OpenChoiceDialogProps {
  activeProjectLabel: string | null;
  pending: { path: string; label: string } | null;
  onClose: () => void;
  onOpenHere: (path: string) => void;
  onOpenNewWindow: (path: string) => void;
}

/**
 * Open-here-or-new-Window choice (issue 121): this Window already has a
 * Project open and the user picked a DIFFERENT one from the home grid (with
 * nothing running — a live runner takes the stronger interrupt dialog
 * instead). Rather than silently switching this Window, offer the same
 * choice the project bar's buttons give.
 */
export function OpenChoiceDialog({
  activeProjectLabel,
  pending,
  onClose,
  onOpenHere,
  onOpenNewWindow,
}: OpenChoiceDialogProps): JSX.Element {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {pending !== null && (
        <DialogContent>
          <DialogTitle>Open {pending.label}</DialogTitle>
          <DialogDescription>
            <strong>{activeProjectLabel ?? 'This project'}</strong> is open in this window. Open{' '}
            <strong>{pending.label}</strong> here instead, or in a new window so you can work on
            both at once?
          </DialogDescription>
          <DialogActions>
            <Button
              variant="primary"
              onClick={() => {
                onOpenHere(pending.path);
                onClose();
              }}
              title="Switch this window to the picked project"
            >
              Open here
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenNewWindow(pending.path);
                onClose();
              }}
              title="Open the picked project in a new window; this window stays put"
            >
              Open in new window
            </Button>
            <Button variant="ghost" className="ui-btn--end" onClick={onClose}>
              Cancel
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );
}

export interface InterruptDialogProps {
  activeProjectLabel: string | null;
  pending: { path: string; label: string; proceed: () => void } | null;
  onClose: () => void;
  onOpenNewWindow: (path: string) => void;
}

/**
 * Interrupt confirmation (issue 114): a runner is fixing an issue in the
 * Project this Window has open, and the user picked a different one in the
 * switcher or the Launcher's Continue list. Rather than silently killing the
 * live Run, offer to open the other Project in a NEW Window — which leaves
 * this one (and its runner) untouched.
 */
export function InterruptDialog({
  activeProjectLabel,
  pending,
  onClose,
  onOpenNewWindow,
}: InterruptDialogProps): JSX.Element {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {pending !== null && (
        <DialogContent>
          <DialogTitle>A runner is working here</DialogTitle>
          <DialogDescription>
            <strong>{activeProjectLabel ?? 'This project'}</strong> has a runner fixing an issue.
            Opening <strong>{pending.label}</strong> in this window would interrupt it. Open{' '}
            <strong>{pending.label}</strong> in a new window instead so the running work keeps
            going?
          </DialogDescription>
          <DialogActions>
            <Button
              variant="primary"
              onClick={() => {
                onOpenNewWindow(pending.path);
                onClose();
              }}
              title="Open the other project in a new window; this window's runner keeps going"
            >
              Open in new window
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                pending.proceed();
                onClose();
              }}
              title="Switch this window now — the running work here is interrupted"
            >
              Switch here anyway
            </Button>
            <Button variant="ghost" className="ui-btn--end" onClick={onClose}>
              Cancel
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );
}
