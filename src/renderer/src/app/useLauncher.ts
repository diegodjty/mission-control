import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  LauncherProject,
  ProjectCardView,
  ProjectView,
  RunTarget,
  TalkTarget,
} from '../../../shared/ipc-contract';
import { stageInvocation, type PlanningStage } from '../../../shared/planning-model';
import { quickFixRunTarget } from '../../../shared/launcher-model';
import { isProjectSwitch } from '../../../shared/project-switch';
import { decideCardOpen } from '../../../shared/open-card-decision';
import { shouldConfirmInterrupt } from '../../../shared/interrupt-guard';
import type { ShellEvent, ViewId } from '../../../shared/shell-model';
import {
  createSubmitPump,
  canFlushChat,
  reduceTyping,
  INITIAL_TYPING_STATE,
  type SubmitPump,
  type TypingState,
} from '../../../shared/submit-pump';
import type { QuickFixIssueRef } from '../Launcher';
import { newRun, type PlanningTargetState, type TrackedRun } from './appTypes';

/** A Project change this Window paused because a runner is live (issue 114). */
export interface PendingProjectChange {
  path: string;
  label: string;
  proceed: () => void;
}

/** A home-card open paused to ask "here or a new Window?" (issue 121). */
export interface PendingOpenChoice {
  path: string;
  label: string;
}

export interface LauncherDeps {
  view: ViewId;
  /** Live mirror of `view`, read by the registry/backlog/attention live effect
   * without re-subscribing on every navigation (issue 115). */
  viewRef: { current: ViewId };
  /** Live mirror of the active Project's key, for the `isProjectSwitch` checks
   * every open/switch flow makes. */
  activeProjectKeyRef: { current: string | null };
  /** The issue ids whose Run session is currently live in this Window — feeds
   * `attemptProjectChange`'s and `openCard`'s interrupt guard. */
  liveRunIssueIds: number[];
  activeProject: ProjectView | null;
  applyShellEvent: (event: ShellEvent) => void;
  setProjects: Dispatch<SetStateAction<ProjectView[]>>;
  setProjectError: (v: string | null) => void;
  setActiveProjectKey: Dispatch<SetStateAction<string | null>>;
  /**
   * Live-callback ref to the manual "▶ Run" path (issue 81's quick-fix
   * Run-now reuses it once the Project it targets is already the one open) —
   * `startRun` is defined in `App.tsx` after this hook is invoked (it needs
   * `liveRunIssueIds`, which `attemptProjectChange`/`openCard` below also
   * need, so the hook is invoked right after that instead of after `startRun`
   * too), so it's read live through this ref like `resetForProjectSwitchRef`.
   */
  startRunRef: { current: ((target: RunTarget) => void) | null };
  setRuns: Dispatch<SetStateAction<TrackedRun[]>>;
  setFocusedId: Dispatch<SetStateAction<number | null>>;
  /**
   * Live-callback ref to `resetForProjectSwitch` (issue 26): that function is
   * defined in `App.tsx` before this hook's own inputs (`liveRunIssueIds`,
   * `startRun`) are ready, so the open/switch flows below read it through this
   * ref rather than widening the ordering the other extracted seams already
   * avoid the same way (`mergeLaneResetRef`, `drainResetRef`).
   */
  resetForProjectSwitchRef: { current: (() => void) | null };
  /** Live-callback ref into the drain-coordinator seam's `dismissDebrief`
   * (issue 186) — same ordering reason as `resetForProjectSwitchRef`. */
  drainDismissDebriefRef: { current: (() => void) | null };
}

