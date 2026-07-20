import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pane } from './Pane';
import { Map } from './Map';
import { ProjectSwitcher } from './ProjectSwitcher';
import { CommandPalette } from './CommandPalette';
import { Attention } from './Attention';
import { Launcher, type QuickFixIssueRef } from './Launcher';
import { PlanningView } from './PlanningView';
import { ReceiptsView } from './ReceiptsView';
import { CostView } from './CostView';
import { DocsView } from './DocsView';
import { AppShell } from './AppShell';
import {
  GitInitDialog,
  BranchPromptDialog,
  OpenChoiceDialog,
  InterruptDialog,
} from './AppDialogs';
import { stageInvocation, type PlanningStage } from '../../shared/planning-model';
import { quickFixRunTarget } from '../../shared/launcher-model';
import {
  workbenchProjectPath,
  needsYouCount,
  type AttentionItem,
  type JournalFile,
} from '../../shared/attention-hub-model';
import type { Backlog, IssueStatus } from '../../shared/backlog-model';
import type {
  AttentionSnapshot,
  NavigateAttentionMessage,
  LauncherProject,
  ProjectCardView,
  ProjectView,
  RunLogRecord,
  RunTarget,
  TalkTarget,
  GitBranchStatusResult,
} from '../../shared/ipc-contract';
import {
  renderCompletionEvent,
  toCompletionEvent,
} from '../../shared/capture-contract';
import {
  createSubmitPump,
  canFlushChat,
  reduceTyping,
  INITIAL_TYPING_STATE,
  type SubmitPump,
  type TypingState,
} from '../../shared/submit-pump';
import {
  actionForLifecycle,
  lifecycleKindForOutcome,
  reactToLifecycleEvent,
  type LifecycleEvent,
} from '../../shared/run-lifecycle';
import { isProtectedBranch, type DispatcherAction } from '../../shared/action-authority';
import { isRealCapture, isRealDocDrift } from '../../shared/notification-noise-floor';
import {
  reconcileStatusModel,
  renderStatusModel,
  debounceStatusModel,
  initialStatusDebounceState,
  type DrainStatusModel,
  type StatusDebounceState,
} from '../../shared/drain-status-model';
import {
  deriveRunStatus,
  observedIssueStatus,
  runningIssueIds,
  decideSoloCommitStep,
  type RunStatus,
  type SoloCommitPhase,
} from '../../shared/run-state';
import {
  auditMissingReceipts,
  detectReceiptStateMismatches,
  describeReceiptMismatch,
  hasReceiptFor,
  latestReceiptOutcomeFor,
  mismatchKey,
} from '../../shared/receipt-audit';
import { branchGuardDecision } from '../../shared/run-coordinator';
import { takeoverKindFor, takeoverTarget } from '../../shared/run-takeover';
import { hasInFlightRun } from '../../shared/run-eligibility';
import {
  repoForIssue,
  unknownRepoKeyNote,
  plannedRepoHoldNote,
  type IssueRepoResolution,
} from '../../shared/run-targeting';
import {
  canFallBackToMain,
  isolationRunSetWith,
  runNeedsIsolation,
  type IsolationRun,
} from '../../shared/isolation-policy';
import {
  afkScanUnchanged,
  deriveWorktreeRunStates,
  dropMergedBranches,
  markBranchCommitted,
  needsWorktreeCommit,
} from '../../shared/worktree-scan';
import {
  isProjectSwitch,
  scanForProject,
  type ScopedScan,
} from '../../shared/project-switch';
import { shouldConfirmInterrupt } from '../../shared/interrupt-guard';
import {
  DEFAULT_VIEW,
  isSlotMounted,
  shellTabs,
  viewAfterEvent,
  type ShellContext,
  type ShellEvent,
  type ViewId,
} from '../../shared/shell-model';
import { mergeProviders, type Command } from '../../shared/command-registry';
import { decideCardOpen } from '../../shared/open-card-decision';
import {
  orphanedClaims,
  reopenWipToOpen,
  type ReleasableClaim,
  type TrackedClaim,
} from '../../shared/drain-interruption';
import { branchPreviewsEqual } from '../../shared/merge-preview';
import { gridShape } from '../../shared/pane-grid';
import { decideWindowBootstrap } from '../../shared/window-bootstrap';
import {
  loadTheme,
  oneLineNote,
  protectedLandWarning,
  slugOf,
  RECEIPT_AUDIT_GRACE_MS,
  THEME_KEY,
  RAIL_COLLAPSED_KEY,
  type Theme,
} from './app/appHelpers';
import { newRun, type InboxFocus, type PlanningTargetState, type TrackedRun } from './app/appTypes';
import { useMergeLane, type ProtectedMergeLandTarget } from './app/useMergeLane';
import { useDrain } from './app/useDrain';
import { RunTile } from './RunTile';

/**
 * The Project Window: a header with a Map/Pane switch. The Map (issue 02) is
 * the birds-eye backlog view; the Pane (issue 01) is the live interactive
 * terminal. Issue 03 wires a single Run; issue 05 makes the Map self-update
 * from disk. Issue 06 adds **draining with a concurrency cap**: the pure Run
 * Coordinator (run-coordinator) decides, from the live backlog + the cap + the
 * Runs already in flight, which eligible issues start now, which queue, and
 * when to stop — and this component opens a fresh Pane per started Run and
 * re-plans on every backlog/Run-status change so queued Runs auto-start as
 * slots free.
 */
export function App(): JSX.Element {
  // Every EMPTY Window is the Launcher (issue 81, ADR-0016): the front door
  // is the initial view; opening/re-attaching a Project lands on the Map, and
  // the Home tab returns here any time — without closing the open Project.
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW);
  // A live mirror of `view` for subscription handlers that must know the
  // current view without re-subscribing on every navigation (issue 115).
  const viewRef = useRef<ViewId>(DEFAULT_VIEW);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // The shell's live facts (shell-model, issue 123): what the tabs, badges,
  // and keep-mounted hosting derive from. The ref mirrors the memo below
  // (assigned each render, the viewRef pattern) so the stable event applier
  // never closes over stale facts.
  const shellCtxRef = useRef<ShellContext>({
    hasPlanning: false,
    runCount: 0,
    hasTalk: false,
    attentionNeedsYou: 0,
  });
  // Every view move goes through the pure `viewAfterEvent`: scattered
  // hand-coded setView rules became named shell events the model owns.
  const applyShellEvent = useCallback((event: ShellEvent): void => {
    setView((cur) => viewAfterEvent(cur, event, shellCtxRef.current));
  }, []);
  const [paneStatus, setPaneStatus] = useState('starting…');

  // The UI theme (Atlas design language): dark navy stage by default, with a
  // light variant. Persisted, and mirrored onto <html data-theme> so the CSS
  // token layer in index.css switches the whole app in one place.
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode / storage disabled — theme still applies for the session */
    }
  }, [theme]);
  const toggleTheme = useCallback(
    (): void => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  );

  // The Atlas rail's on-demand collapse (issue 124): a manual toggle, persisted
  // so a Window reopens the way the user left it. Narrow width ALSO collapses
  // the rail (CSS), independent of this flag — so the flag is purely the user's
  // explicit preference, never fighting the responsive breakpoint.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0');
    } catch {
      /* storage disabled — the toggle still applies for the session */
    }
  }, [railCollapsed]);

  // The Cmd+K command palette's open state (issue 124). Opened from anywhere
  // by the shortcut or the header search button; every command it runs routes
  // through the same flow its click-counterpart does (palette safety == click
  // safety, ADR-0020).
  const [paletteOpen, setPaletteOpen] = useState(false);

  // The live backlog + resolved Project path, lifted from the Map so the
  // Coordinator can plan against them.
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  // --- Project Registry state (issue 09, ADR-0004; identity per issue 71) ---
  // This Window shows one Project; the single backend arbitrates ownership so
  // no two Windows manage the same Project. `activeProjectKey` (from the
  // registry) is the Project's resolved identity — a workbench project dir or
  // a legacy repo path — and is what the Map loads.
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  // A Project change this Window paused because a runner is live (issue 114):
  // switching/opening a different Project here would tear the running Run down,
  // so `attemptProjectChange` stashes the intended change and shows a
  // confirmation offering "open in a new Window" instead. `path` is what
  // `openWindow` gets (the key/dir is a valid open handle, issue 71); `proceed`
  // performs the in-place change if the human chooses to interrupt anyway. Null
  // when nothing is pending.
  const [pendingProjectChange, setPendingProjectChange] = useState<{
    path: string;
    label: string;
    proceed: () => void;
  } | null>(null);
  // A home-card open paused to ask "here or a new Window?" (issue 121). Set when
  // this Window already has a Project open and the user picks a DIFFERENT one
  // from the Launcher grid with no runner live — the choice the project bar's
  // Open here / Open in new Window buttons give, brought to the home grid so two
  // Projects can run side by side without touching the top bar. `path` is the
  // clicked project's workbench dir (a valid `openProject`/`openWindow` handle).
  // Null when nothing is pending. Distinct from `pendingProjectChange`, which is
  // the stronger live-runner interrupt (issue 114).
  const [pendingOpenChoice, setPendingOpenChoice] = useState<{
    path: string;
    label: string;
  } | null>(null);
  // Drain-time "Initialize git" offer (issue 158, ADR-0017): pressing Drain
  // with cap > 1 on a project whose workspace root isn't a git repo yet opens
  // this instead of silently proceeding — `cap` is the chosen concurrency to
  // resume with once the human picks Initialize git or Drain serially. Null
  // when nothing is pending.
  const [gitInitPrompt, setGitInitPrompt] = useState<{ cap: number } | null>(null);
  const [gitInitBusy, setGitInitBusy] = useState(false);
  const [gitInitError, setGitInitError] = useState<string | null>(null);
  // Branch awareness before Run/drain (issue 167): the Project checkout's
  // CURRENT branch, polled live so the Map badge and the pre-start gate below
  // never act on a stale read (the human may switch branches outside MC).
  const [branchStatus, setBranchStatus] = useState<GitBranchStatusResult | null>(null);
  // A pending Run/drain caught on a protected branch or detached HEAD (issue
  // 167): null when nothing is held. `create`/`switch` sub-modes reuse the
  // same dialog; resolving either (or Proceed anyway) resumes the held action.
  const [branchPrompt, setBranchPrompt] = useState<
    { kind: 'run'; target: RunTarget } | { kind: 'drain'; cap: number } | null
  >(null);
  const [branchPromptMode, setBranchPromptMode] = useState<'choose' | 'create' | 'switch'>(
    'choose',
  );
  const [branchPromptName, setBranchPromptName] = useState('');
  const [branchPromptBranches, setBranchPromptBranches] = useState<string[]>([]);
  const [branchPromptSelected, setBranchPromptSelected] = useState('');
  const [branchPromptBusy, setBranchPromptBusy] = useState(false);
  const [branchPromptError, setBranchPromptError] = useState<string | null>(null);
  // Mirrors `activeProjectKey` for the callbacks/effects that need the CURRENT
  // active Project without re-subscribing (issue 26): they compare it against
  // an incoming key via `isProjectSwitch` to decide whether to reset
  // per-Project state, and a live ref keeps that decision correct without
  // widening deps.
  const activeProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    activeProjectKeyRef.current = activeProjectKey;
  }, [activeProjectKey]);

  // Bootstrap this Window exactly once: pick up any repo the opener queued, else
  // re-attach to whatever this Window already owns, else open NO Project (empty
  // state). The pure `decideWindowBootstrap` makes that choice — and never
  // resolves to the backend cwd, so a plain new Window can't phantom-claim the
  // app's own repo (issue 14).
  //
  // The ref guard makes this a true one-shot: React StrictMode double-invokes
  // effects in dev (setup → cleanup → setup), which previously let a duplicate
  // `listProjects` read consume the queued target and drop into the cwd
  // fallback. The queued target is now peeked (not consumed) on the main side,
  // and this guard ensures we act on it exactly once regardless.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void window.mc.listProjects().then((list) => {
      setProjects(list.projects);
      const decision = decideWindowBootstrap({
        pendingOpen: list.pendingOpen,
        activeProjectKey: list.activeProjectKey,
      });
      if (decision.kind === 'open') {
        void openProjectHere(decision.path);
      } else if (decision.kind === 'reattach') {
        setActiveProjectKey(decision.key);
        applyShellEvent({ kind: 'window-reattached' });
      }
      // 'empty' → leave activeProjectKey null; the Window stays on the
      // Launcher (issue 81). We never open the backend cwd here.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any Window opening/closing/switching a repo changes ownership everywhere —
  // refresh this Window's switcher so a repo freed elsewhere becomes openable.
  // If THIS Window's active repo is handed a different one out from under it
  // (another Window switched the shared active Project), reset the per-Project
  // run/merge state too, so the new Project never inherits the old one's Runs
  // or indicators (issue 26).
  useEffect(() => {
    const off = window.mc.onProjectRegistryChanged(() => {
      void window.mc.listProjects().then((list) => {
        setProjects(list.projects);
        const next = list.activeProjectKey;
        if (next !== null && isProjectSwitch(activeProjectKeyRef.current, next)) {
          resetForProjectSwitch();
        }
        setActiveProjectKey((cur) => next ?? cur);
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Inbox state (issue 80, ADR-0016) -------------------------------------
  // The aggregated cross-project attention snapshot: pulled once on mount (so
  // a fresh Window doesn't wait for the next change) and kept live off the
  // broadcast. App-wide, NOT per-Project — the Inbox shows every active
  // workbench project regardless of what this Window has open, so it is
  // deliberately not cleared on a Project switch.
  const [attention, setAttention] = useState<AttentionSnapshot>({
    workbenchRoot: '',
    items: [],
    notes: [],
  });
  useEffect(() => {
    let disposed = false;
    void window.mc.listAttention().then((snapshot) => {
      if (!disposed) setAttention(snapshot);
    });
    const off = window.mc.onAttentionChanged(setAttention);
    return () => {
      disposed = true;
      off();
    };
  }, []);
  // The last click-through's outcome when it could NOT open the project (the
  // owned-elsewhere case) — shown quietly inside the Inbox, per its
  // "handled gracefully" acceptance. Cleared by the next successful open.
  const [inboxNotice, setInboxNotice] = useState<string | null>(null);
  // What the last successful click-through asked to focus, plus a bump so
  // re-clicking the same item re-focuses it in the Map.
  const [inboxFocus, setInboxFocus] = useState<InboxFocus | null>(null);
  const [inboxFocusSeq, setInboxFocusSeq] = useState(0);

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
  }, [refreshProjectCards]);
  // The "Just talk" Pane (issue 81): one warm bare session — no issue, no
  // tracking. Deliberately NOT per-Project state: it is anchored to the cwd it
  // was started on, so a Project switch does not clear it.
  const [talk, setTalk] = useState<TalkTarget | null>(null);
  // The New-project landing nudge (issue 82): after onboarding creates a
  // project, the Window lands on its (empty) Map with a dismissible pointer
  // toward Big feature (planning) or Quick fix. Cleared on dismissal and on
  // any Project switch — it is about the project just created, nothing else.
  const [onboardNudge, setOnboardNudge] = useState<string | null>(null);

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

  // --- Run state -----------------------------------------------------------
  const [runs, setRuns] = useState<TrackedRun[]>([]);
  // Each solo Run's Receipt-aware auto-commit lifecycle (issues 25 + 59), keyed
  // by issue id. "Finished" for the solo commit means *done flip AND Receipt
  // present*: the skill writes the Receipt LAST, so committing on the flip
  // observation alone raced it and left the Receipt untracked on `main`,
  // failing every later Merge preflight. The pure `decideSoloCommitStep` drives
  // each observation: wait for the Receipt within a grace window (timers below),
  // commit once with everything, and pick up a late straggler Receipt with an
  // idempotent follow-up. Cleared for an id when a genuinely fresh Run of it
  // starts; a rejected commit reverts the phase so a later observation retries.
  // (Plain records, not Maps — the `Map` identifier here is the backlog-Map
  // React component imported above.)
  const soloCommitPhases = useRef<Record<number, SoloCommitPhase>>({});
  // The per-issue Receipt grace timers, and which ids' windows have elapsed.
  const soloGraceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const soloGraceElapsed = useRef<Set<number>>(new Set<number>());
  // Stray Receipts the SOLO commit path adopted (issue 62), queued here until
  // the ambient-log effect below (after `logNote` exists) turns each batch into
  // one passive `receipt-adopt` note.
  const [soloAdoptions, setSoloAdoptions] = useState<string[][]>([]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  // Which tile (if any) is maximized to fill the Pane area; null = tiled grid.
  const [maximizedId, setMaximizedId] = useState<number | null>(null);

  // The cross-project needs-you count for the Attention rail badge (issue 124,
  // re-pointed in issue 125): THE one needs-you number, straight from
  // `attention-hub-model`. The rail badge, the Launcher card counts (main sums
  // the same model per project), and the surface header all read this, so they
  // can never disagree.
  const attentionNeedsYou = useMemo(() => needsYouCount(attention.items), [attention]);

  // The shell context (shell-model, issue 123): the Plan tab and Planning
  // host follow the planning session; the Pane tab's count and the grid's
  // keep-mounted hosting follow the tracked Runs and the talk session; the
  // Attention entry's badge follows the needs-you count (issue 124).
  const shellCtx = useMemo<ShellContext>(
    () => ({
      hasPlanning: planning !== null,
      runCount: runs.length,
      hasTalk: talk !== null,
      attentionNeedsYou,
    }),
    [planning, runs, talk, attentionNeedsYou],
  );
  shellCtxRef.current = shellCtx;

  // --- Run log (issue 34, ADR-0013) ----------------------------------------
  // The Completion-block records for the active Project, newest first — read
  // from Receipts (the sole capture input, issue 57). Loaded from disk when a
  // Project opens (so the feed survives closing Panes / the app / restarts)
  // and upserted as the Receipt edge ingests each Run's Receipt.
  const [runLog, setRunLog] = useState<RunLogRecord[]>([]);
  // The active Project's raw drain-journal entries (issue 181's Cost tab): a
  // one-shot read per Project switch, not a live watch — a drain grouping is
  // frozen the moment its journal entry lands, so there's nothing to observe
  // between visits.
  const [journals, setJournals] = useState<JournalFile[]>([]);
  // Live mirror of `projectPath` so an async result that resolves after a
  // Project switch can tell it belongs to the previous Project and skip the
  // feed upsert.
  const projectPathRef = useRef<string | null>(null);
  // Live mirror of `runLog` for the Receipt audits' grace-window re-checks
  // (issue 57): a timer that fires after the window must judge the CURRENT
  // log, not the render it was scheduled in.
  const runLogRef = useRef<RunLogRecord[]>([]);
  useEffect(() => {
    runLogRef.current = runLog;
  }, [runLog]);
  // Which issues' ended Runs the finished-without-receipt audit has already
  // scheduled/noted, and which Receipt/state mismatches have been surfaced —
  // so each yields at most ONE passive note (issue 57), never a per-render or
  // per-tick repeat.
  const receiptAudited = useRef<Set<number>>(new Set<number>());
  const mismatchSurfaced = useRef<Set<string>>(new Set<string>());

  // --- Ambient activity log (issue 36/38/43, ADR-0011/0012) ----------------
  // Retired the Dispatcher conversation itself (ADR-0022): no orchestrator
  // session, no chat PTY, no approve/reject gate. What remains is the ambient
  // NOTE-taking this apparatus already did alongside the chat — a Run
  // completing, a stray Receipt adopted, ground truth moving — because the
  // drain journal (issue 73, ADR-0015) reads its notable entries (adoptions,
  // finished-without-receipt) into each drain's memory summary. `activityFed`
  // tracks which Run-log records have already produced a note, so a
  // re-render/re-scan doesn't double-note one.
  const activityFed = useRef<Set<string>>(new Set<string>());
  // The ambient note log (issue 36, ADR-0011 as narrowed by ADR-0022): plain
  // `{ id, label }` facts — a Run completed, a stray Receipt was adopted, a
  // doc-drift finding, a status refresh — kept only because the drain journal
  // folds its notable entries into each drain's memory summary. There is no
  // more approve/reject gate: the chat surface that owned it is retired.
  const [activityNotes, setActivityNotes] = useState<{ id: string; label: string }[]>([]);
  // Live mirror of `activityNotes` for the drain-journal write (issue 73): its
  // grace-window timer must read the CURRENT list (a notable event — an
  // adoption, a finished-without-receipt note — may land after the drain's
  // stop was observed), not the render it was scheduled in.
  const activityNotesRef = useRef<{ id: string; label: string }[]>([]);
  useEffect(() => {
    activityNotesRef.current = activityNotes;
  }, [activityNotes]);
  // Lifecycle-event reactions (issue 37): which lifecycle events (keyed
  // `<kind>:<runId>`) have already produced a note, so a re-render / re-scan
  // doesn't re-note one.
  const lifecycleReacted = useRef<Set<string>>(new Set<string>());
  // Ground-truth status re-grounding (issue 43): the last status-model text
  // noted, so it is re-noted only when the reconciled done/wip/open/
  // finished-unmerged picture actually changes — not on every render/poll.
  const statusRefreshSig = useRef<string | null>(null);
  // Debounce backward status moves (issue 49, ADR-0012): the state carried
  // between reconcile checkpoints so a transient mid-reconcile regression (the
  // false "05/06/07 regressed to open — merge is failing" blip) is held until it
  // persists across a further checkpoint before being surfaced. `seenReconciled`
  // makes the advance idempotent under StrictMode's double-invoke: the debounce
  // advances exactly once per DISTINCT reconciled model, never twice for one.
  const statusDebounce = useRef<StatusDebounceState>(initialStatusDebounceState());
  const seenReconciled = useRef<DrainStatusModel | null>(null);
  const debouncedStatusModelRef = useRef<DrainStatusModel | null>(null);

  // Merge/auto-merge-lane state + handlers are extracted to `./app/useMergeLane`
  // (issue 185); `mergeLaneResetRef` lets `resetForProjectSwitch` (defined below,
  // before the hook is invoked further down where its inputs are ready) clear the
  // lane's state without reaching into it directly — the same ref-to-latest-
  // callback pattern `talkPumpRef` already uses for the same ordering reason.
  const mergeLaneResetRef = useRef<(() => void) | null>(null);

  // Same ref-to-latest-callback pattern for the drain-coordinator seam
  // (`./app/useDrain`, issue 186) — `resetForProjectSwitch` clears its
  // draining/message/debrief state without reaching into the hook directly.
  const drainResetRef = useRef<(() => void) | null>(null);
  // `debriefDrain` (below) is defined before the hook's inputs (`logNote`) are
  // ready, so it dismisses the "Debrief this drain" affordance through this
  // same ref-to-latest-callback indirection.
  const drainDismissDebriefRef = useRef<(() => void) | null>(null);

  // --- Protected-branch guard (issue 113) ----------------------------------
  // Before a Run's work LANDS on a protected branch (`main`/`master`), the drain
  // STOPS: `protectedGatedSoloIds` holds solo Run ids whose `main`-commit is
  // withheld, so the commit effect stops re-firing (and looping) on them.
  // `protectedLandTargets` records what confirming the land would re-execute
  // (the merge, or a specific solo commit) — currently write-only (see this
  // issue's Doc drift note: the chat panel that owned the confirm click is
  // retired and nothing has replaced it yet). Reset on Project switch, like the
  // other bookkeeping.
  const protectedGatedSoloIds = useRef<Set<number>>(new Set<number>());
  const protectedLandTargets = useRef<
    Record<
      string,
      | { kind: 'merge'; slugs: string[]; auto: boolean }
      | { kind: 'solo'; issueId: number; nextPhase: SoloCommitPhase }
    >
  >({});
  // The solo-commit path resolves its withheld landings here (a state queue),
  // drained into a proposal + chat warning by an effect below — `commitSoloRun`
  // runs before the surfacing helpers exist, mirroring `soloAdoptions` (issue 62).
  const [soloProtectedGates, setSoloProtectedGates] = useState<
    { issueId: number; branch: string; nextPhase: SoloCommitPhase }[]
  >([]);

  // --- Isolated-Run completion (issue 13/30) -------------------------------
  // An isolated Run works in its own worktree on an `afk/NN-slug` branch and
  // flips its issue to `done` there — a change the main-checkout backlog watcher
  // never sees. Its completion is now read from the SAME on-disk `afk/` scan that
  // drives the Map (issue 30): the branch's committed status is the authoritative
  // "finished" source (issue 15), so there is one source of truth for both the
  // Pane tile and the Map — no separate per-Run status poll racing the scan, and
  // no running↔finished flicker. See `committedStatusById` below.

  // Isolated Runs whose finished worktree MC has already asked to commit onto its
  // `afk/` branch (issue 30). The commit is now EVENT-driven — fired once on the
  // finished transition the scan reports (worktree `done`, branch tip not) —
  // instead of on every status-read tick (the old poll committed a git write per
  // tick). Cleared for an id when a fresh Run of it starts / it is dismissed /
  // discarded / merged, so a later Run of the same id commits its own work.
  const committedWorktreeIds = useRef<Set<number>>(new Set<number>());

  // The auto-commit failure (if any) observed for each isolated Run, keyed by
  // issue id (issue 22, corr-5). A finished Run whose commit failed shows a
  // distinct "commit failed" state carrying this message — the failure is
  // surfaced, not swallowed. Null/absent means no failure seen.
  const [worktreeCommitErrors, setWorktreeCommitErrors] = useState<
    Record<number, string | null>
  >({});

  // --- On-disk afk/ scan (issue 16) ----------------------------------------
  // The ground truth for which issues have an in-flight or finished-but-unmerged
  // isolated Run lives in the Project's `afk/NN-slug` worktrees + committed
  // branches, NOT in `runs` above — so the Map's progress indicators and the
  // Merge affordance keep working after every Pane is closed (which drops the
  // in-memory Runs). Polled from disk whenever a Project is open; the pure
  // `worktree-scan` selectors turn these facts into what the UI shows.
  //
  // Tagged with the Project it was scanned for (issue 26): the scan is only ever
  // read through `scanForProject` against the active Project, so a scan taken
  // for the previous Project — whether still in state right after a switch or
  // kept after a transient scan error — can never mark the new Project's issues
  // (its id-keyed indicators would otherwise bleed: A's "05 finished-unmerged"
  // lighting up B's issue 05 and offering a bogus Merge). Null = not scanned yet.
  const [afkScan, setAfkScan] = useState<ScopedScan | null>(null);

  // A live snapshot of each tracked Run's orphan-relevant facts (issue 112), so
  // the project-switch teardown can release the claims it is ABOUT to kill
  // without widening `resetForProjectSwitch`'s (deliberately []-dep) closure.
  // Kept current by the effect just after `runStatusOf` exists.
  const drainClaimsRef = useRef<TrackedClaim[]>([]);

  // Release the in-flight claims a project-switch teardown is about to orphan
  // (issue 112). `resetForProjectSwitch` clears the tracked Runs, which unmounts
  // their Panes and kills their PTY sessions — and a Worker killed mid-flight has
  // already flipped its issue to `wip` (its claim). With no live Worker and the
  // drain torn down too, that `wip` is stranded: exactly the "came back and the
  // runner had stopped leaving an issue wip" report. A killed claim is void, so
  // we reopen it (the afk-issue-runner skill's own "flip it back to open"
  // recovery) in the project being LEFT, letting a later drain pick it up clean.
  // Best-effort and race-safe: re-read each file and reopen only while it is
  // STILL `wip` (a Worker that flipped `done` in the same beat is never
  // clobbered), targeting the leaving project explicitly so a concurrent switch
  // can't misroute the write. Never throws into the switch path.
  const releaseOrphanedClaims = useCallback(
    (leavingProject: string, claims: ReleasableClaim[]): void => {
      for (const c of claims) {
        void window.mc
          .readIssueFile({ projectPath: leavingProject, fileName: c.fileName })
          .then((res) => {
            if (res.content === null) return undefined;
            const reopened = reopenWipToOpen(res.content);
            if (reopened === null) return undefined; // no longer wip — leave it
            return window.mc.editIssueFile({
              projectPath: leavingProject,
              fileName: c.fileName,
              content: reopened,
            });
          })
          .catch(() => {
            // A transient read/write error leaves the issue `wip`; the user can
            // reopen it from the Map. The switch itself must never fail on this.
          });
      }
    },
    [],
  );

  // Reset ALL per-Project run/scan/merge state (issue 26). Switching the active
  // Project used to change only `activeProjectKey`, leaving the previous Project's
  // Runs (and their Panes), on-disk scan, observed worktree statuses, and merge
  // message in place — which bled indicators across Projects and offered a bogus
  // Merge against branches that don't exist in the new Project. Called on every
  // real switch (see `isProjectSwitch`), BEFORE the Map reloads, so the new
  // Project starts from a blank slate and shows no indicator until its own fresh
  // scan lands. `backlog`/`projectPath` are cleared too so the Coordinator never
  // plans the new Project against the old one's backlog in the transition.
  const resetForProjectSwitch = useCallback((): void => {
    // Before killing the tracked Runs (below), release any live claim their
    // Workers hold in the project we're LEAVING, so a mid-flight `wip` isn't
    // stranded when its Pane/session dies (issue 112). Reads live refs so this
    // callback can keep its []-dep identity.
    const leaving = projectPathRef.current;
    if (leaving !== null) {
      const orphaned = orphanedClaims(drainClaimsRef.current);
      if (orphaned.length > 0) releaseOrphanedClaims(leaving, orphaned);
    }
    setRuns([]);
    setFocusedId(null);
    setMaximizedId(null);
    // The drain-coordinator seam owns this reset; called via a ref for the
    // same ordering reason as `mergeLaneResetRef` below.
    drainResetRef.current?.();
    talkPumpRef.current?.reset();
    // The ambient activity log is per-Project: drop it on a switch so the new
    // Project never inherits the previous one's notes.
    activityFed.current.clear();
    setActivityNotes([]);
    lifecycleReacted.current.clear();
    statusRefreshSig.current = null;
    statusDebounce.current = initialStatusDebounceState();
    seenReconciled.current = null;
    debouncedStatusModelRef.current = null;
    // The merge/auto-merge-lane seam owns this reset; called via a ref because
    // the hook that defines it is invoked further down (see `mergeLaneResetRef`).
    mergeLaneResetRef.current?.();
    setAfkScan(null);
    setWorktreeCommitErrors({});
    soloCommitPhases.current = {};
    for (const timer of Object.values(soloGraceTimers.current)) clearTimeout(timer);
    soloGraceTimers.current = {};
    soloGraceElapsed.current.clear();
    committedWorktreeIds.current.clear();
    // Protected-branch guard bookkeeping (issue 113) is per-Project.
    protectedGatedSoloIds.current.clear();
    protectedLandTargets.current = {};
    setSoloProtectedGates([]);
    // The Run-log feed is per-Project (issue 34): clear it and the Receipt
    // audit bookkeeping so the new Project starts blank and loads its own log.
    setRunLog([]);
    receiptAudited.current.clear();
    mismatchSurfaced.current.clear();
    // An Inbox focus request is about the project it named — a switch to a
    // different Project must not surface (or select) the old one's reference.
    // (The attention snapshot itself is app-wide and deliberately stays.)
    setInboxFocus(null);
    // Same for the New-project landing nudge (issue 82).
    setOnboardNudge(null);
    // The Planning view is about ONE project (issue 83): drop it — and its
    // pump/typing state — so the next project never inherits a planning Pane
    // or a queued stage invocation. If this Window was ON the Planning view,
    // land on the Map (the view would otherwise render nothing).
    setPlanning(null);
    planningPumpRef.current?.reset();
    planningTyping.current = INITIAL_TYPING_STATE;
    applyShellEvent({ kind: 'planning-closed' });
    setBacklog(null);
    setProjectPath(null);
  }, [releaseOrphanedClaims]);

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
        resetForProjectSwitch();
      }
      setActiveProjectKey(res.activeProjectKey);
      // An explicit open lands on the Map — in particular off the Launcher
      // (issue 81); a no-op elsewhere (opens already happen from the Map).
      applyShellEvent({ kind: 'project-opened' });
    }
  }, [resetForProjectSwitch]);

  const switchProject = useCallback(async (key: string): Promise<void> => {
    const res = await window.mc.switchProject({ key });
    setProjects(res.projects);
    setProjectError(res.error);
    if (res.ok) {
      // Clear the previous Project's Runs/scan/merge state before the Map loads
      // the new one, so nothing bleeds across the switch (issue 26).
      if (isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey)) {
        resetForProjectSwitch();
      }
      setActiveProjectKey(res.activeProjectKey);
    }
  }, [resetForProjectSwitch]);

  // NOTE: `openAttentionItem` / `openAttentionProject` (the surface's
  // click-through) live below `attemptProjectChange` — they route through it so
  // acting on attention honors the live-runner interrupt guard (issue 125).

  // A `new-repo-candidate` item's one-click confirm (issue 95, ADR-0017):
  // register the appeared repo through the ADR-0015 path (CONFIG repos entry +
  // registry line + one boring workbench commit). Unlike the other kinds this
  // does NOT open the project — it acts in place; success clears the item on
  // the next re-derive (the CONFIG edit is a watched change), and a refusal
  // surfaces as the Inbox's quiet notice.
  const registerRepoFromInbox = useCallback(async (item: AttentionItem): Promise<void> => {
    if (item.kind !== 'new-repo-candidate' || !item.candidate) return;
    const res = await window.mc.registerRepo({
      project: item.project,
      repoPath: item.candidate.path,
      key: item.candidate.suggestedKey,
    });
    if (!res.ok) {
      setInboxNotice(res.errors[0] ?? `Could not register ${item.candidate.name}.`);
      return;
    }
    setInboxNotice(
      `Registered "${item.candidate.name}"${res.key ? ` as ${res.key}` : ''} in ${item.project}.`,
    );
  }, []);

  // The active Project's resolved view (issue 71/72): its layout kind, its
  // repos map, and where its issues/completions live. Null while no Project.
  const activeProject = useMemo(
    () => projects.find((p) => p.key === projectPath) ?? null,
    [projects, projectPath],
  );

  // The repo a Run WITHOUT a `repo:` key executes in (issue 71): a workbench
  // Project's default repo; for a legacy Project this IS the key, so nothing
  // changes. Null exactly while `projectPath` is null.
  const activeDefaultRepo = useMemo(
    () => activeProject?.defaultRepoPath ?? projectPath,
    [activeProject, projectPath],
  );

  // True when the active Project's workspace root isn't a git repo yet (issue
  // 158, ADR-0017) — the Map badge and the Drain cap>1 gate both key off this.
  const notUnderGit = activeProject?.notUnderGit ?? false;

  // Per-issue repo targeting (issue 72, ADR-0015): each backlog issue resolves
  // through the pure `repoForIssue` — its declared `repo:` key in the
  // project's repos map, else the default repo; an unknown key is an explicit
  // error (that Run is blocked, siblings unaffected). Legacy Projects have no
  // keys, so every issue resolves to the repo itself — unchanged.
  const issueRepoResolutions = useMemo(() => {
    // (`Map` the identifier is the Map view component here.)
    const map = new globalThis.Map<number, IssueRepoResolution>();
    if (!backlog) return map;
    const project = {
      repos: activeProject?.repos ?? {},
      defaultRepoPath: activeDefaultRepo ?? projectPath ?? '',
      // Declared-but-absent repos (ADR-0017): a `repo:` naming one resolves to
      // `planned` — grayed on the Map, held (not errored) by a drain.
      plannedRepoKeys: activeProject?.plannedRepoKeys ?? [],
    };
    for (const issue of backlog.issues) {
      // `repo:` keys are a WORKBENCH concept (ADR-0015). A legacy Project has
      // no repos map, so a stray `repo:` line in a legacy issue stays ignored
      // — byte-identical to today — rather than becoming a blocker.
      map.set(
        issue.id,
        activeProject?.kind === 'workbench'
          ? repoForIssue(project, issue.repoKey)
          : { ok: true, repoPath: project.defaultRepoPath },
      );
    }
    return map;
  }, [backlog, activeProject, activeDefaultRepo, projectPath]);

  /** The repo an issue's Run targets; the default repo when unresolvable. */
  const repoForIssueId = useCallback(
    (issueId: number): string => {
      const resolution = issueRepoResolutions.get(issueId);
      return resolution?.ok ? resolution.repoPath : (activeDefaultRepo ?? '');
    },
    [issueRepoResolutions, activeDefaultRepo],
  );

  // Issues whose `repo:` targets a PLANNED (declared-but-absent) repo (issue
  // 96, ADR-0017): the Map grays these rows — they can't run until their repo
  // is created. Derived purely from the resolutions, so a repo appearing (its
  // key dropping out of `plannedRepoKeys`) ungrays its issues automatically.
  const plannedIssueIds = useMemo(() => {
    const ids: number[] = [];
    for (const [id, resolution] of issueRepoResolutions) {
      if (!resolution.ok && resolution.reason === 'planned') ids.push(id);
    }
    return ids;
  }, [issueRepoResolutions]);

  // The declared-but-absent repos themselves (issue 96) — shown grayed on the
  // Map so the intended codebase shape is visible before any code exists. A
  // repo transitions to real (leaves this list) once its directory appears and
  // is registered (issue 95), which drops its key from `plannedRepoKeys`.
  const plannedRepos = useMemo(
    () =>
      (activeProject?.plannedRepoKeys ?? []).map((key) => ({
        key,
        path: activeProject?.repos[key] ?? '',
      })),
    [activeProject],
  );

  // The current Project as the Map's ＋ Start something verbs see it (issue 116,
  // ADR-0019): a workbench LauncherProject built from the active ProjectView
  // plus the live backlog counts, so "Grill a feature" (startPlanning) and
  // "Simple issue" (createQuickFix / runQuickFixNow) reuse their existing
  // handlers unchanged. Null for a legacy Project — no workbench machinery, so
  // the Map offers no verbs and keeps its passive empty state.
  const mapStartProject = useMemo<LauncherProject | null>(() => {
    if (!activeProject || activeProject.kind !== 'workbench') return null;
    const counts = { open: 0, wip: 0, done: 0 };
    for (const issue of backlog?.issues ?? []) counts[issue.status] += 1;
    return {
      dirName: activeProject.key.split('/').filter(Boolean).pop() ?? activeProject.key,
      label: activeProject.label,
      workbenchDir: activeProject.key,
      defaultRepoPath: activeProject.defaultRepoPath,
      issuesRoot: activeProject.issuesRoot,
      completionsRoot: activeProject.completionsRoot,
      counts,
      lastActivity: null,
      notUnderGit: activeProject.notUnderGit,
    };
  }, [activeProject, backlog]);

  /**
   * The workbench paths a Run target must carry in its spawn prompt (issue
   * 72) — present exactly for a workbench Project, null for legacy.
   */
  const workbenchPathsForRun = useMemo(
    () =>
      activeProject?.kind === 'workbench'
        ? {
            issuesRoot: activeProject.issuesRoot,
            completionsRoot: activeProject.completionsRoot,
          }
        : null,
    [activeProject],
  );

  /** True when a Run works in a worktree on an `afk/` branch (not `main`). */
  const isIsolated = useCallback(
    (run: TrackedRun): boolean => {
      // A Run is isolated when its cwd is not ITS OWN target repo (issue 72):
      // for a legacy Project every issue's repo is the default repo, so this
      // is exactly the old `cwd !== defaultRepoPath` test.
      const repo = repoForIssueId(run.target.issueId);
      return repo !== '' && run.target.projectPath !== repo;
    },
    [repoForIssueId],
  );

  /** The issue's current status on disk, or null if not observed yet. */
  const issueStatusOf = useCallback(
    (issueId: number): IssueStatus | null =>
      backlog?.issues.find((i) => i.id === issueId)?.status ?? null,
    [backlog],
  );

  // The on-disk `afk/` scan, scoped to the ACTIVE Project (issue 26). Every
  // worktree/merge indicator — AND every isolated Run's completion (issue 30) —
  // derives from `activeScan.branches`, never the raw `afkScan`, so a scan taken
  // for the previous Project contributes nothing the instant a new Project is
  // active. `midMerge` is likewise derived here, so it can't outlive a switch.
  const activeScan = useMemo(() => scanForProject(afkScan, projectPath), [afkScan, projectPath]);
  const midMerge = activeScan.midMerge;

  // Each isolated Run's COMMITTED issue status, keyed by issue id, read from the
  // single on-disk scan (issue 30). This replaces the old separate per-Run status
  // poll: a Run is "finished" once its work is committed on its `afk/` branch
  // (issue 15), which the scan already reads — so the Pane tile and the Map share
  // ONE source and can't disagree tick-to-tick (no running↔finished flicker). Its
  // identity only changes when the scan's facts actually change (the scan setState
  // is value-guarded below), so `runStatusOf` and the drain re-plan stay stable
  // across the ~1.5s no-change ticks.
  const committedStatusById = useMemo(() => {
    const map: Record<number, IssueStatus | null> = {};
    for (const b of activeScan.branches) map[b.issueId] = b.committedStatus;
    return map;
  }, [activeScan]);

  const runStatusOf = useCallback(
    (run: TrackedRun): RunStatus =>
      deriveRunStatus({
        sessionAlive: run.sessionAlive,
        stoppedByUser: run.stoppedByUser,
        issueStatus: observedIssueStatus({
          // A workbench Project's claim surface IS the workbench (issue 72,
          // ADR-0015): Workers flip statuses there directly — worktree or not
          // — and the backlog watch reads it, so the "main" source is
          // authoritative for every workbench Run. Legacy isolated Runs keep
          // reading their own worktree/branch, exactly as before.
          isolated: activeProject?.kind === 'workbench' ? false : isIsolated(run),
          mainStatus: issueStatusOf(run.target.issueId),
          worktreeStatus: committedStatusById[run.target.issueId] ?? null,
        }),
        // The latest Receipt's DECLARED outcome (issue 65): a real claude Pane
        // never exits, so a parked (`needs-verification`) or declared-blocked
        // Run must end on this fact alone — the session staying alive can no
        // longer read as `running` forever and wedge the drain's slot.
        receiptOutcome: latestReceiptOutcomeFor(runLog, run.target.issueId),
      }),
    [issueStatusOf, isIsolated, committedStatusById, runLog, activeProject],
  );

  // Keep the orphan-claim snapshot current (issue 112): each tracked Run reduced
  // to whether it is a live claim (`running` on a still-`wip` issue). The
  // project-switch teardown reads this ref to reopen the claims it kills, so it
  // must reflect the CURRENT Runs / their derived status at the moment of a
  // switch — updated whenever the Runs, their status inputs, or the backlog move.
  useEffect(() => {
    drainClaimsRef.current = runs.map((r) => ({
      issueId: r.target.issueId,
      fileName: r.target.issueFileName,
      runStatus: runStatusOf(r),
      issueStatus: issueStatusOf(r.target.issueId),
    }));
  }, [runs, runStatusOf, issueStatusOf]);

  // Commit a solo Run's finished work on `main` via the adapter, moving its
  // phase (issues 25 + 59). A rejected commit reverts the phase so a later
  // observation retries; the adapter commit itself is idempotent on a clean tree.
  // `confirmProtected` (issue 113) carries the human's click-through for landing
  // on a protected branch — the normal observation path passes false and, if the
  // target is `main`/`master`, the commit is WITHHELD (nothing lands) and gated
  // for confirmation; the approval path re-invokes with true.
  const commitSoloRun = useCallback(
    (run: TrackedRun, nextPhase: SoloCommitPhase, confirmProtected = false): void => {
      if (projectPath === null) return;
      const id = run.target.issueId;
      const prior = soloCommitPhases.current[id] ?? 'unstarted';
      soloCommitPhases.current[id] = nextPhase;
      void window.mc
        .commitFinishedMain({
          projectPath,
          slug: slugOf(run.target.issueFileName),
          // The Run's own target repo (issue 72) — the default for legacy.
          repoPath: repoForIssueId(run.target.issueId),
          confirmProtectedLand: confirmProtected,
        })
        .then((outcome) => {
          // Protected-branch withhold (issue 113): nothing landed on `main`.
          // Revert the phase, STOP re-firing this id (so the effect doesn't loop)
          // and queue the gate — an effect below records the blocking proposal
          // and the "big warning" once the surfacing helpers exist.
          if (outcome.protectedBranch && !confirmProtected) {
            soloCommitPhases.current[id] = prior;
            protectedGatedSoloIds.current.add(id);
            const branch = outcome.protectedBranch;
            setSoloProtectedGates((prev) =>
              prev.some((g) => g.issueId === id)
                ? prev
                : [...prev, { issueId: id, branch, nextPhase }],
            );
            return;
          }
          // Stray Receipts adopted alongside the run commit (issue 62) — queue
          // them for a passive `receipt-adopt` note (the log effect below).
          if (outcome.adopted !== undefined && outcome.adopted.length > 0) {
            const adopted = outcome.adopted;
            setSoloAdoptions((prev) => [...prev, adopted]);
          }
        })
        .catch(() => {
          // Transient/failed commit: allow a later observation to retry.
          soloCommitPhases.current[id] = prior;
        });
    },
    [projectPath, repoForIssueId],
  );

  // Auto-commit a finished SOLO Run's work on `main` (issue 25), Receipt-aware
  // (issue 59). A solo Run's agent flips its issue to `done`, emits its block,
  // and writes its Receipt (`issues/completions/NN-slug.md`) LAST — so a commit
  // fired on the `done`-flip observation raced the Receipt, which then sat
  // untracked on `main` and failed every later Merge's clean-tree preflight.
  // "Finished" for this commit therefore means *done flip AND Receipt present*:
  // the pure `decideSoloCommitStep` waits for the Receipt within the same grace
  // window as the finished-without-receipt audit (no stall — after the window
  // the work commits without it and the audit's note is the signal), and a late
  // straggler Receipt is committed by a follow-up observation. Isolated Runs
  // commit on their own `afk/` branch (the worktree-commit effect below), so
  // they are skipped here. Re-runs on every Receipt ingest (`runLog`), so a
  // Receipt landing mid-wait commits at once instead of at the window's end.
  useEffect(() => {
    if (projectPath === null) return;
    for (const run of runs) {
      if (isIsolated(run)) continue;
      const id = run.target.issueId;
      // Withheld pending the protected-branch confirmation (issue 113): don't
      // re-attempt the commit — it would just withhold again and loop. The
      // approval path clears this id and re-commits with confirmation.
      if (protectedGatedSoloIds.current.has(id)) continue;
      const step = decideSoloCommitStep({
        runStatus: runStatusOf(run),
        isolated: false,
        phase: soloCommitPhases.current[id] ?? 'unstarted',
        receiptPresent: hasReceiptFor(runLog, id),
        graceElapsed: soloGraceElapsed.current.has(id),
      });
      if (step.act === 'commit') {
        // A pending grace timer is superseded by this commit (e.g. the Receipt
        // landed mid-wait) — cancel it so it can't fire a second decision.
        const pending = soloGraceTimers.current[id];
        if (pending !== undefined) {
          clearTimeout(pending);
          delete soloGraceTimers.current[id];
        }
        commitSoloRun(run, step.nextPhase);
      } else if (step.act === 'schedule-grace') {
        soloCommitPhases.current[id] = 'waiting';
        const timer = setTimeout(() => {
          delete soloGraceTimers.current[id];
          soloGraceElapsed.current.add(id);
          // The window passed: judge the CURRENT facts — a Receipt that landed
          // meanwhile is included either way (`git add -A`), and a Project
          // switch means this Run's commit is no longer ours to make.
          if (projectPathRef.current !== projectPath) return;
          const followUp = decideSoloCommitStep({
            // It was `finished` when the wait began; a `done` flip does not
            // regress (and the adapter re-checks the status before committing).
            runStatus: 'finished',
            isolated: false,
            phase: soloCommitPhases.current[id] ?? 'unstarted',
            receiptPresent: hasReceiptFor(runLogRef.current, id),
            graceElapsed: true,
          });
          if (followUp.act === 'commit') commitSoloRun(run, followUp.nextPhase);
        }, RECEIPT_AUDIT_GRACE_MS);
        soloGraceTimers.current[id] = timer;
      }
    }
  }, [runs, runLog, projectPath, isIsolated, runStatusOf, commitSoloRun]);

  // Auto-commit a finished ISOLATED Run's worktree onto its `afk/` branch (issue
  // 15), now EVENT-driven off the on-disk scan (issue 30). The old status-read
  // poll performed this git write on EVERY ~1.5s tick — a "read" that mutated —
  // and, racing the separate scan poll, made rows flicker running↔finished. Here
  // MC commits ONCE, exactly when the scan first reports the finished transition
  // (`needsWorktreeCommit`: worktree `done`, branch tip not `done`), keyed by
  // issue id so a re-scan never re-fires it. On success the scan is optimistically
  // advanced to committed-`done` (mirrors the merge optimistic drop, issue 29) so
  // the branch doesn't read `commit-failed` for the ~1.5s until the next scan; a
  // genuine failure is recorded and surfaced (a "commit failed" state) and NOT
  // auto-retried every tick — the user discards it (issue 22).
  useEffect(() => {
    if (projectPath === null) return;
    for (const b of activeScan.branches) {
      if (!needsWorktreeCommit(b)) continue;
      const id = b.issueId;
      if (committedWorktreeIds.current.has(id)) continue;
      committedWorktreeIds.current.add(id);
      const slug = b.slug;
      void window.mc
        // The branch's own repo (issue 72): the scan tags each fact with the
        // member repo it lives in; absent (older shape) = the default repo.
        .commitFinishedWorktree({ projectPath, slug, repoPath: b.repoPath })
        .then((res) => {
          if (res.committed) {
            // Reflect the committed `done` at once so there is no commit-failed
            // flash before the next scan confirms it (a safe optimistic prefix).
            setAfkScan((prev) =>
              prev && prev.projectPath === projectPath
                ? { ...prev, branches: markBranchCommitted(prev.branches, slug) }
                : prev,
            );
          } else if (res.error) {
            // The commit was attempted and genuinely failed: surface it (distinct
            // "commit failed" state) and leave the id marked so it isn't retried
            // every tick — the user resolves/discards it.
            setWorktreeCommitErrors((prev) =>
              prev[id] === res.error ? prev : { ...prev, [id]: res.error },
            );
          }
          // committed=false, error=null ⇒ nothing to commit (already clean); the
          // id stays marked so we don't re-probe every tick.
        })
        .catch(() => {
          // Transient IPC/git error: allow a later scan tick to retry this Run.
          committedWorktreeIds.current.delete(id);
        });
    }
  }, [activeScan, projectPath]);

  // Poll the Project's on-disk `afk/` state on an interval, independent of the
  // tracked Runs (issue 16). This is what lets the Map still show a finished-
  // unmerged Run — and still offer its Merge — after its Pane has been closed
  // and its in-memory Run dropped. Runs whenever a Project is open; clears when
  // none is. A transient git error just skips that tick.
  useEffect(() => {
    if (projectPath === null) return;
    let cancelled = false;
    const scan = (): void => {
      void window.mc
        .scanAfkRuns({ projectPath })
        .then((res) => {
          if (cancelled) return;
          // Tag the scan with the Project it was taken for so it is only ever
          // surfaced while that Project is active (issue 26). Keep the SAME state
          // object when the facts are unchanged (issue 30): most ~1.5s ticks
          // observe no change, and a fresh object each tick would give every
          // derived Run status / Map indicator / drain plan a new identity and
          // re-run `applyIsolation` needlessly. The value-guard keeps the scan
          // stable across no-change ticks, cutting the churn and the flicker.
          setAfkScan((prev) =>
            prev &&
            prev.projectPath === projectPath &&
            prev.midMerge === res.midMerge &&
            afkScanUnchanged(prev.branches, res.branches) &&
            // Merge previews (issue 104) are part of the no-change check: a
            // verdict flipping recalculating→clean on an otherwise-unchanged
            // tick must still refresh the badge, so it can't be kept as `prev`.
            branchPreviewsEqual(prev.previews ?? [], res.previews) &&
            (prev.previewNote ?? null) === res.previewNote &&
            (prev.staleBuildNote ?? null) === res.staleBuildNote
              ? prev
              : {
                  projectPath,
                  branches: res.branches,
                  midMerge: res.midMerge,
                  previews: res.previews,
                  previewNote: res.previewNote,
                  staleBuildNote: res.staleBuildNote,
                },
          );
        })
        .catch(() => {
          // Transient read/git error: keep the last scan; the next tick retries.
          // If a switch happened first, the kept scan is tagged with the OLD
          // Project, so `scanForProject` hides it rather than showing the
          // previous Project's branches (issue 26).
        });
    };
    scan();
    const timer = setInterval(scan, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath]);

  // The Project checkout's current branch (issue 167), polled on the same
  // cadence as the afk scan so the Map badge and the pre-start gate below stay
  // live even when the human switches branches outside Mission Control.
  useEffect(() => {
    if (projectPath === null) {
      setBranchStatus(null);
      return;
    }
    let cancelled = false;
    const poll = (): void => {
      void window.mc
        .getGitBranchStatus({ projectPath })
        .then((res) => {
          if (cancelled) return;
          setBranchStatus((prev) =>
            prev &&
            prev.branch === res.branch &&
            prev.detached === res.detached &&
            prev.protectedBranch === res.protectedBranch
              ? prev
              : res,
          );
        })
        .catch(() => {
          // Transient read error: keep the last known status; the next tick retries.
        });
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath]);

  // The issue ids whose Run session is currently LIVE (still `running`) in this
  // Window. This is the fact the on-disk scan can't supply on its own and the
  // reason a blocked/stopped Run used to read `running` forever (issue 22): a
  // worktree with no `done` commit is only `running` while a live session drives
  // it — otherwise it is `stranded`. Fed to the pure scan derivations below.
  const liveRunIssueIds = useMemo(
    () => runningIssueIds(runs, runStatusOf, (r) => r.target.issueId),
    [runs, runStatusOf],
  );

  // Attempt to change this Window's Project (issue 114). When a runner is live
  // in the current Project, changing here would kill it (resetForProjectSwitch
  // tears the Runs down), so the pure `shouldConfirmInterrupt` gates whether to
  // pause: if it would interrupt a live runner, stash the change and show the
  // "open in a new Window instead?" confirmation; otherwise perform it straight
  // away. The two user-facing switch surfaces — the Project bar switcher and the
  // Launcher's Continue list — both route through here so they behave the same.
  const attemptProjectChange = useCallback(
    (change: { path: string; label: string; proceed: () => void }): void => {
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
    [liveRunIssueIds],
  );

  // The actual open a click-through performs once the guard clears (issue
  // 80/125): open/switch to the project through the NORMAL open/claim flow —
  // ownership rules and all (ADR-0004). If another Window owns it, main rejects
  // with a message we surface as the surface's quiet notice; otherwise land on
  // the Map with the referenced thing focused (the parked/blocked issue
  // selected; a file reference shown as a dismissible line). Acting on an item
  // never claims or writes anything beyond what opening a project always did.
  const openAttentionTarget = useCallback(
    async (
      path: string,
      project: string,
      issueId: number | null,
      fileRef: string | null,
    ): Promise<void> => {
      const res = await window.mc.openProject({ path });
      setProjects(res.projects);
      if (!res.ok) {
        setInboxNotice(res.error ?? `Could not open ${project}.`);
        return;
      }
      setInboxNotice(null);
      if (isProjectSwitch(activeProjectKeyRef.current, res.activeProjectKey)) {
        resetForProjectSwitch();
      }
      setActiveProjectKey(res.activeProjectKey);
      setInboxFocus({ project, issueId, fileRef });
      setInboxFocusSeq((n) => n + 1);
      applyShellEvent({ kind: 'attention-opened' });
    },
    [resetForProjectSwitch],
  );

  // An attention item was clicked (issue 80, re-pointed in issue 125): switch
  // to its project through the SAME guarded flow a Project click uses — so
  // acting on attention is never less safe than clicking a Project (the
  // interrupt guard fires when a live Run would be left behind).
  const openAttentionItem = useCallback(
    (item: AttentionItem): void => {
      const path = workbenchProjectPath(attention.workbenchRoot, item.project);
      if (path === null) {
        setInboxNotice(`Can't resolve a workbench directory for "${item.project}".`);
        return;
      }
      attemptProjectChange({
        path,
        label: item.project,
        proceed: () => void openAttentionTarget(path, item.project, item.issueId, item.fileRef),
      });
    },
    [attention.workbenchRoot, attemptProjectChange, openAttentionTarget],
  );

  // A group header's "open →" (issue 125): open the whole Project with no
  // specific focus — the same guarded switch, landing on the Map.
  const openAttentionProject = useCallback(
    (project: string): void => {
      const path = workbenchProjectPath(attention.workbenchRoot, project);
      if (path === null) {
        setInboxNotice(`Can't resolve a workbench directory for "${project}".`);
        return;
      }
      attemptProjectChange({
        path,
        label: project,
        proceed: () => void openAttentionTarget(path, project, null, null),
      });
    },
    [attention.workbenchRoot, attemptProjectChange, openAttentionTarget],
  );

  // An OS notification was clicked (issue 138). Main focused this Window and
  // sent us where to land; route it through the SAME guarded click-through the
  // Inbox uses (issue 80/125) — so a notification click is never less safe than
  // an Inbox click (the interrupt guard still fires when a live Run would be
  // left behind), and lands on the Project's attention surface with the issue
  // selected. The workbench root rides in the message (authoritative from main).
  useEffect(() => {
    const off = window.mc.onNavigateAttention((msg: NavigateAttentionMessage) => {
      const path = workbenchProjectPath(msg.workbenchRoot, msg.project);
      if (path === null) return;
      attemptProjectChange({
        path,
        label: msg.project,
        proceed: () => void openAttentionTarget(path, msg.project, msg.issueId, null),
      });
    });
    return off;
  }, [attemptProjectChange, openAttentionTarget]);

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
    [openProjectHere, liveRunIssueIds],
  );

  // Pure derivations from the on-disk scan + the live-Run set: which issues show
  // `running` / `stranded` / `commit failed` / `finished (unmerged)` on the Map,
  // and whether the Merge is offered (from disk, so it survives closing Panes).
  // Memoized so their identity only changes when the scan or live set does — this
  // keeps `startRun` (which consults them to refuse a duplicate) from being
  // rebuilt on every unrelated render.
  const worktreeRunStates = useMemo(
    () => deriveWorktreeRunStates(activeScan.branches, liveRunIssueIds),
    [activeScan, liveRunIssueIds],
  );
  const worktreeRunningIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'running').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const finishedUnmergedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'finished-unmerged').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const strandedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'stranded').map((s) => s.issueId),
    [worktreeRunStates],
  );
  const commitFailedIds = useMemo(
    () => worktreeRunStates.filter((s) => s.kind === 'commit-failed').map((s) => s.issueId),
    [worktreeRunStates],
  );

  // The issue ids that drive the Map row "running" indicator (`Map.tsx`) and the
  // detail-panel "Run in progress" label. This MUST be the status-filtered live
  // set (issue 33) — a Run that has reached `finished`/`stopped`/`blocked` but
  // whose Pane is still on screen must not keep its issue reading as "running".
  // `liveRunIssueIds` above is exactly that set (`runStatusOf` === `running`).
  const activeRunIssueIds = liveRunIssueIds;

  // Which tracked Runs are part of the isolation set once a new Run joins: every
  // Run still `running`, plus any already working in a worktree (an isolated
  // Run keeps its worktree until merged, per the Isolation Policy). A finished/
  // stopped SOLO Run on `main` is done competing for the working tree, so it is
  // NOT counted — it must never inflate the concurrency and pull the lone new
  // Run into a needless worktree.
  const needsIsolation = useCallback(
    (r: TrackedRun): boolean =>
      runNeedsIsolation({ live: runStatusOf(r) === 'running', isolated: isIsolated(r) }),
    [runStatusOf, isIsolated],
  );

  // Start (or focus) a single Run — the manual "▶ Run" path from the Map.
  //
  // This routes through the SAME concurrency-keyed isolation reconcile the drain
  // uses (issue 20): starting a second Run while one is active isolates BOTH into
  // worktrees (neither stays on the shared `main` checkout); a lone Run stays
  // solo on `main`. Isolation is a function of concurrency, not of which button
  // started the Run.
  const startRun = useCallback(
    (target: RunTarget): void => {
      const tracked = runs.some((r) => r.target.issueId === target.issueId);

      // main is mid-merge (a partial afk-merge conflict, issue 24): refuse to
      // start a fresh Run on top of a conflicted index — the user resolves or
      // aborts the merge first. A Run already tracked is still surfaced below.
      if (!tracked && midMerge) return;

      // On-disk truth wins over in-memory tracking (issue 21): an issue already
      // live in a worktree, or finished-but-unmerged on its `afk/` branch, must
      // not get a second Run — even after its Pane was closed and its in-memory
      // Run dropped (which is why the in-memory `runs` check alone isn't enough).
      // Re-attaching a worktree to the committed branch clobbers finished work
      // and can push commits onto a branch a pending Merge is about to integrate.
      // The Map already hides the Run affordance for these; this is the backstop
      // for any other caller. (A still-tracked Run just gets surfaced below.)
      if (
        !tracked &&
        hasInFlightRun(target.issueId, {
          worktreeRunningIds,
          finishedUnmergedIds,
          strandedIds,
          commitFailedIds,
        })
      ) {
        return;
      }

      applyShellEvent({ kind: 'run-started' });
      setFocusedId(target.issueId);

      // Already tracked → just surface it, exactly as before (no re-spawn).
      if (tracked) return;

      // A genuinely fresh Run for this id: drop any stale commit-failure left by a
      // previous Run of the same id (the isolated Run's `finished` now derives
      // from the on-disk scan, so a fresh worktree's uncommitted state can't read
      // `finished` — issue 21/30).
      setWorktreeCommitErrors((prev) => {
        if (!(target.issueId in prev)) return prev;
        const next = { ...prev };
        delete next[target.issueId];
        return next;
      });
      // ...and let a fresh Run of this id auto-commit its OWN work — clear both the
      // solo (issues 25/59) and isolated (issue 30) commit bookkeeping so it isn't
      // treated as already-committed (or already grace-elapsed) by a prior Run of
      // the same id.
      delete soloCommitPhases.current[target.issueId];
      const staleTimer = soloGraceTimers.current[target.issueId];
      if (staleTimer !== undefined) {
        clearTimeout(staleTimer);
        delete soloGraceTimers.current[target.issueId];
      }
      soloGraceElapsed.current.delete(target.issueId);
      committedWorktreeIds.current.delete(target.issueId);

      // The workbench-aware target (issue 72): a workbench Project's spawn
      // prompt carries the explicit workbench paths; legacy adds nothing. A
      // caller that already resolved them (the Launcher's quick-fix Run-now,
      // issue 81 — it fires before the Map has loaded the backlog) keeps its
      // own; Map-started Runs carry none and get the active Project's.
      const enriched: RunTarget = {
        ...target,
        workbench: target.workbench ?? workbenchPathsForRun,
      };

      // No resolved Project path yet: can't reconcile isolation, so fall back to
      // spawning on the target's given path (a lone Run). Never blocks the Pane.
      if (projectPath === null) {
        setRuns((prev) =>
          prev.some((r) => r.target.issueId === target.issueId)
            ? prev
            : [...prev, newRun(enriched)],
        );
        return;
      }

      // The issue's TARGET repo (issue 72): its `repo:` key resolved through
      // the project CONFIG, else the default. An unknown key is an explicit
      // error; a declared-but-absent repo is `planned` — held until it exists
      // (ADR-0017, issue 96). Either way the Run is refused with the reason —
      // never a guessed path.
      const resolution = issueRepoResolutions.get(target.issueId);
      if (resolution !== undefined && !resolution.ok) {
        window.alert(
          resolution.reason === 'planned'
            ? plannedRepoHoldNote(target.issueId, resolution.repoKey)
            : unknownRepoKeyNote(
                target.issueId,
                resolution.unknownKey,
                Object.keys(activeProject?.repos ?? {}),
              ),
        );
        return;
      }

      // The Runs that need isolation once this one joins = the ones still live
      // (running or in a worktree) plus the new target, deduped by issueId, each
      // carrying its own target repo so isolation keys per repo (issue 72).
      // Solo-chaining is retired (issue 147, ADR-0021): a dependency's work now
      // reaches main via the auto-merge lane, so every Run isolates purely by
      // concurrency like any other — no `chained` placement exception.
      const active: IsolationRun[] = runs.filter(needsIsolation).map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
        repoPath: repoForIssueId(r.target.issueId),
      }));
      const issueRepo = repoForIssueId(target.issueId);
      const isolationRuns = isolationRunSetWith(active, {
        issueId: target.issueId,
        slug: slugOf(target.issueFileName),
        repoPath: issueRepo,
      });

      // Apply the resolved placements: re-point every tracked Run to its cwd —
      // a Run that was solo on `main` re-parents into its worktree when this
      // second Run turns on parallel mode (its Pane respawns there, keyed on the
      // changed cwd) — and add the new Run in its own resolved cwd.
      const place = (cwdOf: (issueId: number) => string): void => {
        setRuns((prev) => {
          const repointed = prev.map((r) => {
            const cwd = cwdOf(r.target.issueId);
            return cwd === r.target.projectPath
              ? r
              : { ...r, target: { ...r.target, projectPath: cwd } };
          });
          if (repointed.some((r) => r.target.issueId === target.issueId)) {
            return repointed;
          }
          return [...repointed, newRun({ ...enriched, projectPath: cwdOf(target.issueId) })];
        });
      };

      void window.mc
        .applyIsolation({ projectPath, runs: isolationRuns })
        .then((result) => {
          const cwdById: Record<number, string> = {};
          for (const p of result.placements) cwdById[p.issueId] = p.cwd;
          // A Run not in the placement set keeps its current cwd (fall back to
          // its own repo); every isolated/new Run gets its resolved cwd.
          place((id) => cwdById[id] ?? repoForIssueId(id));
        })
        .catch(() => {
          // Isolation failed (a git worktree error, a partial reconcile). Falling
          // back to the repo checkout is safe only when this would be the LONE
          // Run IN ITS REPO (issue 72 keys concurrency per repo); if other Runs
          // are live in the SAME repo, opening this one on its checkout is the
          // concurrent-main collision isolation exists to prevent (issue 28).
          // Surface the error and leave the live Runs untouched — don't spawn.
          const sameRepoCount = isolationRuns.filter(
            (r) => (r.repoPath ?? issueRepo) === issueRepo,
          ).length;
          if (!canFallBackToMain(sameRepoCount)) {
            setFocusedId((cur) => (cur === target.issueId ? null : cur));
            window.alert(
              'Could not isolate this Run into its own worktree, and other Runs ' +
                'are already live — refusing to start it on main (that would run ' +
                'multiple agents on the shared checkout). Resolve the worktree/git ' +
                'error and try again.',
            );
            return;
          }
          // A lone Run in its repo: safe to open the Pane on that checkout.
          setRuns((prev) =>
            prev.some((r) => r.target.issueId === target.issueId)
              ? prev
              : [...prev, newRun({ ...enriched, projectPath: issueRepo })],
          );
        });
    },
    [
      runs,
      projectPath,
      needsIsolation,
      midMerge,
      worktreeRunningIds,
      finishedUnmergedIds,
      strandedIds,
      commitFailedIds,
      issueRepoResolutions,
      repoForIssueId,
      workbenchPathsForRun,
      activeProject,
      backlog,
    ],
  );

  // Branch-aware Run start (issue 167): a genuinely FRESH Run on a protected
  // branch (`main`/`master`) or a detached HEAD gets caught here — the human
  // picks Create/Switch/Proceed before `startRun` ever touches the checkout.
  // An already-tracked Run (surfacing its Pane, no new git effect) always
  // bypasses the gate.
  const guardedStartRun = useCallback(
    (target: RunTarget): void => {
      const tracked = runs.some((r) => r.target.issueId === target.issueId);
      if (tracked) {
        startRun(target);
        return;
      }
      const decision = branchGuardDecision(branchStatus);
      // 'pending' (status still resolving) must never fall through to an
      // unguarded start (issue 176) — the Map disables the Run control for
      // this same window, so a click landing here is a defensive no-op.
      if (decision === 'pending') return;
      if (decision === 'prompt') {
        setBranchPromptMode('choose');
        setBranchPromptError(null);
        setBranchPrompt({ kind: 'run', target });
        return;
      }
      startRun(target);
    },
    [runs, branchStatus, startRun],
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
        resetForProjectSwitch();
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
    [resetForProjectSwitch],
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
  }, [activeProject, startTalk, talkPump]);

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
      if (switched) resetForProjectSwitch();
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
        startRun(target);
      }
    },
    [resetForProjectSwitch, startRun],
  );

  const stopRun = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId
          ? { ...r, stoppedByUser: true, stopSignal: r.stopSignal + 1 }
          : r,
      ),
    );
  }, []);

  // Take over a headless Run in a Pane (issue 144) — the affordance on a live
  // Feed ("grab the wheel mid-flight") and on a finished Run's card ("reopen
  // post-mortem"). It transforms the SAME tracked Run in place: the target flips
  // from headless (Feed) to a `claude --resume <captured-session-id>` Pane in the
  // same cwd. Because the Run keeps its issue id and drain generation, the
  // coordinator still sees an identical ActiveRun — its drain slot and issue
  // guard are unchanged across the switch (a live take-over keeps occupying its
  // slot; a finished one, `done` on disk, still reads `finished` and takes none).
  //
  // Killing the old headless child is automatic: flipping `headless` false
  // unmounts the RunFeed, whose cleanup calls killPty on the headless session
  // (and unsubscribes first, so the child's exit never flips this Run's liveness
  // as it dies). Resetting `sessionAlive`/`stoppedByUser` keeps a live Run reading
  // `running` across the swap until the resumed Pane reports its own exit.
  const takeOverRun = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) => {
        if (r.target.issueId !== issueId) return r;
        const kind = takeoverKindFor(runStatusOf(r), r.target.headless, r.claudeSessionId);
        if (kind === null) return r;
        return {
          ...r,
          target: takeoverTarget(r.target, r.claudeSessionId!),
          sessionAlive: true,
          stoppedByUser: false,
        };
      }),
    );
    setFocusedId(issueId);
  }, [runStatusOf]);

  // Maximize a tile to fill the Pane area (click its header again to restore
  // the grid). All Panes stay mounted either way, so sessions never drop.
  const toggleMaximize = useCallback((issueId: number): void => {
    setMaximizedId((cur) => (cur === issueId ? null : issueId));
    setFocusedId(issueId);
  }, []);

  // Drop a terminated Run from the grid once you've read what happened. Only
  // offered for finished/blocked/stopped Runs (a running Run is stopped first).
  const dismissRun = useCallback((issueId: number): void => {
    setRuns((prev) => prev.filter((r) => r.target.issueId !== issueId));
    setMaximizedId((cur) => (cur === issueId ? null : cur));
    setFocusedId((cur) => (cur === issueId ? null : cur));
    // Drop this Run's commit error + once-committed marker so a later Run of the
    // same id doesn't inherit a stale `commit failed` and can commit afresh
    // (issue 21/22/30).
    setWorktreeCommitErrors((prev) => {
      if (!(issueId in prev)) return prev;
      const next = { ...prev };
      delete next[issueId];
      return next;
    });
    committedWorktreeIds.current.delete(issueId);
  }, []);

  // Discard a STRANDED / commit-failed isolated Run (issue 22): force-remove its
  // worktree and delete its `afk/` branch so it stops blocking the batch. Drops
  // it from tracking and refreshes the on-disk scan so the Map/Merge update at
  // once (rather than waiting for the next poll tick). Human-triggered only.
  const discardRun = useCallback(
    (issueId: number, slug: string): void => {
      if (projectPath === null) return;
      const label = String(issueId).padStart(2, '0');
      // The branch's own repo (issue 72), read from the scan fact when known.
      const repoPath = activeScan.branches.find((b) => b.slug === slug)?.repoPath;
      void window.mc
        .discardAfkRun({ projectPath, slug, repoPath })
        .then((res) => {
          if (!res.ok) {
            window.alert(
              `Could not discard the worktree for issue ${label}: ${res.error ?? 'unknown error'}`,
            );
            return;
          }
          setRuns((prev) => prev.filter((r) => r.target.issueId !== issueId));
          setMaximizedId((cur) => (cur === issueId ? null : cur));
          setFocusedId((cur) => (cur === issueId ? null : cur));
          setWorktreeCommitErrors((prev) => {
            if (!(issueId in prev)) return prev;
            const next = { ...prev };
            delete next[issueId];
            return next;
          });
          committedWorktreeIds.current.delete(issueId);
          // Refresh the scan immediately so the discarded Run's row/Merge clears.
          void window.mc
            .scanAfkRuns({ projectPath })
            .then((r) => setAfkScan({ projectPath, branches: r.branches, midMerge: r.midMerge, previews: r.previews, previewNote: r.previewNote, staleBuildNote: r.staleBuildNote }))
            .catch(() => {
              // The 1.5s poll will pick it up regardless.
            });
        })
        .catch((err: unknown) => {
          window.alert(
            `Could not discard the worktree for issue ${label}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    },
    [projectPath, activeScan],
  );

  const handleRunExit = useCallback(
    (issueId: number, endCause?: 'timeout' | 'crashed'): void => {
      setRuns((prev) =>
        prev.map((r) =>
          r.target.issueId === issueId
            ? { ...r, sessionAlive: false, endCause: endCause ?? null }
            : r,
        ),
      );
    },
    [],
  );

  // A headless Run reported its MC-internal spawn session id (issue 139).
  const handleRunSession = useCallback((issueId: number, sessionId: string): void => {
    setRuns((prev) =>
      prev.map((r) => (r.target.issueId === issueId ? { ...r, sessionId } : r)),
    );
  }, []);

  // A headless Run's claude session id was captured from its stream (issue 139,
  // AC3) — persist it on the Run record for resume/take-over.
  const handleRunClaudeSession = useCallback(
    (issueId: number, claudeSessionId: string): void => {
      setRuns((prev) =>
        prev.map((r) =>
          r.target.issueId === issueId ? { ...r, claudeSessionId } : r,
        ),
      );
    },
    [],
  );

  // Upsert an ingested record into the feed, keyed by its Receipt id, so a
  // superseding ingest (same issue + `finished`, changed body) replaces the
  // earlier version rather than adding a duplicate card. Newest first.
  const upsertRunLog = useCallback((record: RunLogRecord): void => {
    setRunLog((prev) => {
      const others = prev.filter((r) => r.id !== record.id);
      return [record, ...others].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
      );
    });
  }, []);

  // NOTE (issue 57, ADR-0013): there is deliberately NO scroll-capture effect
  // here. Receipts (`issues/completions/`, watched below) are the SOLE capture
  // input; the PTY tail buffer is a human peek/debug surface and never reaches
  // a parser, the status model, or the feed. A Run that ends without a Receipt
  // is surfaced honestly by the finished-without-receipt audit further down.

  // Load the active Project's persisted Run log when it opens/changes (issue 34),
  // so the feed is populated from disk and survives closing Panes, the app, and
  // restarts. Cleared when no Project is open.
  useEffect(() => {
    projectPathRef.current = projectPath;
    if (projectPath === null) {
      setRunLog([]);
      return;
    }
    let cancelled = false;
    void window.mc
      .loadRunLog({ projectPath })
      .then((res) => {
        // Apply the same noise floor on reload (issue 47): a boot-screen/empty
        // `unknown` persisted on disk must not resurface as a Run when the Project
        // reopens.
        if (!cancelled) setRunLog(res.records.filter(isRealCapture));
      })
      .catch(() => {
        // A transient read error just leaves the feed as-is; a later capture or
        // Project reopen reloads it.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Load the active Project's raw drain-journal entries for the Cost tab
  // (issue 181) alongside the Run log above — a one-shot read per Project
  // switch (no live watch; see the `journals` state comment). Inert (stays
  // `[]`) for a legacy Project, same as the main-process reader.
  useEffect(() => {
    if (projectPath === null) {
      setJournals([]);
      return;
    }
    let cancelled = false;
    void window.mc
      .loadJournals({ projectPath })
      .then((res) => {
        if (!cancelled) setJournals(res.files);
      })
      .catch(() => {
        // A transient read error just leaves the Cost tab showing its last load.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // --- Receipt capture edge (issue 56, ADR-0013) ----------------------------
  // Point main's Receipt watch at the active Project: its checkout
  // `issues/completions/` plus each LIVE worktree's copy (a parallel Run's
  // Receipt lands in its own worktree and must surface live, before any Merge).
  // The worktree set comes from the same on-disk scan the Map trusts; the key
  // string keeps the effect from re-sending on every scan tick — it re-points
  // only when the set actually changes (main reconciles roots incrementally, so
  // a re-point never re-feeds: the edge dedupes by issue + `finished`).
  const receiptWorktreeKey = useMemo(
    () =>
      activeScan.branches
        .filter((b) => b.hasWorktree)
        .map((b) => b.slug)
        .sort()
        .join(','),
    [activeScan],
  );
  useEffect(() => {
    if (projectPath === null) return;
    const worktreeSlugs = receiptWorktreeKey === '' ? [] : receiptWorktreeKey.split(',');
    window.mc.watchReceipts({ projectPath, worktreeSlugs });
  }, [projectPath, receiptWorktreeKey]);

  // Ingested Receipts enter the feed EXACTLY where scroll-captured records do
  // (issue 56 acceptance: no parallel bespoke path): one upsert into `runLog`,
  // from which the Run-log card, the Dispatcher block feed, the lifecycle
  // reactions, and the status model all already derive. The edge has parsed,
  // debounced, deduped, and persisted the record; here we apply the same noise
  // floor as every other capture (ADR-0012) and scope it to the active Project
  // (the record is already persisted for ITS project either way).
  useEffect(
    () =>
      window.mc.onReceiptCaptured((msg) => {
        if (projectPathRef.current !== msg.projectPath) return;
        if (!isRealCapture(msg.record)) return;
        upsertRunLog(msg.record);
      }),
    [upsertRunLog],
  );

  // Record a routine fact as a quiet ambient note (issue 48, ADR-0012, narrowed
  // by ADR-0022): kept only because the drain journal folds notable entries
  // (adoptions, finished-without-receipt) into each drain's memory summary —
  // there is no more chat to route into or approval gate to raise. Deduped by
  // id so a re-render / re-scan can't double-note it.
  const logNote = useCallback(
    (id: string, _action: DispatcherAction, label: string): void => {
      setActivityNotes((prev) =>
        prev.some((a) => a.id === id) ? prev : [...prev, { id, label: oneLineNote(label) }],
      );
    },
    [],
  );

  // Drain the SOLO-path stray-Receipt adoptions (issue 62) into a note. The
  // adoptions are queued where the commit resolves (`commitSoloRun`, defined
  // before `logNote` exists) and noted here — one per adoption batch, deduped
  // by its file list — because the drain journal reads it (issue 73).
  useEffect(() => {
    if (soloAdoptions.length === 0) return;
    for (const files of soloAdoptions) {
      logNote(
        `receipt-adopt:solo:${files.join(',')}`,
        'receipt-adopt',
        `Adopted stray Receipt(s) on main: ${files.join(', ')}`,
      );
    }
    setSoloAdoptions([]);
  }, [soloAdoptions, logNote]);

  // Drain the SOLO-path protected-branch withholds (issue 113) into a note.
  // Queued in `commitSoloRun` (which runs before `logNote` exists); here — once
  // it does — each becomes a `protected-branch-land` history note, deduped per
  // issue. `protectedLandTargets` still records what confirming the land would
  // re-execute; there is no more UI to click through it since the Dispatcher
  // panel that owned approve/reject is retired (see the Doc drift note in this
  // issue's completion — landing on a protected branch has no renderer
  // affordance left to confirm it).
  useEffect(() => {
    if (soloProtectedGates.length === 0) return;
    for (const gate of soloProtectedGates) {
      const pid = `protected-branch-land:solo:${gate.issueId}`;
      protectedLandTargets.current[pid] = {
        kind: 'solo',
        issueId: gate.issueId,
        nextPhase: gate.nextPhase,
      };
      logNote(pid, 'protected-branch-land', protectedLandWarning(gate.branch));
    }
    setSoloProtectedGates([]);
  }, [soloProtectedGates, logNote]);

  useEffect(() => {
    for (const rec of runLog) {
      // An `unknown` capture has no reliable qualitative content to synthesize,
      // so it does NOT enter the block feed here. Under the ADR-0012 noise floor
      // (issue 47) the empty/boot-screen unknowns never reach `runLog` at all —
      // `isRealCapture` drops them at capture/load. A `runLog` unknown is therefore
      // a REAL unknown with substance; it is still conveyed (with its `detail`) by
      // the ground-truth status refresh below as a "needs a look" item (issue 43,
      // narrowed by issue 47), so nothing substantive a Run emitted is lost. A
      // still-streaming capture stays unknown only until it resolves, at which
      // point it feeds here normally (the guard below is keyed by id and unknowns
      // are never marked fed).
      if (rec.outcome === 'unknown') continue;
      if (activityFed.current.has(rec.id)) continue;
      activityFed.current.add(rec.id);
      const text = renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec }));
      if (rec.outcome === 'completed') {
        logNote(`run-completed:${rec.id}`, 'synthesize', text);
      } else {
        logNote(`synthesize:${rec.id}`, 'synthesize', text);
      }
      // Per-Run doc-drift (issue 38; retired to per-Run scope by ADR-0022 / issue
      // 162): a block that reports doc-drift (a PRD/reality contradiction)
      // surfaces as a plain-language note. Doc-drift free / "none" blocks add
      // nothing. The cross-Run consolidation this used to feed (pattern
      // detection across Runs) is retired — a completion block's own Doc drift
      // line is the whole story now.
      if (isRealDocDrift(rec)) {
        const label =
          rec.issueId !== null ? `issue ${String(rec.issueId).padStart(2, '0')}` : rec.issue ?? `run ${rec.id}`;
        logNote(
          `doc-drift:${rec.id}`,
          'amend-plan',
          `Doc-drift flagged by ${label}: ${rec.docDrift!.trim()} — the plan may need amending to reconcile it.`,
        );
      }
    }
  }, [runLog, logNote]);

  // --- Ground the status picture in truth (issue 43) ------------------------
  // The AUTHORITATIVE model of which issues are open/wip/done/
  // finished-unmerged is reconciled from the SAME live sources the Map uses — the
  // backlog (main-checkout truth), the on-disk `afk/` scan (incl. finished-
  // unmerged, which the backlog can't see because that `done` flip lives on the
  // `afk/` branch), and the Run log (for its unknown captures). It is NOT inferred
  // from the fed Completion-block stream, which could miss/misparse/drop a block
  // and drift the picture (the issue-35 bug: 03/04 reported "still to run" when
  // done). The blocks above remain the QUALITATIVE synthesis; status comes from
  // here. Recomputed as the backlog / scan / Run log change.
  const drainStatusModel = useMemo(
    () => reconcileStatusModel({ backlog, worktreeStates: worktreeRunStates, runLog }),
    [backlog, worktreeRunStates, runLog],
  );

  // Debounce backward status moves before surfacing (issue 49, ADR-0012). Each
  // recompute of `drainStatusModel` above is one reconcile CHECKPOINT: a
  // BACKWARD move (finished/finished-unmerged → open, done → not-done) is held at
  // its prior status until it persists across a further checkpoint, killing the
  // transient mid-reconcile blip; FORWARD moves surface immediately. The advance
  // is guarded so it runs once per distinct reconciled model even though
  // StrictMode double-invokes the memo (advancing twice would falsely "confirm" a
  // one-snapshot regression).
  const debouncedStatusModel = useMemo(() => {
    if (seenReconciled.current === drainStatusModel && debouncedStatusModelRef.current) {
      return debouncedStatusModelRef.current;
    }
    const { model, state } = debounceStatusModel(drainStatusModel, statusDebounce.current);
    statusDebounce.current = state;
    seenReconciled.current = drainStatusModel;
    debouncedStatusModelRef.current = model;
    return model;
  }, [drainStatusModel]);

  // Re-ground the status picture whenever it changes (a Run flipping done, a
  // branch becoming finished-unmerged, an unknown capture landing), guarded by the
  // rendered text so an unchanged model is never re-surfaced. The status refresh
  // is a ROUTINE PASSIVE fact (ADR-0012, issue 48): it renders as a quiet line in
  // the ambient log, NOT typed into the chat. It updates ONE `status-refresh` note
  // in place (rather than appending a new line each change) so the log shows the
  // current "what's left" without accreting a status entry per transition.
  useEffect(() => {
    const text = renderStatusModel(debouncedStatusModel);
    if (text === statusRefreshSig.current) return;
    statusRefreshSig.current = text;
    setActivityNotes((prev) => {
      const label = oneLineNote(text);
      const idx = prev.findIndex((a) => a.id === 'status-refresh');
      if (idx === -1) return [...prev, { id: 'status-refresh', label }];
      const next = [...prev];
      next[idx] = { id: 'status-refresh', label };
      return next;
    });
  }, [debouncedStatusModel]);

  // --- React to lifecycle events mid-drain (issue 37, ADR-0007) -------------
  // Beyond the Completion-block stream above, lightweight terminal lifecycle
  // events — blocked / stranded / needs-attention / hitl-waiting — still get a
  // history note, so a walkthrough can see mid-drain activity that has no
  // Completion block of its own. These are STRUCTURED signals derived from
  // truth Mission Control already holds — the captured Completion records
  // (blocked / needs-verification, with their `detail` body from issue 42) and
  // the on-disk `afk/` scan's stranded classification (issue 22) — never raw
  // Pane scroll. Reacted-to once per event (guarded by `lifecycleReacted`).
  // ADR-0022: none of these raises an approval gate anymore — the user unsticks
  // a blocked Run and discards a stranded one from the Map's own controls.
  useEffect(() => {
    const isHitlIssue = (issueId: number | null): boolean =>
      issueId !== null && (backlog?.issues.find((i) => i.id === issueId)?.hitl ?? false);

    const events: LifecycleEvent[] = [];

    // Blocked / HITL-waiting / needs-attention, derived from the captured blocks.
    // `finished` is already relayed via the Completion-block feed above, so it is
    // skipped here to avoid a duplicate narration.
    for (const rec of runLog) {
      const kind = lifecycleKindForOutcome(rec.outcome, isHitlIssue(rec.issueId));
      if (kind === null || kind === 'finished') continue;
      events.push({
        kind,
        runId: rec.id,
        issueId: rec.issueId,
        slug: rec.slug,
        title: rec.title,
        detail: rec.detail,
      });
    }

    // Stranded isolated Runs (issue 22): a worktree whose Run ended without a
    // done commit. There is no Completion block for these — the on-disk scan is
    // the only signal — so surfacing them here is what keeps a stranded Run from
    // silently stalling the drain (and blocking its siblings' Merge).
    for (const s of worktreeRunStates) {
      if (s.kind !== 'stranded') continue;
      events.push({
        kind: 'stranded',
        runId: `stranded-${s.issueId}`,
        issueId: s.issueId,
        slug: s.slug,
        title: null,
        detail: null,
      });
    }

    for (const event of events) {
      const key = `${event.kind}:${event.runId}`;
      if (lifecycleReacted.current.has(key)) continue;
      lifecycleReacted.current.add(key);
      const reaction = reactToLifecycleEvent(event);
      if (reaction.notification === null) continue;
      logNote(key, actionForLifecycle(event.kind), reaction.notification);
    }
  }, [runLog, worktreeRunStates, backlog, logNote]);

  // --- The honest signals that replaced the scroll scrape (issue 57) --------
  // (a) finished-without-receipt: ground truth (the issue's `done` flip / a
  // session ending unfinished) says a Run ended, but no Receipt exists for it.
  // Exactly ONE honest line per Run ("peek at the Pane") — never a scrape of
  // the tail buffer, never a guess (ADR-0013). Under ADR-0014 (issue 66) this
  // is a drain fact worth telling: it lands in the Dispatcher CONVERSATION as
  // a message (plus the history line) — a fact, not a gate. The audit waits a
  // grace window and re-checks the LIVE Run log first, so a Receipt that lands
  // a beat after the flip surfaces as a normal card and no note fires.
  useEffect(() => {
    if (projectPath === null) return;
    const audited = auditMissingReceipts(
      runs.map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
        title: r.target.issueTitle,
        status: runStatusOf(r),
        endCause: r.endCause ?? null,
      })),
      runLog,
    );
    for (const event of audited) {
      const issueId = event.issueId;
      if (issueId === null || receiptAudited.current.has(issueId)) continue;
      receiptAudited.current.add(issueId);
      const auditPath = projectPath;
      setTimeout(() => {
        // The grace window passed: judge the CURRENT log (and Project). A
        // Receipt that arrived meanwhile means honesty requires silence; the
        // id stays clearable so a later re-run gets its own audit.
        if (projectPathRef.current !== auditPath) return;
        if (hasReceiptFor(runLogRef.current, issueId)) {
          receiptAudited.current.delete(issueId);
          return;
        }
        const reaction = reactToLifecycleEvent(event);
        if (reaction.notification !== null) {
          logNote(`${event.kind}:${event.runId}`, actionForLifecycle(event.kind), reaction.notification);
        }
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runs, runLog, projectPath, runStatusOf, logNote]);

  // (b) Receipt/state mismatch (ADR-0013 trust hierarchy): the latest Receipt's
  // declared narrative disagrees with git's ground truth (e.g. Receipt says
  // completed, the issue file says wip). State wins — the status model above
  // never reads outcomes — and the disagreement surfaces as ONE debounced
  // passive note per issue: checked against the already-debounced status model,
  // held for the grace window, and re-verified against the live facts before it
  // is noted, so a `done` flip that lands a beat after its Receipt stays silent.
  useEffect(() => {
    if (projectPath === null) return;
    for (const mismatch of detectReceiptStateMismatches(runLog, debouncedStatusModel.issues)) {
      const key = mismatchKey(mismatch);
      if (mismatchSurfaced.current.has(key)) continue;
      mismatchSurfaced.current.add(key);
      const auditPath = projectPath;
      setTimeout(() => {
        if (projectPathRef.current !== auditPath) return;
        const still = detectReceiptStateMismatches(
          runLogRef.current,
          debouncedStatusModelRef.current?.issues ?? [],
        ).find((m) => mismatchKey(m) === key);
        if (!still) {
          // Reality caught up during the window — a transient, not a mismatch.
          mismatchSurfaced.current.delete(key);
          return;
        }
        logNote(key, 'relay', describeReceiptMismatch(still));
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runLog, debouncedStatusModel, projectPath, logNote]);

  // Keep the App's backlog copy fresh from every Map load/live-change so the
  // Coordinator plans against current disk truth.
  const handleBacklogLoaded = useCallback(
    (loaded: Backlog | null, loadedPath: string): void => {
      setBacklog(loaded);
      setProjectPath(loadedPath);
    },
    [],
  );

  // --- Drain-coordinator seam (issue 186) -----------------------------------
  // Extracted to `./app/useDrain`: the re-plan effect against the Run
  // Coordinator (`planDrain`), the per-drain generation, the journal-baseline
  // bookkeeping, and the spawn/telemetry glue (worker tier/effort/timeout
  // resolution for each startable issue).
  const drain = useDrain({
    backlog,
    projectPath,
    activeProject,
    runs,
    setRuns,
    setFocusedId,
    runLog,
    runLogRef,
    activityNotesRef,
    projectPathRef,
    runStatusOf,
    isIsolated,
    needsIsolation,
    midMerge,
    finishedUnmergedIds,
    issueRepoResolutions,
    repoForIssueId,
    workbenchPathsForRun,
    logNote,
    applyShellEvent,
    branchStatus,
    notUnderGit,
    setGitInitPrompt,
    setGitInitError,
    setBranchPrompt,
    setBranchPromptMode,
    setBranchPromptError,
  });
  drainResetRef.current = drain.reset;
  drainDismissDebriefRef.current = drain.dismissDebrief;

  // Resume whichever Run/drain the branch prompt is holding, bypassing the
  // guard (it just got resolved) — fired by Create/Switch (after the git op
  // lands) and by Proceed anyway.
  const resumeBranchPrompt = useCallback((): void => {
    if (branchPrompt === null) return;
    const pending = branchPrompt;
    setBranchPrompt(null);
    if (pending.kind === 'run') startRun(pending.target);
    else drain.startDrain(pending.cap);
  }, [branchPrompt, startRun, drain]);

  // --- Merge / auto-merge-lane seam (issue 185) ----------------------------
  // Extracted to `./app/useMergeLane`. `runMergeCore` also needs to drop the
  // merged branches from the on-disk scan and clear the merged ids' run-
  // tracking bookkeeping (`runs`, `worktreeCommitErrors`, the committed-
  // worktree marker) — state this component owns, not the hook. That shared
  // write is the one clean interface point (`handleMergeCompleted` below)
  // rather than handing the hook raw `setRuns`/`setWorktreeCommitErrors`.
  const handleMergeCompleted = useCallback(
    (mergedIds: Set<number>, slugs: string[]): void => {
      // Optimistically drop the merged slugs from the on-disk scan the instant
      // the merge succeeds, so the Merge affordance recomputes to not-ready
      // synchronously — before `merging` resets and re-enables the button.
      // Without this the scan keeps listing the now-deleted branches until the
      // next ~1.5s poll, so a rapid second click would fire a merge at branches
      // that no longer exist and surface an error contradicting the success
      // just shown (issue 29). The next real scan confirms the same truth, so
      // this is a safe optimistic prefix of it.
      setAfkScan((prev) =>
        prev && prev.projectPath === projectPath
          ? { ...prev, branches: dropMergedBranches(prev.branches, slugs) }
          : prev,
      );
      // The merged Runs' worktrees are gone; drop them from tracking so the
      // Merge action clears. Unmerged (blocked/stopped) Runs stay put.
      setRuns((prev) => prev.filter((r) => !mergedIds.has(r.target.issueId)));
      // Clear the merged ids' commit error + once-committed marker so re-using
      // any of those ids for a later Run starts clean (issue 21/30).
      setWorktreeCommitErrors((prev) => {
        if (![...mergedIds].some((id) => id in prev)) return prev;
        const next = { ...prev };
        for (const id of mergedIds) delete next[id];
        return next;
      });
      for (const id of mergedIds) committedWorktreeIds.current.delete(id);
    },
    [projectPath],
  );

  // `protectedLandTargets` is shared with the solo-commit seam (it records
  // both `kind: 'merge'` and `kind: 'solo'` withheld lands), so this component
  // keeps owning the ref; the hook only gets a narrow write into it.
  const recordProtectedLandTarget = useCallback(
    (pid: string, target: ProtectedMergeLandTarget): void => {
      protectedLandTargets.current[pid] = target;
    },
    [],
  );

  // The on-disk scan is owned by the drain/scan seam, not the merge hook —
  // `runAbortMerge` re-scans immediately (so `midMerge` clears without
  // waiting for the next poll) through this narrow refresh interface.
  const refreshScan = useCallback((path: string): void => {
    void window.mc
      .scanAfkRuns({ projectPath: path })
      .then((r) =>
        setAfkScan({
          projectPath: path,
          branches: r.branches,
          midMerge: r.midMerge,
          previews: r.previews,
          previewNote: r.previewNote,
          staleBuildNote: r.staleBuildNote,
        }),
      )
      .catch(() => {
        // The 1.5s poll will pick up the cleared mid-merge state regardless.
      });
  }, []);

  const {
    merging,
    mergeDisplay,
    mergeAffordance,
    sweepNote,
    aborting,
    resolveConflict,
    mergeStrays,
    forceSweep,
    runAbortMerge,
    reset: mergeLaneReset,
  } = useMergeLane({
    projectPath,
    activeScan,
    runLog,
    liveRunIssueIds,
    runs,
    runStatusOf,
    isIsolated,
    logNote,
    onMergeCompleted: handleMergeCompleted,
    recordProtectedLandTarget,
    refreshScan,
  });
  mergeLaneResetRef.current = mergeLaneReset;

  // Headless Runs render as compact Feed cards, not terminal-sized grid tiles
  // (issue 160) — the tiled grid below is sized for interactive Panes only, so
  // splitting the two here keeps `gridShape` fed just the Pane count.
  const feedRuns = runs.filter((r) => r.target.headless);
  const paneRuns = runs.filter((r) => !r.target.headless);

  // Adaptive tiled grid: the pure layout function decides the shape from the
  // live interactive-Pane count (issue 12) — plus the Just-talk Pane when one
  // is live (issue 81), which tiles beside the Runs like any other session. A
  // maximized tile overrides it with a single cell.
  const shape = gridShape(paneRuns.length + (talk !== null ? 1 : 0));
  const maximizedRun = runs.find((r) => r.target.issueId === maximizedId) ?? null;
  // A maximized headless Run has no Pane grid cell to occupy, so its board and
  // the Pane grid each show only the section that actually holds the maximized
  // tile — the other collapses instead of rendering an empty, padded box.
  const maximizedIsFeed = maximizedRun !== null && maximizedRun.target.headless;

  // Renders one Run's tile — a compact Feed card (headless) or a terminal
  // Pane — shared by the Feed board and the Pane grid so take-over (issue 144)
  // is just a re-render of the same tile with a different body underneath the
  // unchanged header/controls. Extracted to `./RunTile` (issue 172) so the
  // render surface is a plain, prop-driven component.
  const renderRunTile = (r: TrackedRun): JSX.Element => (
    <RunTile
      key={r.target.issueId}
      run={r}
      status={runStatusOf(r)}
      focusedId={focusedId}
      maximizedIssueId={maximizedRun?.target.issueId ?? null}
      isIsolated={isIsolated(r)}
      strandedIds={strandedIds}
      commitFailedIds={commitFailedIds}
      finishedUnmergedIds={finishedUnmergedIds}
      worktreeCommitErrors={worktreeCommitErrors}
      onToggleMaximize={toggleMaximize}
      onTakeOver={takeOverRun}
      onStop={stopRun}
      onDismiss={dismissRun}
      onDiscard={discardRun}
      onSetPaneStatus={setPaneStatus}
      onRunSession={handleRunSession}
      onClaudeSession={handleRunClaudeSession}
      onRunExit={handleRunExit}
    />
  );

  // --- Atlas shell: header open affordances + command palette (issue 124) ---

  // The header switcher's "open a folder" entries (absorbing the old
  // ProjectBar's Browse + Open-here / Open-in-new-Window): the native picker,
  // then the SAME open flow the ProjectBar used — open-here goes straight
  // through `openProjectHere` (unguarded, exactly as the old "Open here"), and
  // open-in-new-Window spawns a fresh Window. Cancelling the picker is a no-op.
  const browseAndOpenHere = useCallback(async (): Promise<void> => {
    const { path } = await window.mc.pickProjectFolder();
    if (path) void openProjectHere(path);
  }, [openProjectHere]);
  const browseAndOpenNewWindow = useCallback(async (): Promise<void> => {
    const { path } = await window.mc.pickProjectFolder();
    if (path) void window.mc.openWindow({ path });
  }, []);

  // A palette issue-jump (or any "land on this issue") lands on the Map with
  // the issue selected — reusing the exact focus channel the Inbox
  // click-through uses (issue 80), so the palette adds no new authority: it is
  // the same Map selection a click would make. `fileRef` stays null (no
  // "From Inbox" line), and the sequence bump re-selects on repeat jumps.
  const jumpToIssueOnMap = useCallback(
    (issueId: number): void => {
      setInboxFocus({ project: activeProjectKeyRef.current ?? '', issueId, fileRef: null });
      setInboxFocusSeq((n) => n + 1);
      applyShellEvent({ kind: 'navigate', to: 'map' });
    },
    [applyShellEvent],
  );

  // The palette's command set (issue 124), merged from four providers via the
  // pure `command-registry`. Each command's `run` routes through the same flow
  // its clickable counterpart does — the palette holds no authority of its own:
  //   • projects  → `attemptProjectChange` (the interrupt guard, exactly as the
  //                 switcher), disabled when owned by another Window;
  //   • views     → a shell navigate event (the rail's own action);
  //   • issues    → the active Project's OPEN issues, jumping to the Map;
  //   • actions   → the entry points New project / Grill a feature / Simple
  //                 issue / Just talk / theme toggle.
  const paletteCommands = useMemo<Command[]>(() => {
    const projectCmds: Command[] = projects.map((p) => ({
      id: `project:${p.key}`,
      kind: 'project',
      title: p.label || p.key,
      hint:
        p.ownership === 'other'
          ? 'open elsewhere'
          : p.key === activeProjectKey
            ? 'current'
            : 'switch',
      keywords: p.key,
      disabled: p.ownership === 'other',
      run: () =>
        attemptProjectChange({
          path: p.key,
          label: p.label || p.key,
          proceed: () => void switchProject(p.key),
        }),
    }));

    const viewCmds: Command[] = shellTabs(shellCtx).map((t) => ({
      id: `view:${t.id}`,
      kind: 'view',
      title: t.label,
      hint: `Go to ${t.label}`,
      // The ViewId as a keyword keeps 'inbox' finding the 'Attention' entry.
      keywords: t.id,
      run: () => applyShellEvent({ kind: 'navigate', to: t.id }),
    }));

    const issueCmds: Command[] = (backlog?.issues ?? [])
      .filter((i) => i.status === 'open')
      .map((i) => ({
        id: `issue:${i.id}`,
        kind: 'issue',
        title: i.title,
        hint: `#${String(i.id).padStart(2, '0')}`,
        keywords: `${i.id} ${i.slug}`,
        run: () => jumpToIssueOnMap(i.id),
      }));

    const actionCmds: Command[] = [
      {
        id: 'action:new-project',
        kind: 'action',
        title: 'New project',
        hint: 'on Home',
        run: () => applyShellEvent({ kind: 'navigate', to: 'launcher' }),
      },
    ];
    // Grill a feature / Simple issue apply to the active workbench Project's
    // ＋ Start something verbs — offered only when there is one. Grill opens the
    // Planning view directly; Simple issue lands on the Map where its form lives.
    if (mapStartProject) {
      actionCmds.push({
        id: 'action:grill',
        kind: 'action',
        title: 'Grill a feature',
        hint: 'plan a Big feature',
        run: () => void startPlanning(mapStartProject),
      });
      actionCmds.push({
        id: 'action:simple-issue',
        kind: 'action',
        title: 'Simple issue',
        hint: 'on the Map',
        run: () => applyShellEvent({ kind: 'navigate', to: 'map' }),
      });
    }
    actionCmds.push({
      id: 'action:just-talk',
      kind: 'action',
      title: 'Just talk',
      hint: 'a warm Pane',
      run: () => void talkToFolder(),
    });
    actionCmds.push({
      id: 'action:theme',
      kind: 'action',
      title: 'Toggle theme',
      hint: `to ${theme === 'dark' ? 'light' : 'dark'}`,
      run: toggleTheme,
    });

    return mergeProviders([
      { id: 'projects', commands: projectCmds },
      { id: 'views', commands: viewCmds },
      { id: 'issues', commands: issueCmds },
      { id: 'actions', commands: actionCmds },
    ]);
  }, [
    projects,
    activeProjectKey,
    shellCtx,
    backlog,
    mapStartProject,
    theme,
    toggleTheme,
    attemptProjectChange,
    switchProject,
    applyShellEvent,
    startPlanning,
    talkToFolder,
    jumpToIssueOnMap,
  ]);

  // Global keyboard front door (issue 124): Cmd/Ctrl+K toggles the palette;
  // Cmd/Ctrl+1…N jumps to the Nth rail view in its live order (so N tracks the
  // Plan entry appearing/disappearing). Registered once; the shell context is
  // read live off the ref so the shortcut set never goes stale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const tabs = shellTabs(shellCtxRef.current);
        const tab = tabs[Number.parseInt(e.key, 10) - 1];
        if (tab) {
          e.preventDefault();
          applyShellEvent({ kind: 'navigate', to: tab.id });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyShellEvent]);

  // The four modal dialogs (issue 172: extracted to `./AppDialogs` so this
  // render surface is plain, prop-driven components) — Radix Dialog primitives
  // for the "Initialize git" gate (issue 158), the branch-awareness prompt
  // (issue 167), the open-here-or-new-Window choice (issue 121), and the
  // live-runner interrupt guard (issue 114).
  const gitInitDialog = (
    <GitInitDialog
      projectLabel={activeProject?.label ?? null}
      projectKey={activeProject?.key ?? null}
      prompt={gitInitPrompt}
      busy={gitInitBusy}
      error={gitInitError}
      onClose={() => {
        setGitInitPrompt(null);
        setGitInitError(null);
      }}
      onBusyChange={setGitInitBusy}
      onErrorChange={setGitInitError}
      onProceed={drain.proceedDrain}
    />
  );

  const branchPromptDialog = (
    <BranchPromptDialog
      projectLabel={activeProject?.label ?? null}
      projectPath={projectPath}
      branchStatus={branchStatus}
      prompt={branchPrompt}
      mode={branchPromptMode}
      name={branchPromptName}
      branches={branchPromptBranches}
      selected={branchPromptSelected}
      busy={branchPromptBusy}
      error={branchPromptError}
      onClose={() => {
        setBranchPrompt(null);
        setBranchPromptMode('choose');
        setBranchPromptError(null);
      }}
      onModeChange={setBranchPromptMode}
      onNameChange={setBranchPromptName}
      onBranchesChange={setBranchPromptBranches}
      onSelectedChange={setBranchPromptSelected}
      onBusyChange={setBranchPromptBusy}
      onErrorChange={setBranchPromptError}
      onBranchCreated={(branch) => setBranchStatus({ branch, detached: false, protectedBranch: false })}
      onBranchSwitched={(branch) =>
        setBranchStatus({
          branch,
          detached: false,
          protectedBranch: branch !== null && isProtectedBranch(branch),
        })
      }
      onResume={resumeBranchPrompt}
    />
  );

  const openChoiceDialog = (
    <OpenChoiceDialog
      activeProjectLabel={projects.find((p) => p.key === activeProjectKey)?.label ?? null}
      pending={pendingOpenChoice}
      onClose={() => setPendingOpenChoice(null)}
      onOpenHere={(path) => void openProjectHere(path)}
      onOpenNewWindow={(path) => void window.mc.openWindow({ path })}
    />
  );

  const interruptDialog = (
    <InterruptDialog
      activeProjectLabel={projects.find((p) => p.key === activeProjectKey)?.label ?? null}
      pending={pendingProjectChange}
      onClose={() => setPendingProjectChange(null)}
      onOpenNewWindow={(path) => void window.mc.openWindow({ path })}
    />
  );

  return (
    <AppShell
      view={view}
      shellCtx={shellCtx}
      onNavigate={(to) => applyShellEvent({ kind: 'navigate', to })}
      theme={theme}
      onToggleTheme={toggleTheme}
      collapsed={railCollapsed}
      onToggleCollapsed={() => setRailCollapsed((c) => !c)}
      onOpenPalette={() => setPaletteOpen(true)}
      projectPath={activeProjectKey}
      projectSwitcher={
        <ProjectSwitcher
          projects={projects}
          activeProjectKey={activeProjectKey}
          onSwitch={(key) =>
            attemptProjectChange({
              path: key,
              label: projects.find((p) => p.key === key)?.label || key,
              proceed: () => void switchProject(key),
            })
          }
          onBrowseOpenHere={() => void browseAndOpenHere()}
          onBrowseOpenNewWindow={() => void browseAndOpenNewWindow()}
          error={projectError}
        />
      }
      statusArea={
        <>
          {view === 'pane' && runs.length > 0 && (
            <span className="app__paneinfo">
              {maximizedRun ? (
                <>
                  <span className="app__run-title">
                    {String(maximizedRun.target.issueId).padStart(2, '0')} ·{' '}
                    {maximizedRun.target.issueTitle}
                  </span>
                  <button className="run-restore" onClick={() => setMaximizedId(null)}>
                    Restore grid
                  </button>
                </>
              ) : (
                <span className="app__status">
                  {runs.length} Run{runs.length === 1 ? '' : 's'} tiled
                </span>
              )}
            </span>
          )}
          {view === 'pane' && runs.length === 0 && (
            <span className="app__status">Pane: {paneStatus}</span>
          )}
        </>
      }
      dialogs={
        <>
          {interruptDialog}
          {openChoiceDialog}
          {gitInitDialog}
          {branchPromptDialog}
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            commands={paletteCommands}
          />
        </>
      }
    >
        {/* Map stays mounted (hidden in Pane view) so its live watch keeps the
            backlog — and therefore every Run's status and the drain plan —
            current even while you watch a Pane. */}
        <div className="app__slot" style={{ display: view === 'map' ? 'flex' : 'none' }}>
          <div className="app__map-col">
          {/* The New-project landing nudge (issue 82): one quiet dismissible
              line on the fresh (empty) project's Map pointing at the two ways
              to put something in the backlog. */}
          {onboardNudge !== null && (
            <div className="app__inbox-focus">
              <span className="app__inbox-focus-text">
                <strong>{onboardNudge}</strong> is set up — its backlog is empty. Plan a{' '}
                <strong>Big feature</strong> or add a <strong>Quick fix</strong> from{' '}
                <button
                  className="app__nudge-home"
                  onClick={() => applyShellEvent({ kind: 'navigate', to: 'launcher' })}
                >
                  Home
                </button>
                .
              </span>
              <button
                className="app__inbox-focus-dismiss"
                title="Dismiss"
                onClick={() => setOnboardNudge(null)}
              >
                ✕
              </button>
            </div>
          )}
          {/* An Inbox click-through's file reference (issue 80): the curator
              proposal / HUMAN-SETUP path the item pointed at, as one quiet
              dismissible line — issue references additionally select their
              issue in the Map below. */}
          {inboxFocus && inboxFocus.fileRef !== null && (
            <div className="app__inbox-focus">
              <span className="app__inbox-focus-text">
                From Inbox: <code>{inboxFocus.fileRef}</code> in {inboxFocus.project}
              </span>
              <button
                className="app__inbox-focus-dismiss"
                title="Dismiss"
                onClick={() => setInboxFocus(null)}
              >
                ✕
              </button>
            </div>
          )}
          <Map
            projectPath={activeProjectKey}
            onRun={guardedStartRun}
            onBacklogLoaded={handleBacklogLoaded}
            runLog={runLog}
            activeRunIssueIds={activeRunIssueIds}
            worktreeRunningIds={worktreeRunningIds}
            finishedUnmergedIds={finishedUnmergedIds}
            strandedIds={strandedIds}
            commitFailedIds={commitFailedIds}
            onDiscard={(slug, issueId) => discardRun(issueId, slug)}
            onDrain={drain.guardedStartDrain}
            onStopDrain={drain.stopDrain}
            draining={drain.draining}
            drainMessage={drain.drainMessage}
            debriefAvailable={drain.debriefAvailable}
            onDebrief={debriefDrain}
            cap={drain.cap}
            onCapChange={drain.setCap}
            notUnderGit={notUnderGit}
            branchStatus={branchStatus}
            mergeAffordance={mergeAffordance}
            onResolveConflict={resolveConflict}
            onMergeStrays={mergeStrays}
            onForceSweep={forceSweep}
            sweepNote={sweepNote}
            merging={merging}
            mergeDisplay={mergeDisplay}
            midMerge={midMerge}
            onAbortMerge={runAbortMerge}
            aborting={aborting}
            previews={activeScan.previews}
            previewNote={activeScan.previewNote}
            staleBuildNote={activeScan.staleBuildNote}
            focusIssueId={inboxFocus?.issueId ?? null}
            focusSeq={inboxFocusSeq}
            plannedIssueIds={plannedIssueIds}
            plannedRepos={plannedRepos}
            startProject={mapStartProject}
            onGrillFeature={(p) => void startPlanning(p)}
            onQuickFixRunNow={(p, issue) => void runQuickFixNow(p, issue)}
            onJustTalk={(p) => talkToProject(p)}
          />
          </div>
        </div>

        {/* Every tracked Run's Pane/Feed stays mounted so its session persists.
            Headless Runs lay out as a dense Feed board sized to their compact
            card content (issue 160) — separate from the adaptive terminal grid
            (issue 12) below it, which tiles only the interactive Panes (+ the
            Just-talk Pane, issue 81) so live Runs are visible at once instead
            of hidden behind tabs. Maximizing a tile collapses whichever board
            holds it to a single full-size cell and hides (but keeps mounted)
            the rest; the other board collapses away entirely rather than
            showing an empty padded box. A plain shell Pane (issue 01) shows
            when no Run is tracked. */}
        {(runs.length > 0 || talk !== null) && (
          <div
            className="app__board"
            style={{ display: view === 'pane' ? 'flex' : 'none' }}
          >
            {feedRuns.length > 0 && !(maximizedRun !== null && !maximizedIsFeed) && (
              <div
                className={`app__feedboard${maximizedIsFeed ? ' app__feedboard--max' : ''}`}
              >
                {feedRuns.map(renderRunTile)}
              </div>
            )}
            {(paneRuns.length > 0 || talk !== null) && !maximizedIsFeed && (
              <div
                className={`app__grid${shape.scroll ? ' app__grid--scroll' : ''}`}
                style={{
                  gridTemplateColumns: maximizedRun
                    ? '1fr'
                    : `repeat(${shape.cols}, minmax(0, 1fr))`,
                  gridTemplateRows:
                    maximizedRun || shape.scroll
                      ? undefined
                      : `repeat(${shape.rows}, minmax(0, 1fr))`,
                }}
              >
                {paneRuns.map(renderRunTile)}
                {/* The Just-talk Pane (issue 81): a warm bare session tiled like a
                Run but tracked by nothing — closing it is the only lifecycle. */}
                {talk !== null && (
                  <div
                    className="app__tile"
                    style={{ display: maximizedRun !== null ? 'none' : 'flex' }}
                  >
                    <div className="app__tile-head">
                      <span
                        className="app__tile-dot app__tile-dot--teal"
                        title="talk"
                        aria-label="Just-talk session"
                      />
                      <span className="app__tile-run">Just talk</span>
                      <span className="app__tile-slug">{talk.label}</span>
                      <span className="app__tile-controls">
                        <button
                          className="app__tile-dismiss"
                          title="End this session and close the Pane"
                          onClick={endTalk}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    <Pane
                      talk={talk}
                      focusSignal={talkFocusSignal}
                      onSession={handleTalkSession}
                      onStatusChange={runs.length === 0 ? setPaneStatus : undefined}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* With nothing live to preserve, the empty-shell Pane mounts per
            visit like any remount view (shell-model's pane policy). */}
        {runs.length === 0 && talk === null && isSlotMounted('pane', view, shellCtx) && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <Pane onStatusChange={setPaneStatus} onExit={() => setPaneStatus('exited')} />
          </div>
        )}

        {/* The Planning view (issue 83): a warm Pane beside the live doc
            preview. Kept MOUNTED (hidden) while other views show, so the
            planning session — and its file watch — survive tab switches;
            it unmounts only when the project switches (state cleared). */}
        {planning !== null && isSlotMounted('planning', view, shellCtx) && (
          <div
            className="app__slot"
            style={{ display: view === 'planning' ? 'flex' : 'none' }}
          >
            <PlanningView
              workbenchDir={planning.workbenchDir}
              repoPath={planning.repoPath}
              label={planning.label}
              onSession={handlePlanningSession}
              onSessionEnd={handlePlanningSessionEnd}
              onInput={handlePlanningInput}
              onStage={submitPlanningStage}
            />
          </div>
        )}

        {/* The Launcher (issue 81): the front door every empty Window shows,
            and where the Home tab returns any Window — with its Project (if
            any) left open and untouched. */}
        {isSlotMounted('launcher', view, shellCtx) && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <Launcher
              projects={launcherProjects}
              cards={projectCards}
              attention={attention}
              activeProjectLabel={
                projects.find((p) => p.key === activeProjectKey)?.label ?? null
              }
              onBackToProject={
                activeProjectKey !== null
                  ? () => applyShellEvent({ kind: 'navigate', to: 'map' })
                  : null
              }
              onOpenCard={openCard}
              onProjectCreated={(created) => void landOnNewProject(created)}
              onJustTalkProject={talkToProject}
              onJustTalkFolder={() => void talkToFolder()}
            />
          </div>
        )}

        {/* The unified attention surface (issue 125, replacing the Inbox tab):
            mounted fresh per view — being here IS "viewing", which is what
            advances the briefing's last-seen stamp and freezes the briefing
            you're reading. Available in every Window, whatever Project (if any)
            it has open. */}
        {isSlotMounted('inbox', view, shellCtx) && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <Attention
              snapshot={attention}
              ownProjectKey={activeProjectKey}
              onOpenItem={openAttentionItem}
              onOpenProject={openAttentionProject}
              onRegisterRepo={(item) => void registerRepoFromInbox(item)}
              notice={inboxNotice}
            />
          </div>
        )}

        {/* The Receipts tab (issue 180, ADR-0023): browse finished Runs and
            read a selected one's Receipt through the shared rich viewer, "How
            it works" mermaid diagram live — replaces Map's inline Run-log
            strip. Remount-on-visit: it reads the already-loaded `runLog`
            state, so there is no live watch of its own to preserve. */}
        {isSlotMounted('receipts', view, shellCtx) && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <ReceiptsView records={runLog} />
          </div>
        )}

        {/* The Cost tab (issue 181, ADR-0023): Run telemetry as charts,
            in-app — the same read the `/cost` skill's interim artifact makes,
            native. Remount-on-visit: it reads the already-loaded `runLog` and
            a one-shot `journals` read, so there is no live watch to preserve. */}
        {isSlotMounted('cost', view, shellCtx) && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <CostView records={runLog} journals={journals} />
          </div>
        )}

        {/* The Docs tab (issue 182, ADR-0023): browse the active repo's
            ARCHITECTURE.md / CONTEXT.md / ADRs through the shared rich
            viewer, diagrams live — file-watched (the Planning-view pattern),
            so an on-disk edit refreshes the view. Remount-on-visit: the
            view's own effect starts/stops the watch on mount/unmount, so
            there is nothing to preserve across navigation. */}
        {isSlotMounted('docs', view, shellCtx) && activeDefaultRepo !== null && (
          <div className="app__slot" style={{ display: 'flex' }}>
            <DocsView repoPath={activeDefaultRepo} />
          </div>
        )}
    </AppShell>
  );
}