export interface Launcher {
  launcherProjects: LauncherProject[];
  projectCards: ProjectCardView[];
  talk: TalkTarget | null;
  talkFocusSignal: number;
  onboardNudge: string | null;
  dismissOnboardNudge: () => void;
  planning: PlanningTargetState | null;
  pendingProjectChange: PendingProjectChange | null;
  setPendingProjectChange: Dispatch<SetStateAction<PendingProjectChange | null>>;
  pendingOpenChoice: PendingOpenChoice | null;
  setPendingOpenChoice: Dispatch<SetStateAction<PendingOpenChoice | null>>;
  /** Opens/reattaches through the normal open/claim flow (ownership rules and
   * all) — the entry point every Project-open surface routes through. */
  openProjectHere: (path: string) => Promise<void>;
  switchProject: (key: string) => Promise<void>;
  /** The live-runner interrupt guard (issue 114) shared by every Project-
   * switch surface (the switcher, the Launcher's Continue list, the Inbox). */
  attemptProjectChange: (change: PendingProjectChange) => void;
  openCard: (card: ProjectCardView) => void;
  startPlanning: (p: LauncherProject) => Promise<void>;
  handlePlanningSession: (sessionId: string) => void;
  handlePlanningSessionEnd: () => void;
  handlePlanningInput: (data: string) => void;
  submitPlanningStage: (stage: PlanningStage) => void;
  landOnNewProject: (created: { workbenchDir: string; label: string }) => Promise<void>;
  talkToProject: (p: LauncherProject) => void;
  talkToFolder: () => Promise<void>;
  endTalk: () => void;
  handleTalkSession: (sessionId: string) => void;
  debriefDrain: () => void;
  runQuickFixNow: (p: LauncherProject, issue: QuickFixIssueRef) => Promise<void>;
  /** Clears the launcher/planning state a Project switch must not carry
   * across (issue 26) — `talk` itself is deliberately excluded: it is
   * anchored to the cwd it was started on, not to any one Project. */
  reset: () => void;
}

/**
 * The Launcher / planning / project-switch seam (issue 187, re-scope of 172):
 * the front-door state every empty Window shows (issue 81, ADR-0016) — the
 * home grid's project list and cards, the Planning view's warm Pane + doc
 * preview (issue 83), the Just-talk bare Pane, the New-project landing nudge
 * (issue 82) — plus the open/switch flows (`openProjectHere`, `switchProject`,
 * `attemptProjectChange`, `openCard`) every Project-open surface in the app
 * (the switcher, the Inbox, the palette, the home grid) routes through.
 *
 * `resetForProjectSwitch` itself stays in `App.tsx`: it also clears state this
 * hook does not own (the drain/merge seams via their own refs, the solo/
 * worktree-commit and Receipt-audit bookkeeping, the Run-tracking and Run-log
 * state). This hook's `reset()` is the one piece of that composition specific
 * to launcher/planning state, called the same way the drain/merge seams'
 * resets are.
 */
export function useLauncher(deps: LauncherDeps): Launcher {
  const {
    view,
    viewRef,
    activeProjectKeyRef,
    liveRunIssueIds,
    activeProject,
    applyShellEvent,
    setProjects,
    setProjectError,
    setActiveProjectKey,
    startRunRef,
    setRuns,
    setFocusedId,
    resetForProjectSwitchRef,
    drainDismissDebriefRef,
  } = deps;

  // --- Launcher state (issue 81, ADR-0016) ----------------------------------
  // The Launcher's project list: every active workbench-registry project with
  // truthful backlog counts, re-read from disk each time the Launcher is
  // shown — coming home always sees current state lines, never a stale cache.
  const [launcherProjects, setLauncherProjects] = useState<LauncherProject[]>([]);
  useEffect(() => {
    if (view !== 'launcher') return;
    let disposed = false;
    void window.mc
      .listLauncherProjects()
      .then((res) => {
        if (!disposed) setLauncherProjects(res.projects);
      })
      .catch(() => {
        // A transient read error keeps the previous list; re-entering retries.
      });
    return () => {
      disposed = true;
    };
  }, [view]);

  // --- Project-first home grid (issue 115, ADR-0019) -------------------------
  // The home page is a chooser: every workbench project as a card (name +
  // open·wip·done + last-activity), clicking one switches this Window in place
  // to that project's Map. Fetched from the portfolio aggregator when Home is
  // shown, and kept live off the EXISTING registry + backlog subscriptions (no
  // new watcher, per the issue) — so a newly registered repo or a status flip
  // re-shapes the grid with no manual refresh.
  const [projectCards, setProjectCards] = useState<ProjectCardView[]>([]);
  const refreshProjectCards = useCallback((): void => {
    void window.mc
      .listProjectCards()
      .then((res) => setProjectCards(res.cards))
      .catch(() => {
        // A transient read error keeps the previous grid; the next event retries.
      });
  }, []);
  useEffect(() => {
    if (view === 'launcher') refreshProjectCards();
  }, [view, refreshProjectCards]);
  useEffect(() => {
    // Only re-shape the grid live while Home is actually showing — off Home,
    // arriving there re-fetches anyway, so this avoids a disk read per backlog
    // tick during a drain the user isn't watching. Issue 118 adds the attention
    // subscription so the needs-you badge (parked HITL) also updates live; the
    // Run-state changes that drive "N running" / the float ride the registry-
    // changed push the backend fires on Run spawn/exit.
    const onChange = (): void => {
      if (viewRef.current === 'launcher') refreshProjectCards();
    };
    const offRegistry = window.mc.onProjectRegistryChanged(onChange);
    const offBacklog = window.mc.onBacklogChanged(onChange);
    const offAttention = window.mc.onAttentionChanged(onChange);
    return () => {
      offRegistry();
      offBacklog();
      offAttention();
    };
  }, [refreshProjectCards, viewRef]);

  // The "Just talk" Pane (issue 81): one warm bare session — no issue, no
  // tracking. Deliberately NOT per-Project state: it is anchored to the cwd it
  // was started on, so a Project switch does not clear it.
  const [talk, setTalk] = useState<TalkTarget | null>(null);
  // The New-project landing nudge (issue 82): after onboarding creates a
  // project, the Window lands on its (empty) Map with a dismissible pointer
  // toward Big feature (planning) or Quick fix. Cleared on dismissal and on
  // any Project switch — it is about the project just created, nothing else.
  const [onboardNudge, setOnboardNudge] = useState<string | null>(null);
  const dismissOnboardNudge = useCallback((): void => setOnboardNudge(null), []);

  // --- Planning view state (issue 83, ADR-0016) ------------------------------
  // Big feature opens the thin Planning view on the chosen project: a warm
  // Pane beside the live doc preview. Per-Project — cleared on a switch. The
  // stage buttons (Grill / PRD / Issues) type their skill invocation into the
  // Pane through a DEDICATED submit-pump instance (issue 60's tested module),
  // honoring its own defer-while-typing gate — the planning session's compose
  // state, not the Dispatcher's.
  const [planning, setPlanning] = useState<PlanningTargetState | null>(null);
  const planningTyping = useRef<TypingState>(INITIAL_TYPING_STATE);
  const planningPumpRef = useRef<SubmitPump | null>(null);
  if (planningPumpRef.current === null) {
    planningPumpRef.current = createSubmitPump({
      write: (sessionId, data) => window.mc.writePty({ sessionId, data }),
      canFlush: (now) => canFlushChat(planningTyping.current, now),
    });
  }
  const planningPump = planningPumpRef.current;
  // Monotonic per-click id so re-clicking a stage button re-sends (the pump
  // dedupes by key; each click is deliberately its own delivery).
  const planningStageSeq = useRef(0);

  // The Just-talk Pane's own submit-pump (issue 152's Debrief affordance
  // reuses the issue-91 type-only pattern): a dedicated instance so its
  // defer-while-typing gate is the talk session's own compose state, not the
  // Dispatcher's or Planning's.
  const talkTyping = useRef<TypingState>(INITIAL_TYPING_STATE);
  const talkPumpRef = useRef<SubmitPump | null>(null);
  if (talkPumpRef.current === null) {
    talkPumpRef.current = createSubmitPump({
      write: (sessionId, data) => window.mc.writePty({ sessionId, data }),
      canFlush: (now) => canFlushChat(talkTyping.current, now),
    });
  }
  const talkPump = talkPumpRef.current;
  const [talkFocusSignal, setTalkFocusSignal] = useState(0);

  // A Project change this Window paused because a runner is live (issue 114):
  // switching/opening a different Project here would tear the running Run down,
  // so `attemptProjectChange` stashes the intended change and shows a
  // confirmation offering "open in a new Window" instead. `path` is what
  // `openWindow` gets (the key/dir is a valid open handle, issue 71); `proceed`
  // performs the in-place change if the human chooses to interrupt anyway. Null
  // when nothing is pending.
  const [pendingProjectChange, setPendingProjectChange] = useState<PendingProjectChange | null>(
    null,
  );
  // A home-card open paused to ask "here or a new Window?" (issue 121). Set when
  // this Window already has a Project open and the user picks a DIFFERENT one
  // from the Launcher grid with no runner live — the choice the project bar's
  // Open here / Open in new Window buttons give, brought to the home grid so two
  // Projects can run side by side without touching the top bar. `path` is the
  // clicked project's workbench dir (a valid `openProject`/`openWindow` handle).
  // Null when nothing is pending. Distinct from `pendingProjectChange`, which is
  // the stronger live-runner interrupt (issue 114).
  const [pendingOpenChoice, setPendingOpenChoice] = useState<PendingOpenChoice | null>(null);

  const openProjectHere = useCallback(async (path: string): Promise<void> => {
    // Only open on an explicit path; an empty path is a no-op, never a claim on
    // the backend cwd (issue 14). The path may be a repo OR a workbench project
    // dir — main resolves either alias to the same Project identity (issue 71).
    if (!path.trim()) return;
    const res = await window.mc.openProject({ path });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      // Opening a different Project than the one active resets its state (issue 26).
      if (isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey)) {
        resetForProjectSwitchRef.current?.();
      }
      setActiveProjectKey(res.activeProjectKey);
      // An explicit open lands on the Map — in particular off the Launcher
      // (issue 81); a no-op elsewhere (opens already happen from the Map).
      applyShellEvent({ kind: 'project-opened' });
    }
  }, [activeProjectKeyRef, applyShellEvent, resetForProjectSwitchRef, setActiveProjectKey, setProjectError, setProjects]);

  const switchProject = useCallback(async (key: string): Promise<void> => {
    const res = await window.mc.switchProject({ key });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      // Clear the previous Project's Runs/scan/merge state before the Map loads
      // the new one, so nothing bleeds across the switch (issue 26).
      if (isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey)) {
        resetForProjectSwitchRef.current?.();
      }
      setActiveProjectKey(res.activeProjectKey);
    }
  }, [activeProjectKeyRef, resetForProjectSwitchRef, setActiveProjectKey, setProjectError, setProjects]);

  // Attempt to change this Window's Project (issue 114). When a runner is live
  // in the current Project, changing here would kill it (resetForProjectSwitch
  // tears the Runs down), so the pure `shouldConfirmInterrupt` gates whether to
  // pause: if it would interrupt a live runner, stash the change and show the
  // "open in a new Window instead?" confirmation; otherwise perform it straight
  // away. The two user-facing switch surfaces — the Project bar switcher and the
  // Launcher's Continue list — both route through here so they behave the same.
  const attemptProjectChange = useCallback(
    (change: PendingProjectChange): void => {
      if (
        shouldConfirmInterrupt({
          hasLiveRunner: liveRunIssueIds.length > 0,
          currentKey: activeProjectKeyRef.current,
          targetKey: change.path,
        })
      ) {
        setPendingProjectChange(change);
      } else {
        change.proceed();
      }
    },
    [activeProjectKeyRef, liveRunIssueIds],
  );

  // A Launcher home-grid card was clicked (issue 121). The pure `decideCardOpen`
  // picks one of three outcomes so this stays a thin dispatcher: open in place
  // (empty Window, or the card is the Project already open here), defer to the
  // live-runner interrupt overlay (issue 114), or — the new case — ask whether
  // to open the picked Project here or in a new Window. That choice used to live
  // only on the top project bar; bringing it to the home grid lets the user run
  // two Projects side by side without reaching for the bar.
  const openCard = useCallback(
    (card: ProjectCardView): void => {
      const decision = decideCardOpen({
        currentKey: activeProjectKeyRef.current,
        cardKey: card.workbenchDir,
        hasLiveRunner: liveRunIssueIds.length > 0,
      });
      if (decision.kind === 'confirm-interrupt') {
        setPendingProjectChange({
          path: card.workbenchDir,
          label: card.label,
          proceed: () => void openProjectHere(card.workbenchDir),
        });
      } else if (decision.kind === 'choose-window') {
        setPendingOpenChoice({ path: card.workbenchDir, label: card.label });
      } else {
        // open-here: switch this Window in place (a no-op re-open when the card
        // is already the active Project — openProjectHere lands back on the Map).
        void openProjectHere(card.workbenchDir);
      }
    },
    [activeProjectKeyRef, openProjectHere, liveRunIssueIds],
  );

  // --- Launcher actions (issue 81, ADR-0016) --------------------------------

  // Big feature (issue 83): open the chosen project through the NORMAL
  // open/claim flow (ownership rules and all — a refusal shows in the project
  // bar and the Window stays on the Launcher), then land on the Planning view:
  // a warm Pane beside the live doc preview.
  const startPlanning = useCallback(
    async (p: LauncherProject): Promise<void> => {
      const res = await window.mc.openProject({ path: p.workbenchDir });
      setProjects(res.projects);
      setProjectError(res.error);
      if (!res.ok) return;
      if (isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey)) {
        resetForProjectSwitchRef.current?.();
      }
      setActiveProjectKey(res.activeProjectKey);
      const projectView = res.projects.find((v) => v.key === res.activeProjectKey) ?? null;
      setPlanning({
        workbenchDir: p.workbenchDir,
        repoPath: projectView?.defaultRepoPath ?? p.defaultRepoPath,
        label: p.label,
      });
      applyShellEvent({ kind: 'planning-started' });
    },
    [activeProjectKeyRef, applyShellEvent, resetForProjectSwitchRef, setActiveProjectKey, setProjectError, setProjects],
  );

  // The planning Pane's session lifecycle: attach the pump to the live PTY so
  // stage invocations reach THIS session (and are requeued for a replacement
  // if it dies mid-delivery — the pump's issue-60 guarantees).
  const handlePlanningSession = useCallback(
    (sessionId: string): void => planningPump.attachSession(sessionId),
    [planningPump],
  );
  const handlePlanningSessionEnd = useCallback(
    (): void => planningPump.attachSession(null),
    [planningPump],
  );
  // Fold the user's keystrokes into the planning compose state (issue 48's
  // gate): a stage invocation never interleaves with the user's own typing.
  const handlePlanningInput = useCallback((data: string): void => {
    planningTyping.current = reduceTyping(planningTyping.current, data, Date.now());
  }, []);
  // A stage button click: deliver the skill invocation through the pump —
  // typed then submitted for PRD/Issues; typed as an UNsubmitted prefix for
  // Grill, whose topic the user finishes themselves (issue 91). The pump's
  // defer-while-typing gate applies to both kinds.
  const submitPlanningStage = useCallback(
    (stage: PlanningStage): void => {
      planningStageSeq.current += 1;
      const invocation = stageInvocation(stage);
      planningPump.enqueue({
        key: `planning-stage:${stage}:${planningStageSeq.current}`,
        text: invocation.text,
        submit: invocation.submit,
      });
    },
    [planningPump],
  );

  // New project (issue 82): the guided flow just created and committed the
  // workbench project — land this Window on it through the NORMAL open flow
  // (so ownership/identity work exactly as any open), then show the nudge
  // toward Big feature or Quick fix on the empty Map. The nudge is set AFTER
  // the open, because a project switch deliberately clears it.
  const landOnNewProject = useCallback(
    async (created: { workbenchDir: string; label: string }): Promise<void> => {
      await openProjectHere(created.workbenchDir);
      setOnboardNudge(created.label);
    },
    [openProjectHere],
  );

  // Just talk (issue 81): one warm bare Pane — CORE.md injected for workbench
  // projects (main reads it at the spawn edge), nothing claimed or tracked.
  const startTalk = useCallback(
    (target: TalkTarget): void => {
      setTalk(target);
      applyShellEvent({ kind: 'run-started' });
    },
    [applyShellEvent],
  );

  const talkToProject = useCallback(
    (p: LauncherProject): void =>
      startTalk({ cwd: p.defaultRepoPath, workbenchProjectRoot: p.workbenchDir, label: p.label }),
    [startTalk],
  );

  const talkToFolder = useCallback(async (): Promise<void> => {
    const { path } = await window.mc.pickProjectFolder();
    if (!path) return;
    startTalk({
      cwd: path,
      workbenchProjectRoot: null,
      label: path.split('/').filter(Boolean).pop() ?? path,
    });
  }, [startTalk]);

  const endTalk = useCallback((): void => {
    setTalk(null);
    talkPump.reset();
  }, [talkPump]);

  const handleTalkSession = useCallback(
    (sessionId: string): void => talkPump.attachSession(sessionId),
    [talkPump],
  );

  // "Debrief this drain" (issue 152): open/focus the Just-talk Pane for the
  // active Project with `/debrief` typed but unsubmitted — the issue-91
  // pattern (the human finishes the sentence and presses enter themselves).
  // No project focus ⇒ nothing louder than a no-op (the affordance simply
  // does nothing, per the issue's out-of-scope note).
  const debriefDrain = useCallback((): void => {
    if (activeProject === null) return;
    drainDismissDebriefRef.current?.();
    startTalk({
      cwd: activeProject.defaultRepoPath,
      workbenchProjectRoot: activeProject.key,
      label: activeProject.label,
    });
    talkPump.enqueue({ key: `debrief:${activeProject.key}`, text: '/debrief', submit: false });
    setTalkFocusSignal((n) => n + 1);
  }, [activeProject, drainDismissDebriefRef, startTalk, talkPump]);

  // Quick fix's Run now (issue 81): open the chosen project through the
  // NORMAL open/claim flow, then launch exactly ONE bare Run on the freshly
  // written issue (no Dispatcher — ADR-0010: a single manual Run stays a bare
  // Pane). The target is built ENTIRELY from the created issue's project
  // (issue 88, walkthrough-86 finding): re-deriving paths from the open
  // result's window-active state let an issue created in project A spawn a
  // Run with project B's repo + workbench paths — the created issue's
  // identity is carried end-to-end instead.
  const runQuickFixNow = useCallback(
    async (p: LauncherProject, issue: QuickFixIssueRef): Promise<void> => {
      const res = await window.mc.openProject({ path: p.workbenchDir });
      setProjects(res.projects);
      setProjectError(res.error);
      if (!res.ok) {
        // Owned by another Window (or any open failure): the issue is safely
        // queued in the backlog either way — surface the reason and stay put.
        return;
      }
      const switched = isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey);
      if (switched) resetForProjectSwitchRef.current?.();
      setActiveProjectKey(res.activeProjectKey);
      const target: RunTarget = quickFixRunTarget(p, issue);
      if (switched) {
        // The Window just landed on this project: the per-Project state
        // (backlog, scan, runs) in this closure is the PREVIOUS project's —
        // or empty — so `startRun`'s isolation reconcile must not run against
        // it. The freshly created issue is by construction the lone Run here:
        // add it directly, exactly as startRun's unresolved-project fallback
        // does — a single bare Pane on the issue's target repo.
        setRuns((prev) =>
          prev.some((r) => r.target.issueId === target.issueId) ? prev : [...prev, newRun(target)],
        );
        setFocusedId(target.issueId);
        applyShellEvent({ kind: 'run-started' });
      } else {
        // Same project already open: the normal path, with its duplicate and
        // concurrency-isolation guards against the live Run set.
        startRunRef.current?.(target);
      }
    },
    [
      activeProjectKeyRef,
      applyShellEvent,
      resetForProjectSwitchRef,
      setActiveProjectKey,
      setFocusedId,
      setProjectError,
      setProjects,
      setRuns,
      startRunRef,
    ],
  );

  const reset = useCallback((): void => {
    // An Inbox focus request / the New-project nudge are handled by the
    // caller / here respectively — the Planning view is about ONE project
    // (issue 83): drop it — and its pump/typing state — so the next project
    // never inherits a planning Pane or a queued stage invocation. If this
    // Window was ON the Planning view, land on the Map (the view would
    // otherwise render nothing).
    setOnboardNudge(null);
    setPlanning(null);
    planningPumpRef.current?.reset();
    planningTyping.current = INITIAL_TYPING_STATE;
    applyShellEvent({ kind: 'planning-closed' });
    // The Just-talk pump's queued/deferred sends are per-Project (a stage
    // invocation typed for the project being left is meaningless in the
    // next one) — but `talk` itself deliberately survives the switch (see
    // its own state comment above).
    talkPumpRef.current?.reset();
  }, [applyShellEvent]);

  return {
    launcherProjects,
    projectCards,
    talk,
    talkFocusSignal,
    onboardNudge,
    dismissOnboardNudge,
    planning,
    pendingProjectChange,
    setPendingProjectChange,
    pendingOpenChoice,
    setPendingOpenChoice,
    openProjectHere,
    switchProject,
    attemptProjectChange,
    openCard,
    startPlanning,
    handlePlanningSession,
    handlePlanningSessionEnd,
    handlePlanningInput,
    submitPlanningStage,
    landOnNewProject,
    talkToProject,
    talkToFolder,
    endTalk,
    handleTalkSession,
    debriefDrain,
    runQuickFixNow,
    reset,
  };
}
