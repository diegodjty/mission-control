import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pane } from './Pane';
import { RunFeed } from './RunFeed';
import { Map } from './Map';
import { ProjectSwitcher } from './ProjectSwitcher';
import { CommandPalette } from './CommandPalette';
import { DispatcherPanel } from './DispatcherPanel';
import { Attention } from './Attention';
import { Launcher, type QuickFixIssueRef } from './Launcher';
import { PlanningView } from './PlanningView';
import { AppShell } from './AppShell';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './components';
import { stageInvocation, type PlanningStage } from '../../shared/planning-model';
import { quickFixRunTarget } from '../../shared/launcher-model';
import {
  workbenchProjectPath,
  needsYouCount,
  type AttentionItem,
} from '../../shared/attention-hub-model';
import type { Backlog, IssueStatus } from '../../shared/backlog-model';
import { resolveWorkerEffort, resolveWorkerModel } from '../../shared/worker-model';
import type {
  AttentionSnapshot,
  NavigateAttentionMessage,
  DispatcherTarget,
  LauncherProject,
  ProjectCardView,
  ProjectView,
  RunLogRecord,
  RunTarget,
  TalkTarget,
} from '../../shared/ipc-contract';
import {
  renderCompletionEvent,
  toCompletionEvent,
} from '../../shared/dispatcher-input-contract';
import {
  createDispatcherPump,
  type DeliveryPhase,
  type DispatcherPump,
} from '../../shared/dispatcher-pump';
import {
  recordActivity,
  resolveActivity,
  type DispatcherActivity,
} from '../../shared/dispatcher-proposal';
import {
  channelForAction,
  canFlushChat,
  reduceTyping,
  isStatusInjectionTrigger,
  INITIAL_TYPING_STATE,
  type TypingState,
} from '../../shared/dispatcher-channel';
import {
  actionForLifecycle,
  lifecycleKindForOutcome,
  reactToLifecycleEvent,
  type LifecycleEvent,
} from '../../shared/dispatcher-lifecycle';
import type { DispatcherAction } from '../../shared/dispatcher-authority';
import { shouldAutoMerge, decideDispatcherMerge } from '../../shared/dispatcher-merge';
import {
  describeDocDrift,
  detectCrossRunOverlap,
  extractDocDrift,
} from '../../shared/dispatcher-synthesis';
import { isRealCapture, isStrongOverlap } from '../../shared/dispatcher-noise-floor';
import {
  narrativeChannelFor,
  narrativeKindForLifecycle,
  narrativeKeyFor,
  sessionSeenRecordId,
  type NarrativeEventKind,
} from '../../shared/dispatcher-narrative';
import {
  reconcileStatusModel,
  renderStatusModel,
  debounceStatusModel,
  initialStatusDebounceState,
  buildStatusSnapshotMessage,
  buildRunDigest,
  type DispatcherStatusModel,
  type StatusDebounceState,
} from '../../shared/dispatcher-status-model';
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
import {
  planDrain,
  drainAvailability,
  type ActiveRun,
} from '../../shared/run-coordinator';
import { takeoverKindFor, takeoverTarget } from '../../shared/run-takeover';
import { isNotableDrainActivity } from '../../shared/workbench-memory';
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
  mergeReadinessOnDisk,
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
  mergeResultDisplay,
  pendingMergeDisplay,
  emptyMergeDisplay,
  mergeThrewDisplay,
  type MergeDisplay,
} from '../../shared/merge-display';
import {
  clampDispatcherWidth,
  dispatcherWidthFromPointer,
  DEFAULT_DISPATCHER_WIDTH,
} from '../../shared/dispatcher-width';

/** localStorage key for the app-wide persisted Dispatcher rail width (issue 44). */
const DISPATCHER_WIDTH_KEY = 'mc.dispatcherWidth';

/** localStorage key for the persisted UI theme (Atlas design language). */
const THEME_KEY = 'mc.theme';
/** localStorage key for the persisted rail-collapsed preference (issue 124). */
const RAIL_COLLAPSED_KEY = 'mc.railCollapsed';
type Theme = 'dark' | 'light';

/** Read the persisted theme; the navy dark stage is the default. */
function loadTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Grace window before the Receipt audits conclude anything (issue 57,
 * ADR-0012's debounce discipline). A Worker's Receipt can land a beat after
 * its issue's `done` flip is observed (write → watch debounce → stability
 * reads), and a `done` flip can land a beat after its Receipt — so both the
 * finished-without-receipt note and the Receipt/state-mismatch note re-check
 * the live facts after this window and stay silent when reality caught up.
 */
const RECEIPT_AUDIT_GRACE_MS = 5000;

/**
 * Collapse a (possibly multi-line) fact into one quiet ambient-log line (issue
 * 48): the activity log renders `label` as a single row, so newlines become ` · `
 * separators the way the chat feed flattens its messages.
 */
function oneLineNote(text: string): string {
  return text.trim().replace(/\s*[\r\n]+\s*/g, ' · ');
}

/**
 * The prominent "big warning" (issue 113) shown as a `protected-branch-land`
 * proposal label and typed into the chat: landing a Run's work on a protected
 * branch (`main`/`master`) needs an explicit click because such a branch is
 * usually wired to production/deploy workflows.
 */
function protectedLandWarning(branch: string): string {
  return (
    `⚠️ About to land Run work on the protected branch '${branch}'. ` +
    `'${branch}' may be tied to production/deploy workflows — approve to proceed, ` +
    `or reject to leave the finished work on its branch/worktree unmerged.`
  );
}

/** Read the persisted rail width, clamped; falls back to the default when unset. */
function loadDispatcherWidth(): number {
  try {
    const raw = window.localStorage.getItem(DISPATCHER_WIDTH_KEY);
    return raw === null ? DEFAULT_DISPATCHER_WIDTH : clampDispatcherWidth(Number.parseFloat(raw));
  } catch {
    return DEFAULT_DISPATCHER_WIDTH;
  }
}

/** The `NN-slug` for a Run, from its issue file name (`NN-slug.md`). */
function slugOf(fileName: string): string {
  return fileName.replace(/\.md$/, '');
}

/** The status-dot tone for a Run's derived status (issue 129 tile header): the
 * at-a-glance liveness colour on each tile, the same dot idiom the Map uses for
 * its issues (issue 127). Maps to the `.app__tile-dot--*` tokens in Pane.css. */
function dotTone(status: RunStatus): 'amber' | 'green' | 'red' | 'teal' | 'neutral' {
  switch (status) {
    case 'running':
      return 'amber';
    case 'finished':
      return 'green';
    case 'blocked':
      return 'red';
    case 'parked':
      return 'teal';
    case 'stopped':
    default:
      return 'neutral';
  }
}

/** The maximize / restore glyph for a tile's per-tile control (issue 129, the
 * approved `pane` mock). Inline SVG stroked in `currentColor` so it follows the
 * active Atlas theme; arrows point outward to maximize, inward to restore. */
function MaximizeIcon({ maximized }: { maximized: boolean }): JSX.Element {
  return maximized ? (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="10" y1="14" x2="3" y2="21" />
    </svg>
  ) : (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/**
 * What the Planning view (issue 83) is planning: the chosen project's two
 * planning roots plus its label. Per-Project state — cleared on a switch.
 */
interface PlanningTargetState {
  workbenchDir: string;
  repoPath: string;
  label: string;
}

/**
 * An Inbox click-through's focus request (issue 80): the thing the clicked
 * item referenced, to be surfaced once its project is open — the issue is
 * selected in the Map; the file reference shows as a quiet dismissible line.
 */
interface InboxFocus {
  project: string;
  issueId: number | null;
  fileRef: string | null;
}

/**
 * One Run the UI is tracking: its target plus the observable facts
 * (`deriveRunStatus` in run-state turns these into running/finished/blocked/
 * stopped). `stopSignal` is bumped to kill its session on demand.
 */
interface TrackedRun {
  target: RunTarget;
  sessionAlive: boolean;
  stoppedByUser: boolean;
  stopSignal: number;
  /**
   * The drain generation (`drainSeq`) that started this Run, or null for a
   * manual "▶ Run" that no drain owns (issue 132). It's how the drain re-plan
   * tells a Run it started this generation (counts against the cap) from a
   * LEFTOVER Pane carried over from a PRIOR drain — a `claude` session lingering
   * alive at its prompt from yesterday, which run-state still reads `running`.
   * Such a phantom must not silently shrink a fresh drain's effective cap.
   */
  drainGeneration: number | null;
  /**
   * The MC-internal spawn session id, once its Feed/Pane reports it (issue 139).
   * Null until spawned. Paired with `claudeSessionId` for a headless Run's
   * future take-over (kill this process, `claude --resume <claudeSessionId>`).
   */
  sessionId?: string | null;
  /**
   * A headless drain Run's claude session id, captured from its stream-json
   * (issue 139, AC3) and persisted here on the Run record for resume/take-over.
   * Null for a manual (Pane) Run and until the headless Run's init event lands.
   */
  claudeSessionId?: string | null;
}

function newRun(target: RunTarget, drainGeneration: number | null = null): TrackedRun {
  return {
    target,
    sessionAlive: true,
    stoppedByUser: false,
    stopSignal: 0,
    drainGeneration,
    sessionId: null,
    claudeSessionId: null,
  };
}

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
  const planningPumpRef = useRef<DispatcherPump | null>(null);
  if (planningPumpRef.current === null) {
    planningPumpRef.current = createDispatcherPump({
      write: (sessionId, data) => window.mc.writePty({ sessionId, data }),
      canFlush: (now) => canFlushChat(planningTyping.current, now),
    });
  }
  const planningPump = planningPumpRef.current;
  // Monotonic per-click id so re-clicking a stage button re-sends (the pump
  // dedupes by key; each click is deliberately its own delivery).
  const planningStageSeq = useRef(0);

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

  // --- Drain state ---------------------------------------------------------
  const [draining, setDraining] = useState(false);
  const [cap, setCap] = useState(2);
  const [drainMessage, setDrainMessage] = useState('');

  // --- Dispatcher state (issue 35, ADR-0010) -------------------------------
  // The conversational orchestrator for a drain: spun up WHEN A DRAIN STARTS
  // (a single manual Run stays a bare Pane), one per Project, dismissable. Null
  // when no drain has started this Project session. `sessionId` is set once its
  // chat Pane spawns, so we can feed it each Run's Completion block (structured
  // summary — never raw Pane scroll). `dispatcherFed` tracks which Runs' blocks
  // we've already fed, so a re-capture/re-render doesn't double-feed.
  const [dispatcher, setDispatcher] = useState<{
    target: DispatcherTarget;
    sessionId: string | null;
  } | null>(null);
  const dispatcherFed = useRef<Set<string>>(new Set<string>());
  // The ONE "this session has seen it" set (issues 61 + 66, ADR-0014): which
  // Runs' blocks the CURRENT Dispatcher session has been given — live (a
  // narrative/park message the pump submitted or has queued) or via the on-ask
  // digest. Shared by both paths so a digest ask never re-lists a Run the
  // session was just narrated, and vice versa. Baselined at Dispatcher creation
  // to the records already in the Run log (they predate the session's seed); a
  // REPLACEMENT session (a brand-new claude conversation) resets it to that
  // baseline so the digest catches the new session up. Distinct from
  // `dispatcherFed`, which guards enqueueing once per Run per Dispatcher.
  // Cleared wherever `dispatcherFed` is.
  const dispatcherSessionSeen = useRef<Set<string>>(new Set<string>());
  // The record ids that predate this Dispatcher's creation (issue 66) — what a
  // replacement session's seen-set resets TO, so old drains' persisted blocks
  // are never replayed while this drain's narrative is caught up via the digest.
  const dispatcherDigestBaseline = useRef<Set<string>>(new Set<string>());
  // Whether the current Dispatcher has already had a chat session attached —
  // how `handleDispatcherSession` tells a REPLACEMENT (reset the seen-set) from
  // the first spawn (the baseline from Dispatcher creation already applies).
  const dispatcherHadSession = useRef<boolean>(false);
  // Monotonic per-drain sequence, so each drain's stopped/halted narrative fact
  // gets a stable, deduped delivery key (issue 66).
  const drainSeq = useRef<number>(0);
  // --- Drain journal state (issue 73, ADR-0015) ----------------------------
  // What was ALREADY in the Run log / activity strip when the current drain
  // started, so the journal entry carries exactly THIS drain's story — the
  // delta — not the Project's whole history. Snapshotted in `startDrain`.
  const drainLogBaseline = useRef<Set<string>>(new Set<string>());
  const drainNotableBaseline = useRef<Set<string>>(new Set<string>());
  // The last drain sequence whose journal write was scheduled — "written once
  // per drain": the user-stop and Coordinator-stop paths can't both fire it.
  const drainJournalSeq = useRef<number>(0);
  // The Dispatcher rail's width (issue 44): user-adjustable by dragging the
  // divider between the Map and the panel, within a sensible min/max, persisted
  // app-wide so it survives closing/reopening the panel and the app. Changing it
  // resizes the chat Pane, whose ResizeObserver (issue 12) reflows the terminal.
  const [dispatcherWidth, setDispatcherWidth] = useState<number>(loadDispatcherWidth);
  // Serialized, UNSTALLABLE submit pump for the Dispatcher chat (issues 41/48/60).
  // It owns the per-Project queue of chat-tier messages: each is TYPED then
  // SUBMITTED with a separate Enter write, one message fully before the next
  // (issue 41), held while the user is mid-compose (issue 48). Issue 60 moved it
  // out of this component into the tested `dispatcher-pump` module because the
  // inline version could stall forever: a session replaced mid-pump kept the
  // writes going to the dead PTY (closure), a write failure stranded the queue
  // behind a stuck pumping flag, and nothing ever re-kicked it — which is how a
  // HITL-waiting notification silently never reached the chat. The pump keys
  // items by event key, keeps an item queued until its submit lands in a
  // still-current session, redelivers across session replacement/death, retries
  // via a watchdog, and reports queued/typed/submitted per item (see
  // `noteDelivery` below). Created lazily below, after the state it observes.
  const dispatcherPumpRef = useRef<DispatcherPump | null>(null);
  // Monotonic id for on-ask status-snapshot injections (issue 52), so each ask
  // gets its own delivery key in the pump.
  const statusInjectionSeq = useRef<number>(0);
  // The user's compose state on the Dispatcher chat's input line (issue 48,
  // ADR-0012). Folded from the chat Pane's keystrokes, it is the defer-while-
  // typing gate the pump consults before flushing: a programmatic write is held
  // while the user is mid-compose and only lands once the input line is idle, so
  // the app never interleaves with the user's typing ("prompt over prompt").
  const dispatcherTyping = useRef<TypingState>(INITIAL_TYPING_STATE);
  // The Dispatcher's authority activity log (issue 36, ADR-0011): non-blocking
  // actions it took on its own (silent/passive — shown as quiet notes) and the
  // three-item blocking list it must propose (merge-conflict, abort-drain, HITL
  // sign-off — shown with one-click approve/reject that don't execute until
  // approved).
  const [dispatcherActivities, setDispatcherActivities] = useState<DispatcherActivity[]>([]);
  // Live mirror of `dispatcherActivities` for the drain-journal write (issue
  // 73): its grace-window timer must read the CURRENT strip (a notable event —
  // an adoption, a finished-without-receipt note — may land after the drain's
  // stop was observed), not the render it was scheduled in.
  const dispatcherActivitiesRef = useRef<DispatcherActivity[]>([]);
  useEffect(() => {
    dispatcherActivitiesRef.current = dispatcherActivities;
  }, [dispatcherActivities]);
  // Delivery observability (issue 60, rule 3): each chat item's queued → typed →
  // submitted (or requeued / write-failed) state renders as ONE quiet ambient-log
  // line per item, updated in place — so the next walkthrough can SEE where a
  // notification died instead of inferring it. `relay` is silent → log channel.
  const noteDelivery = useCallback(
    (key: string, phase: DeliveryPhase, detail?: string): void => {
      // ADR-0014 (issue 66): a submit always lands in the CURRENT session
      // (issue 60's guarantee), so a delivered narrative / park message marks
      // its Run as seen by this session — re-marking after a replacement
      // session's reset, so the on-ask digest never re-lists a Run the pump
      // just re-delivered.
      if (phase === 'submitted') {
        const seenId = sessionSeenRecordId(key);
        if (seenId !== null) dispatcherSessionSeen.current.add(seenId);
      }
      const label = oneLineNote(`Chat delivery ${phase}${detail ? ` (${detail})` : ''} — ${key}`);
      setDispatcherActivities((prev) => {
        const id = `delivery:${key}`;
        const note = recordActivity(id, 'relay', label);
        const idx = prev.findIndex((a) => a.id === id);
        if (idx === -1) return [...prev, note];
        const next = [...prev];
        next[idx] = note;
        return next;
      });
    },
    [],
  );
  // Create the pump once (ref-guarded; inert until something enqueues). Its
  // effects read live refs, so it always consults the CURRENT compose state and
  // writes through the preload PTY surface; timers are the real defaults.
  if (dispatcherPumpRef.current === null) {
    dispatcherPumpRef.current = createDispatcherPump({
      write: (sessionId, data) => window.mc.writePty({ sessionId, data }),
      canFlush: (now) => canFlushChat(dispatcherTyping.current, now),
      onDelivery: noteDelivery,
    });
  }
  const dispatcherPump = dispatcherPumpRef.current;
  // Lifecycle-event reactions (issue 37): which lifecycle events (keyed
  // `<kind>:<runId>`) the Dispatcher has already reacted to, so a re-render /
  // re-scan doesn't re-notify or re-propose. `discardTargets` maps a
  // discard-and-continue proposal's id to the worktree it would discard, so
  // approving it executes the real issue-22 discard (when there is a worktree).
  const lifecycleReacted = useRef<Set<string>>(new Set<string>());
  // Keyed by proposal id (`Map` the component name shadows the global, so a plain
  // record avoids the collision).
  const discardTargets = useRef<Record<string, { issueId: number; slug: string }>>({});
  // Cross-Run synthesis (issue 38): which shared seams the Dispatcher has already
  // surfaced as a cross-Run pattern, so a re-scan doesn't re-narrate the same
  // "these Runs all hit X" line each poll.
  const overlapSurfaced = useRef<Set<string>>(new Set<string>());
  // Ground-truth status re-grounding (issue 43): the last status-model text fed
  // to the Dispatcher, so it is re-fed only when the reconciled done/wip/open/
  // finished-unmerged picture actually changes — not on every render/poll.
  const statusRefreshSig = useRef<string | null>(null);
  // Debounce backward status moves (issue 49, ADR-0012): the state carried
  // between reconcile checkpoints so a transient mid-reconcile regression (the
  // false "05/06/07 regressed to open — merge is failing" blip) is held until it
  // persists across a further checkpoint before being surfaced. `seenReconciled`
  // makes the advance idempotent under StrictMode's double-invoke: the debounce
  // advances exactly once per DISTINCT reconciled model, never twice for one.
  const statusDebounce = useRef<StatusDebounceState>(initialStatusDebounceState());
  const seenReconciled = useRef<DispatcherStatusModel | null>(null);
  const debouncedStatusModelRef = useRef<DispatcherStatusModel | null>(null);

  // --- Merge state (issue 08; issue 17) ------------------------------------
  // `mergeDisplay` is the pure selector's decision of what the Merge UI shows
  // (headline + whether/what to put in the details panel). Surfacing the
  // adapter's `output` here is what gives "see details below" an actual below.
  const [merging, setMerging] = useState(false);
  const [mergeDisplay, setMergeDisplay] = useState<MergeDisplay | null>(null);
  // The mergeable-set signature the Dispatcher has already AUTO-attempted this
  // drain (issue 46). A clean auto-merge drops the branches and a conflict sets
  // `midMerge` — both self-guard against a re-fire — but a preflight failure
  // leaves the branch set unchanged, so this stops the auto-merge effect from
  // looping on it. Reset on Project switch / dispatcher dismissal.
  const autoMergeSig = useRef<string | null>(null);

  // --- Protected-branch guard (issue 113) ----------------------------------
  // Before a Run's work LANDS on a protected branch (`main`/`master`), the drain
  // STOPS for an explicit one-click confirmation (a `protected-branch-land`
  // blocking proposal, ADR-0011 as amended). `protectedGatedSoloIds` holds solo
  // Run ids whose `main`-commit is withheld pending that click, so the commit
  // effect stops re-firing (and looping) until the human approves.
  // `protectedLandTargets` maps a proposal id to what approving re-executes (the
  // merge, or a specific solo commit) with confirmation. Reset on Project switch
  // / dispatcher dismissal, like the other proposal bookkeeping.
  const protectedGatedSoloIds = useRef<Set<number>>(new Set<number>());
  const protectedLandTargets = useRef<
    Record<
      string,
      { kind: 'merge'; auto: boolean } | { kind: 'solo'; issueId: number; nextPhase: SoloCommitPhase }
    >
  >({});
  // The solo-commit path resolves its withheld landings here (a state queue),
  // drained into a proposal + chat warning by an effect below — `commitSoloRun`
  // runs before the surfacing helpers exist, mirroring `soloAdoptions` (issue 62).
  const [soloProtectedGates, setSoloProtectedGates] = useState<
    { issueId: number; branch: string; nextPhase: SoloCommitPhase }[]
  >([]);

  // --- Mid-merge state (issue 24) ------------------------------------------
  // `main` is left mid-merge when a partial `afk-merge.sh` run committed some
  // slugs then hit a conflict (a conflicted index / MERGE_HEAD). It is polled
  // from disk as part of the afk/ scan and DERIVED from that scan below (scoped
  // to the active Project — issue 26), never held as its own state that could
  // outlive a Project switch. While true, a new drain/Run is refused and an
  // Abort affordance is offered so a non-git user can return `main` to a clean
  // state.
  const [aborting, setAborting] = useState(false);

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
    setDraining(false);
    setDrainMessage('');
    // The Dispatcher is per-Project (ADR-0010): drop it on a switch so the new
    // Project never inherits the previous one's orchestrator. Unmounting its
    // panel kills the session.
    setDispatcher(null);
    dispatcherFed.current.clear();
    dispatcherSessionSeen.current.clear();
    dispatcherDigestBaseline.current.clear();
    dispatcherHadSession.current = false;
    dispatcherPumpRef.current?.reset();
    dispatcherTyping.current = INITIAL_TYPING_STATE;
    setDispatcherActivities([]);
    lifecycleReacted.current.clear();
    discardTargets.current = {};
    overlapSurfaced.current.clear();
    statusRefreshSig.current = null;
    statusDebounce.current = initialStatusDebounceState();
    seenReconciled.current = null;
    debouncedStatusModelRef.current = null;
    setMerging(false);
    setAborting(false);
    setMergeDisplay(null);
    autoMergeSig.current = null;
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
            (prev.previewNote ?? null) === res.previewNote
              ? prev
              : {
                  projectPath,
                  branches: res.branches,
                  midMerge: res.midMerge,
                  previews: res.previews,
                  previewNote: res.previewNote,
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

  const endTalk = useCallback((): void => setTalk(null), []);

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
            .then((r) => setAfkScan({ projectPath, branches: r.branches, midMerge: r.midMerge, previews: r.previews, previewNote: r.previewNote }))
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

  const handleRunExit = useCallback((issueId: number): void => {
    setRuns((prev) =>
      prev.map((r) =>
        r.target.issueId === issueId ? { ...r, sessionAlive: false } : r,
      ),
    );
  }, []);

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

  // --- Feed Completion blocks to the Dispatcher (issue 35, issue 41) --------
  // As each Run finishes and its Completion block is captured into the Run log,
  // hand that STRUCTURED block to the Dispatcher session — this is the input
  // contract's stream (ADR-0009). It is built from the parsed record via the
  // pure assembler, so it can NEVER carry raw Pane scroll. Fed once per Run
  // (guarded by `dispatcherFed`), and only once the block parsed to something
  // real (outcome !== 'unknown'), so a still-streaming capture isn't fed as
  // noise.
  //
  // Submission (issue 41): a block must be SUBMITTED, not just typed — typing
  // the text and its `\r` in one PTY write lets the claude TUI's bracketed-paste
  // handling swallow the `\r` as literal text, so the block sat unsent. The
  // type-settle-submit-settle sequencing, the defer-while-typing hold (issue 48),
  // and the issue-60 resilience (redelivery across session churn, write-failure
  // recovery, watchdog re-kick) all live in the tested `dispatcher-pump` module;
  // `dispatcherPump` above is this Project's instance.

  // Report the user's keystrokes on the Dispatcher chat so the defer gate
  // knows when the input line is idle (issue 48). Fires only for real user input
  // into the chat terminal — the Dispatcher's own queued writes go out via
  // `writePty` and never reach this, so they can't be mistaken for typing.
  //
  // On-demand ground-truth injection (issue 52): the same input stream is where
  // we detect the user SENDING a message, and enqueue the CURRENT reconciled +
  // debounced status snapshot as quiet context. After issue 48/ADR-0012 routed
  // the `status-refresh` to the ambient log, the chat session heard nothing after
  // its seed, so "what's left?" answered from the drain-start seed (the issue-51
  // bug). Injecting the snapshot at query time re-grounds the session in reality
  // WITHOUT reintroducing per-fact chat streaming (ADR-0012) — the chat stays
  // quiet the rest of the time. The pure `isStatusInjectionTrigger` reads the
  // PRE-fold compose state (so a bare Enter on an empty prompt does not fire), and
  // `buildStatusSnapshotMessage` renders the snapshot (or null when the backlog
  // has not loaded). The snapshot rides the SAME serialized submit queue as the
  // feed, so it honours the defer-while-typing gate and never interleaves with the
  // user's own line.
  const handleDispatcherInput = useCallback(
    (data: string): void => {
      const prev = dispatcherTyping.current;
      if (isStatusInjectionTrigger(prev, data)) {
        // The Completion-block digest (issue 61) rides the SAME injection: the
        // status snapshot re-grounds "what's done/left", the digest catches the
        // session up on WHAT EACH RUN SAID (issue + outcome + a What-changed /
        // park-reason line) — the qualitative substance ADR-0012's log routing
        // took out of the session's reach. Ids are marked as given only once
        // the injection is actually enqueued; when there is no status model yet
        // nothing injects and the blocks stay pending for the next ask.
        const digest = buildRunDigest(runLogRef.current, dispatcherSessionSeen.current);
        const snapshot = buildStatusSnapshotMessage(debouncedStatusModelRef.current, digest.text);
        if (snapshot !== null) {
          for (const id of digest.digestedIds) dispatcherSessionSeen.current.add(id);
          statusInjectionSeq.current += 1;
          dispatcherPump.enqueue({
            key: `status-snapshot:${statusInjectionSeq.current}`,
            text: snapshot,
          });
        }
      }
      dispatcherTyping.current = reduceTyping(prev, data, Date.now());
    },
    [dispatcherPump],
  );

  // Record a routine passive FACT as a quiet ambient-log note (issue 48,
  // ADR-0012): it appears in the activity log beside the chat rather than being
  // typed into the chat session. Deduped by id so a re-render / re-scan can't
  // double-log it. `label` carries the fact's own plain-language text.
  const logNote = useCallback(
    (id: string, action: DispatcherAction, label: string): void => {
      setDispatcherActivities((prev) =>
        prev.some((a) => a.id === id)
          ? prev
          : [...prev, recordActivity(id, action, oneLineNote(label))],
      );
    },
    [],
  );

  // Route one Dispatcher event to its channel (issue 48, ADR-0012). The pure,
  // tested `channelForAction` is the single decision: a `blocking`-tier action is
  // a conversational prompt typed into the chat PTY via the serialized pump —
  // keyed by the event id, so the pump's in-queue dedupe and per-item delivery
  // log line up with the event (issue 60); every routine passive/silent fact
  // becomes an ambient-log note instead — so the chat carries ONLY blocking
  // approvals + the user's own conversation. Returns true when it enqueued a
  // chat write (the pump kicks itself; nothing further for the caller to do).
  const surfaceEvent = useCallback(
    (id: string, action: DispatcherAction, text: string): boolean => {
      if (channelForAction(action) === 'chat') {
        dispatcherPump.enqueue({ key: id, text });
        return true;
      }
      logNote(id, action, text);
      return false;
    },
    [logNote, dispatcherPump],
  );

  // Surface RUN NARRATIVE per ADR-0014 (issue 66): the pure, tested
  // `narrativeChannelFor` decides whether this kind is a live message in the
  // Dispatcher CONVERSATION (a finished Run's Completion block, an HITL park,
  // a drain stopped/halted fact, adopted strays, finished-without-receipt) or
  // a history-strip line only (blocked/stranded alerts, doc-drift, overlaps —
  // the ADR-0012 noise floor stands). Either way the activity strip keeps its
  // history line — it demotes to a scannable log, it doesn't go blind. A
  // chat-bound Run message is immediately counted into the session-seen set
  // (shared with the issue-61 digest) so an ask mid-delivery can't double-list
  // it; `action` only labels the history note (narrative is never a gate — the
  // ADR-0011 blocking list is untouched).
  const surfaceNarrative = useCallback(
    (kind: NarrativeEventKind, id: string, action: DispatcherAction, text: string): void => {
      if (narrativeChannelFor(kind) === 'chat') {
        dispatcherPump.enqueue({ key: id, text });
        const seenId = sessionSeenRecordId(id);
        if (seenId !== null) dispatcherSessionSeen.current.add(seenId);
      }
      logNote(id, action, text);
    },
    [logNote, dispatcherPump],
  );

  // Drain the SOLO-path stray-Receipt adoptions (issue 62) into narrative. The
  // adoptions are queued where the commit resolves (`commitSoloRun`, defined
  // before the surfacing helpers exist) and surfaced here — one per adoption
  // batch, deduped by its file list. An adoption is a drain fact worth telling
  // (ADR-0014, issue 66): a message in the Dispatcher conversation, plus the
  // history line.
  useEffect(() => {
    if (soloAdoptions.length === 0) return;
    for (const files of soloAdoptions) {
      surfaceNarrative(
        'strays-adopted',
        `receipt-adopt:solo:${files.join(',')}`,
        'receipt-adopt',
        `Adopted stray Receipt(s) on main: ${files.join(', ')}`,
      );
    }
    setSoloAdoptions([]);
  }, [soloAdoptions, surfaceNarrative]);

  // Drain the SOLO-path protected-branch withholds (issue 113) into a blocking
  // gate. Queued in `commitSoloRun` (which runs before the surfacing helpers
  // exist); here — once they do — each becomes a `protected-branch-land` pending
  // proposal (the DispatcherPanel's approve/reject) AND a chat warning via the
  // pump, deduped per issue. Approving re-commits with confirmation; rejecting
  // leaves the finished work uncommitted on the protected branch. The target
  // records what approval re-executes.
  useEffect(() => {
    if (soloProtectedGates.length === 0) return;
    for (const gate of soloProtectedGates) {
      const pid = `protected-branch-land:solo:${gate.issueId}`;
      protectedLandTargets.current[pid] = {
        kind: 'solo',
        issueId: gate.issueId,
        nextPhase: gate.nextPhase,
      };
      setDispatcherActivities((prev) =>
        prev.some((a) => a.id === pid)
          ? prev
          : [...prev, recordActivity(pid, 'protected-branch-land', protectedLandWarning(gate.branch))],
      );
      surfaceEvent(pid, 'protected-branch-land', protectedLandWarning(gate.branch));
    }
    setSoloProtectedGates([]);
  }, [soloProtectedGates, surfaceEvent]);

  useEffect(() => {
    if ((dispatcher?.sessionId ?? null) === null) return;
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
      if (dispatcherFed.current.has(rec.id)) continue;
      dispatcherFed.current.add(rec.id);
      const text = renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec }));
      if (rec.outcome === 'completed') {
        // ADR-0014 (issue 66): a finished Run's Completion block is RUN
        // NARRATIVE — typed + submitted into the Dispatcher conversation live
        // via the pump, one message per Run, replacing issue 48's ambient-only
        // `synthesize` routing for narrative. The strip keeps its history line.
        surfaceNarrative('run-completed', narrativeKeyFor(rec.id), 'synthesize', text);
      } else {
        // A blocked/parked block's substance rides its lifecycle surface
        // instead — the blocking HITL park notice, or the BLOCKED park's
        // Run-narrative chat message (issue 137) — so the full block text stays a
        // history line here, never a second chat message for the same Run.
        surfaceNarrative('run-blocked-alert', `synthesize:${rec.id}`, 'synthesize', text);
      }
      // Cross-Run synthesis (issue 38, acceptance a): a block that reports doc-drift
      // (a PRD/reality contradiction) surfaces as a plain-language note. A
      // SPECULATIVE signal, so it stays below the conversation bar (ADR-0014
      // keeps the ADR-0012 noise floor): a history-strip note, never the chat.
      // Doc-drift free / "none" blocks add nothing.
      const [drift] = extractDocDrift([rec]);
      if (drift) {
        surfaceNarrative(
          'doc-drift',
          `doc-drift:${rec.id}`,
          'amend-plan',
          `${describeDocDrift(drift)} — the plan may need amending to reconcile it.`,
        );
      }
    }
    // Cross-Run patterns (issue 38, acceptance b/c): once ≥2 Runs touch the same
    // seam (a file, a named "… seam", a shared identifier), consolidate them into
    // ONE surfaced line instead of leaving the user to spot it across cards. The
    // detection is the pure `detectCrossRunOverlap` over the captured records.
    // Noise floor (issue 47, ADR-0012): consolidation is demoted to a RARE note —
    // `isStrongOverlap` gates it to a strong concrete overlap (a real shared
    // file/seam, not the PRD/config/skill boilerplate or a junk token), and
    // `overlapSurfaced` guards each seam so it is surfaced at most once, never the
    // per-tick "consolidate?" firehose. A weak/false overlap surfaces nothing.
    for (const group of detectCrossRunOverlap(runLog).filter(isStrongOverlap)) {
      if (overlapSurfaced.current.has(group.seam)) continue;
      overlapSurfaced.current.add(group.seam);
      const runs = group.runs
        .map((r) => (r.issueId !== null ? `issue ${String(r.issueId).padStart(2, '0')}` : r.runId))
        .join(', ');
      // A cross-Run consolidation is a SPECULATIVE signal — history only
      // (ADR-0014 keeps the ADR-0012 noise floor out of the conversation).
      surfaceNarrative(
        'cross-run-overlap',
        `overlap:${group.seam}`,
        'synthesize',
        `${group.runs.length} Runs touched ${group.seam} (${runs}) — consider a consolidated pass rather than treating each separately.`,
      );
    }
  }, [runLog, dispatcher, surfaceNarrative]);

  // --- Ground the Dispatcher's status picture in truth (issue 43) -----------
  // The Dispatcher's AUTHORITATIVE model of which issues are open/wip/done/
  // finished-unmerged is reconciled from the SAME live sources the Map uses — the
  // backlog (main-checkout truth), the on-disk `afk/` scan (incl. finished-
  // unmerged, which the backlog can't see because that `done` flip lives on the
  // `afk/` branch), and the Run log (for its unknown captures). It is NOT inferred
  // from the fed Completion-block stream, which could miss/misparse/drop a block
  // and drift the picture (the issue-35 bug: 03/04 reported "still to run" when
  // done). The blocks above remain the QUALITATIVE synthesis; status comes from
  // here. Recomputed as the backlog / scan / Run log change.
  const dispatcherStatusModel = useMemo(
    () => reconcileStatusModel({ backlog, worktreeStates: worktreeRunStates, runLog }),
    [backlog, worktreeRunStates, runLog],
  );

  // Debounce backward status moves before surfacing (issue 49, ADR-0012). Each
  // recompute of `dispatcherStatusModel` above is one reconcile CHECKPOINT: a
  // BACKWARD move (finished/finished-unmerged → open, done → not-done) is held at
  // its prior status until it persists across a further checkpoint, killing the
  // transient mid-reconcile blip; FORWARD moves surface immediately. The advance
  // is guarded so it runs once per distinct reconciled model even though
  // StrictMode double-invokes the memo (advancing twice would falsely "confirm" a
  // one-snapshot regression).
  const debouncedStatusModel = useMemo(() => {
    if (seenReconciled.current === dispatcherStatusModel && debouncedStatusModelRef.current) {
      return debouncedStatusModelRef.current;
    }
    const { model, state } = debounceStatusModel(dispatcherStatusModel, statusDebounce.current);
    statusDebounce.current = state;
    seenReconciled.current = dispatcherStatusModel;
    debouncedStatusModelRef.current = model;
    return model;
  }, [dispatcherStatusModel]);

  // Re-ground the status picture whenever it changes (a Run flipping done, a
  // branch becoming finished-unmerged, an unknown capture landing), guarded by the
  // rendered text so an unchanged model is never re-surfaced. The status refresh
  // is a ROUTINE PASSIVE fact (ADR-0012, issue 48): it renders as a quiet line in
  // the ambient log, NOT typed into the chat. It updates ONE `status-refresh` note
  // in place (rather than appending a new line each change) so the log shows the
  // current "what's left" without accreting a status entry per transition.
  useEffect(() => {
    if ((dispatcher?.sessionId ?? null) === null) return;
    const text = renderStatusModel(debouncedStatusModel);
    if (text === statusRefreshSig.current) return;
    statusRefreshSig.current = text;
    // `relay` is silent → the ambient log (channelForAction === 'log').
    const note = recordActivity('status-refresh', 'relay', oneLineNote(text));
    setDispatcherActivities((prev) => {
      const idx = prev.findIndex((a) => a.id === 'status-refresh');
      if (idx === -1) return [...prev, note];
      const next = [...prev];
      next[idx] = note;
      return next;
    });
  }, [debouncedStatusModel, dispatcher]);

  // --- React to lifecycle events mid-drain (issue 37, ADR-0007) -------------
  // Beyond the Completion-block stream above, the Dispatcher reacts to lightweight
  // terminal lifecycle events — blocked / stranded / needs-attention / hitl-
  // waiting — so it can act (or proactively alert) MID-drain rather than the drain
  // silently stalling. These are STRUCTURED signals derived from truth Mission
  // Control already holds — the captured Completion records (blocked / needs-
  // verification, with their `detail` body from issue 42) and the on-disk `afk/`
  // scan's stranded classification (issue 22) — never raw Pane scroll. The pure
  // `reactToLifecycleEvent` turns each into a plain-language notification (fed
  // through the same submit queue) plus, for blocked/stranded, an approval-gated
  // discard-and-continue proposal (issue 36's gate). CRUCIALLY, when the drain
  // reaches a HITL issue parked awaiting the human (a `hitl: true` / `(HITL)` issue
  // whose block is "Ready for manual verification"), it PROACTIVELY notifies the
  // user, names the issue, and relays its manual-verification steps — so the user
  // isn't left to notice the pause. Reacted-to once per event (guarded by
  // `lifecycleReacted`).
  useEffect(() => {
    const sessionId = dispatcher?.sessionId ?? null;
    if (sessionId === null) return;

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
      // A HITL gate awaiting sign-off stays a BLOCKING-approval prompt → the
      // chat PTY via the authority line (ADR-0011/0012, unchanged by ADR-0014);
      // its delivered park notice also marks the Run as seen by this session,
      // so the on-ask digest (issue 61) doesn't re-list it. Every other alert
      // routes through the narrative table: a BLOCKED park (issue 137) is now a
      // Run-narrative CHAT message (the drain no longer halts on it, so its park
      // is the chat fact — never a silent skip), while stranded / needs-attention
      // stay history-strip lines. Either way it is surfaced once, so a stuck or
      // human-gated drain never stalls silently — and the pump keeps a chat-tier
      // notification queued across Dispatcher session replacement/death until it
      // is really submitted (issue 60), so "surfaced once" never becomes "lost in
      // transit". ADR-0011: none of these widens the blocking gate — the user
      // unsticks a blocked Run and discards a stranded one from the Map's own
      // controls, so no proposal here.
      if (event.kind === 'hitl-waiting') {
        if (surfaceEvent(key, actionForLifecycle(event.kind), reaction.notification)) {
          dispatcherSessionSeen.current.add(event.runId);
        }
      } else {
        surfaceNarrative(
          narrativeKindForLifecycle(event.kind),
          key,
          actionForLifecycle(event.kind),
          reaction.notification,
        );
      }
    }
  }, [runLog, worktreeRunStates, dispatcher, backlog, surfaceEvent, surfaceNarrative]);

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
          // `finished-without-receipt` → a narrative message in the chat
          // (ADR-0014) + the history line. `relay` labels the note only.
          surfaceNarrative(
            narrativeKindForLifecycle(event.kind),
            `${event.kind}:${event.runId}`,
            actionForLifecycle(event.kind),
            reaction.notification,
          );
        }
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runs, runLog, projectPath, runStatusOf, surfaceNarrative]);

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
        // A Receipt/state disagreement is a routine fact → history only
        // (ADR-0014 keeps it below the conversation bar).
        surfaceNarrative('receipt-mismatch', key, 'relay', describeReceiptMismatch(still));
      }, RECEIPT_AUDIT_GRACE_MS);
    }
  }, [runLog, debouncedStatusModel, projectPath, surfaceNarrative]);

  // Write the drain's journal entry (issue 73, ADR-0015): when a drain ends —
  // any stop reason — ONE dated summary lands in the workbench project's
  // `memory/journal/`, built from THIS drain's Run-log delta plus its notable
  // events (adoptions, finished-without-receipt), and auto-committed in main.
  // Once per drain (both stop paths funnel here), after one Receipt grace
  // window — a drain often ends on the `done` flip a beat before the final
  // Run's Receipt is ingested, and the journal should name that Run too.
  // Legacy Projects: no memory dir; the guard makes both halves inert.
  const writeDrainJournalFor = useCallback(
    (reason: string): void => {
      if (projectPath === null || activeProject?.kind !== 'workbench') return;
      const seq = drainSeq.current;
      if (drainJournalSeq.current >= seq) return;
      drainJournalSeq.current = seq;
      const journalPath = projectPath;
      const logBaseline = drainLogBaseline.current;
      const notableBaseline = drainNotableBaseline.current;
      setTimeout(() => {
        // A Project switch mid-window: this journal belongs to the old
        // Project; writing it against the new one would be a lie — skip.
        if (projectPathRef.current !== journalPath) return;
        const records = runLogRef.current.filter((rec) => !logBaseline.has(rec.id));
        const notables = dispatcherActivitiesRef.current
          .filter((a) => !notableBaseline.has(a.id) && isNotableDrainActivity(a.id))
          .map((a) => a.label);
        void window.mc
          .writeDrainJournal({ projectPath: journalPath, reason, records, notables })
          .catch(() => {});
      }, RECEIPT_AUDIT_GRACE_MS);
    },
    [projectPath, activeProject],
  );

  const startDrain = useCallback(
    (chosenCap: number): void => {
      // Refuse to drain onto a mid-merge main (issue 24) — resolve/abort first.
      if (midMerge) {
        setDrainMessage(
          'Cannot drain: main is mid-merge — resolve the conflict or Abort the merge first.',
        );
        return;
      }
      // Drain honesty (issue 90): the Map disables the control when nothing is
      // startable/unblockable, but a click can land in the beat before the
      // watch push re-disables it. Refuse here with the same truthful reason
      // rather than spinning a Dispatcher session up over nothing. (If
      // eligibility vanishes AFTER this guard passes, the plan effect below
      // ends the drain immediately with the normal no-eligible stop fact.)
      const gate = drainAvailability(
        backlog?.issues ?? [],
        runs.filter((r) => runStatusOf(r) === 'running').map((r) => r.target.issueId),
      );
      if (!gate.available) {
        setDrainMessage(`Cannot drain: ${gate.reason}.`);
        return;
      }
      setCap(Math.max(1, Math.floor(chosenCap) || 1));
      setDrainMessage('');
      setDraining(true);
      // Each drain gets its own sequence so its stopped/halted narrative fact
      // (issue 66) carries a stable, deduped delivery key.
      drainSeq.current += 1;
      // Journal baselines (issue 73): what predates this drain is not this
      // drain's story — the entry is built from the delta past these sets.
      drainLogBaseline.current = new Set(runLogRef.current.map((rec) => rec.id));
      drainNotableBaseline.current = new Set(
        dispatcherActivitiesRef.current.map((a) => a.id),
      );
      // Starting a drain spins up the Dispatcher for this Project (ADR-0010):
      // the conversational orchestrator that drives the drain and that you talk
      // to instead of watching every Pane. A single manual Run (startRun) does
      // NOT do this — it stays a bare Pane. Idempotent: one Dispatcher per
      // Project, so re-draining the same Project reuses the live one.
      if (projectPath !== null) {
        // Baseline the session-seen set (issues 61 + 66) when a FRESH Dispatcher
        // is created: records already in the Run log predate this session's seed
        // (a previous drain's persisted blocks), so they are "already given" —
        // live narrative and the digest carry only what reports in from here on.
        // The baseline is kept so a REPLACEMENT session can reset to it and
        // catch up via the digest. A re-drain that reuses the live Dispatcher
        // keeps its bookkeeping intact.
        if (dispatcher === null || dispatcher.target.projectPath !== projectPath) {
          dispatcherDigestBaseline.current = new Set(runLogRef.current.map((rec) => rec.id));
          dispatcherSessionSeen.current = new Set(dispatcherDigestBaseline.current);
          dispatcherHadSession.current = false;
        }
        setDispatcher((cur) =>
          cur && cur.target.projectPath === projectPath
            ? cur
            : {
                target: { projectPath, activePrd: backlog?.activePrd ?? null },
                sessionId: null,
              },
        );
      }
      applyShellEvent({ kind: 'run-started' });
    },
    [midMerge, projectPath, backlog, dispatcher, runs, runStatusOf],
  );

  const stopDrain = useCallback((): void => {
    setDraining(false);
    const message = 'Drain stopped by you — in-flight Runs keep going.';
    setDrainMessage(message);
    // A drain stop is a lifecycle fact worth telling (ADR-0014, issue 66): a
    // message in the Dispatcher conversation, plus the history line.
    surfaceNarrative('drain-stopped', `drain-stopped:${drainSeq.current}`, 'relay', message);
    // A user stop is a drain end like any other (issue 73): journal it.
    writeDrainJournalFor(message);
  }, [surfaceNarrative, writeDrainJournalFor]);

  // Record the Dispatcher session's PTY id once its chat Pane spawns (issue 35),
  // so the ingest effect below can feed each Run's Completion block into it.
  // Also (issue 60) point the pump at the new session — anything still queued
  // from before the previous session died is (re)delivered here — and reset the
  // compose state: a fresh PTY starts with an EMPTY input line, so a mid-compose
  // flag inherited from the old session can never hold the defer gate closed
  // forever (the stuck-compose stall).
  const handleDispatcherSession = useCallback(
    (sessionId: string): void => {
      // A REPLACEMENT session is a brand-new claude conversation that heard
      // none of the narrative delivered to its predecessor (issue 66): reset
      // the session-seen set to the Dispatcher-creation baseline so the on-ask
      // digest (issue 61) catches the new session up on everything this drain
      // produced. Items the pump still redelivers into the new session re-mark
      // themselves as seen when their submit lands (`noteDelivery`), so the
      // digest never repeats them.
      if (dispatcherHadSession.current) {
        dispatcherSessionSeen.current = new Set(dispatcherDigestBaseline.current);
      }
      dispatcherHadSession.current = true;
      setDispatcher((cur) => (cur ? { ...cur, sessionId } : cur));
      dispatcherTyping.current = INITIAL_TYPING_STATE;
      dispatcherPump.attachSession(sessionId);
    },
    [dispatcherPump],
  );

  // The Dispatcher chat PTY died (issue 60, rule 2): detach the pump — its queue
  // is per-Project state, so queued blocking notifications survive and deliver
  // into whatever session attaches next — and drop the stale session id so the
  // feed effects stop treating the dead session as live.
  const handleDispatcherExit = useCallback((): void => {
    setDispatcher((cur) => (cur ? { ...cur, sessionId: null } : cur));
    dispatcherTyping.current = INITIAL_TYPING_STATE;
    dispatcherPump.attachSession(null);
  }, [dispatcherPump]);

  // Dismiss the Dispatcher (ADR-0010): end the orchestrator session and close
  // its chat panel. Unmounting the panel kills the PTY; clearing the fed-set lets
  // a fresh Dispatcher for this Project start ingesting from scratch.
  const dismissDispatcher = useCallback((): void => {
    setDispatcher(null);
    dispatcherFed.current.clear();
    dispatcherSessionSeen.current.clear();
    dispatcherDigestBaseline.current.clear();
    dispatcherHadSession.current = false;
    // Dropping the queue here is safe for blocking items: the fed/reacted sets
    // clear too, so a fresh Dispatcher re-derives and re-enqueues anything (e.g.
    // a still-parked HITL gate) that is still true from the Run log.
    dispatcherPump.reset();
    dispatcherTyping.current = INITIAL_TYPING_STATE;
    setDispatcherActivities([]);
    lifecycleReacted.current.clear();
    discardTargets.current = {};
    overlapSurfaced.current.clear();
    statusRefreshSig.current = null;
    statusDebounce.current = initialStatusDebounceState();
    seenReconciled.current = null;
    debouncedStatusModelRef.current = null;
    autoMergeSig.current = null;
    // Clearing the proposals (above) must also clear the protected-branch guard's
    // bookkeeping (issue 113) — otherwise a solo commit could stay withheld with
    // no visible gate; the fresh Dispatcher re-raises it from a re-fired commit.
    protectedGatedSoloIds.current.clear();
    protectedLandTargets.current = {};
    setSoloProtectedGates([]);
  }, [dispatcherPump]);

  // Drag the divider between the Map and the Dispatcher rail to resize it (issue
  // 44). We capture the width and pointer x at drag start, then follow the
  // pointer via window listeners (so the drag keeps tracking even if the cursor
  // leaves the thin handle). The pure `dispatcherWidthFromPointer` does the math
  // and clamps to the min/max; the chosen width is persisted app-wide on release
  // so it survives closing/reopening the panel and restarts. The chat Pane
  // reflows automatically — its ResizeObserver (issue 12) refits the terminal as
  // the rail's width changes.
  const startDispatcherResize = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault();
      const startClientX = e.clientX;
      const startWidth = dispatcherWidth;
      const onMove = (ev: PointerEvent): void => {
        setDispatcherWidth(
          dispatcherWidthFromPointer({ startWidth, startClientX, clientX: ev.clientX }),
        );
      };
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('is-col-resizing');
        const finalWidth = dispatcherWidthFromPointer({
          startWidth,
          startClientX,
          clientX: ev.clientX,
        });
        try {
          window.localStorage.setItem(DISPATCHER_WIDTH_KEY, String(finalWidth));
        } catch {
          // Persistence is best-effort; the live width still applies this session.
        }
      };
      document.body.classList.add('is-col-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [dispatcherWidth],
  );

  // Keep the App's backlog copy fresh from every Map load/live-change so the
  // Coordinator plans against current disk truth.
  const handleBacklogLoaded = useCallback(
    (loaded: Backlog | null, loadedPath: string): void => {
      setBacklog(loaded);
      setProjectPath(loadedPath);
    },
    [],
  );

  // --- The drain loop, expressed as a pure re-plan ------------------------
  // On any change to the backlog, the tracked Runs, or the cap, ask the Run
  // Coordinator what to do. Startable issues get a fresh Pane; a stop condition
  // ends the drain with its reason. This is reactive (no timer): a Run reaching
  // `done` (disk → backlog push) or its session exiting frees a slot and
  // re-triggers this effect, which auto-starts the next queued Run.
  //
  // Before opening those Panes, isolation is reconciled (ADR-0002): the Git/
  // Worktree Adapter puts a lone Run on `main` and gives each Run its own
  // worktree once 2+ are concurrent, then hands back each Run's cwd — so a
  // parallel Run's Pane spawns inside its worktree, never the shared checkout.
  //
  // This effect no longer re-fires on every ~1.5s poll tick (issue 30): its only
  // status input, `runStatusOf`, now derives from the value-guarded scan
  // (`committedStatusById`), whose identity is stable across no-change ticks — so
  // `applyIsolation` runs when the backlog / tracked Runs / cap actually change,
  // not once per scan. It still early-returns when nothing new is startable, so a
  // steady-state drain issues no reconcile at all.
  useEffect(() => {
    if (!draining || !backlog || projectPath === null) return;

    // Issues whose `repo:` key doesn't resolve are excluded from the plan and
    // must not stall their siblings (issue 72), but for two DIFFERENT reasons
    // (issue 96, ADR-0017):
    //   - `planned` — the repo is declared but not yet created (planned-first).
    //     The issue is HELD, not errored: once its creating issue makes the
    //     repo, it resolves and runs. Surfaced once as a plain hold note.
    //   - `unknownKey` — the key names neither an existing nor a declared repo
    //     (a typo/misconfig). Flagged distinctly as an error, as before.
    // Either way the issue is dropped from `plannable` (its dependents stay
    // blocked naturally — a missing dependency is an unmet dependency).
    const plannable = backlog.issues.filter((issue) => {
      const resolution = issueRepoResolutions.get(issue.id);
      if (resolution === undefined || resolution.ok) return true;
      if (resolution.reason === 'planned') {
        logNote(
          `repo-planned:${issue.id}:${resolution.repoKey}`,
          'relay',
          plannedRepoHoldNote(issue.id, resolution.repoKey),
        );
      } else {
        logNote(
          `repo-unresolved:${issue.id}:${resolution.unknownKey}`,
          'relay',
          unknownRepoKeyNote(
            issue.id,
            resolution.unknownKey,
            Object.keys(activeProject?.repos ?? {}),
          ),
        );
      }
      return false;
    });

    // Each Run carries the outcome its latest Receipt DECLARED (or null when
    // none exists) so the Coordinator can tell a parked HITL Run — a success
    // the drain continues past — from a genuinely blocked one that halts it
    // (`isParkedHitl`, issue 64). Declared state only, never prose heuristics.
    const activeRuns: ActiveRun[] = runs.map((r) => ({
      issueId: r.target.issueId,
      status: runStatusOf(r),
      receiptOutcome: latestReceiptOutcomeFor(runLog, r.target.issueId),
      // A Run started by an EARLIER drain generation is a leftover phantom
      // (issue 132): a `claude` Pane still lingering alive from yesterday's
      // drain that never flipped `done` or wrote a Receipt, so run-state reads
      // it `running` forever. It must not occupy a slot in — nor halt — this
      // fresh drain (its issue is still guarded against re-start). A manual Run
      // (drainGeneration null) or one this drain started counts as before.
      leftover: r.drainGeneration !== null && r.drainGeneration < drainSeq.current,
    }));
    // A dependency's frontmatter can read `done` while its `afk/` branch hasn't
    // landed on main yet (issue 147, ADR-0021) — `finishedUnmergedIds` is the
    // on-disk fact that makes the coordinator hold such a dependent as
    // "waiting on merge of NN" instead of starting it off a main still missing
    // its own prerequisite.
    const plan = planDrain({
      issues: plannable,
      maxConcurrent: cap,
      activeRuns,
      midMerge,
      finishedUnmergedIds,
    });

    if (plan.drain.stop) {
      setDraining(false);
      setDrainMessage(plan.drain.message);
      // A drain halt/finish is a lifecycle fact worth telling (ADR-0014, issue
      // 66): a message in the Dispatcher conversation (why it ended — a blocked
      // Run, nothing eligible, a mid-merge main), plus the history line.
      surfaceNarrative('drain-halted', `drain-halted:${drainSeq.current}`, 'relay', plan.drain.message);
      // The drain ended (issue 73): one journal entry into the workbench
      // memory, whatever the stop reason.
      writeDrainJournalFor(plan.drain.message);
      return;
    }

    const have = new Set(runs.map((r) => r.target.issueId));
    const startableIssues = plan.startable
      .filter((id) => !have.has(id))
      .map((id) => backlog.issues.find((i) => i.id === id))
      .filter((i): i is NonNullable<typeof i> => Boolean(i));

    if (startableIssues.length === 0) return;

    // The set of Runs that need isolation = the tracked Runs that still need a
    // worktree — live, or finished-unmerged — plus the ones about to start, each
    // carrying its own target repo (issue 72): isolation keys on concurrency PER
    // REPO, so two startable issues in different repos each stay solo in their
    // own repo while 2+ in one repo get worktrees. Solo-chaining is retired
    // (issue 147, ADR-0021): every startable issue isolates purely by
    // concurrency, in a worktree like any other — a dependent's dependency
    // reaches main via the auto-merge lane, never a shared solo commit.
    // Terminal SOLO Runs (finished/blocked/parked/stopped on `main`) lingering
    // on screen are scoped OUT via `needsIsolation` (issue 134): feeding them in
    // used to inflate concurrency and hand a spurious worktree cut that kept
    // `.afk-parallel` stuck on across drain rounds. This is the same set the
    // manual "▶ Run" path uses.
    const isolationRuns: IsolationRun[] = [
      ...runs.filter(needsIsolation).map((r) => ({
        issueId: r.target.issueId,
        slug: slugOf(r.target.issueFileName),
        repoPath: repoForIssueId(r.target.issueId),
      })),
      ...startableIssues.map((i) => ({
        issueId: i.id,
        slug: slugOf(i.fileName),
        repoPath: repoForIssueId(i.id),
      })),
    ];

    let cancelled = false;

    const addRuns = (cwdOf: (issueId: number) => string): void => {
      const additions = startableIssues.map((issue) => {
        // The declared drain-worker tier (issue 154): the issue's `model:`
        // override, else the project CONFIG `worker_model` default, else sonnet
        // — so unattended draining runs cheap instead of inheriting the
        // expensive interactive default.
        const tier = resolveWorkerModel({
          configDefault: backlog.workerModel,
          issueModel: issue.model,
        });
        return newRun(
          {
            issueId: issue.id,
            issueFileName: issue.fileName,
            issueTitle: issue.title,
            projectPath: cwdOf(issue.id),
            // Workbench Runs carry the explicit workbench paths in the spawn
            // prompt (issue 72); null for a legacy Project.
            workbench: workbenchPathsForRun,
            // From this slice on, drain Runs execute HEADLESS (issue 139,
            // ADR-0001 amendment): spawned as `claude -p --output-format
            // stream-json` and watched via a read-only Feed, never a Pane. A
            // manual "▶ Run" (startRun) leaves this unset → its interactive Pane.
            headless: true,
            // Set ONLY here (the drain path); the manual "▶ Run" and Quick-fix
            // paths never set model/effort, so they stay on the interactive
            // defaults.
            model: tier,
            // The declared drain-worker effort (issue 155): the issue's
            // `effort:` override, else the CONFIG `worker_effort` override, else
            // DERIVED from the resolved tier (haiku→low, sonnet→medium,
            // opus/fable→high). A second cost lever beside the model, so a
            // mechanical issue doesn't burn deliberate reasoning tokens.
            effort: resolveWorkerEffort({
              tier,
              configDefault: backlog.workerEffort,
              issueEffort: issue.effort,
            }),
          },
          // Stamp the Run with THIS drain's generation (issue 132) so a later
          // drain can tell it apart from a leftover Pane it should not count.
          drainSeq.current,
        );
      });
      setRuns((prev) => {
        const present = new Set(prev.map((r) => r.target.issueId));
        const fresh = additions.filter((a) => !present.has(a.target.issueId));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      setFocusedId((cur) => cur ?? additions[0]?.target.issueId ?? cur);
    };

    void window.mc
      .applyIsolation({ projectPath, runs: isolationRuns })
      .then((result) => {
        if (cancelled) return;
        // (`Map` the identifier is the Map view component here, so use a record.)
        const cwdById: Record<number, string> = {};
        for (const p of result.placements) cwdById[p.issueId] = p.cwd;
        // Newly-started Runs spawn in their resolved cwd (a worktree in parallel
        // mode; the issue's own target repo when solo). Already-live Panes keep
        // the cwd they spawned in — a running PTY can't be re-parented; that
        // live solo→parallel re-parent is left to the batch QA walkthrough /
        // Merge slice.
        addRuns((id) => cwdById[id] ?? repoForIssueId(id));
      })
      .catch(() => {
        if (cancelled) return;
        // Isolation failed (a git worktree error, a disk error, a partial
        // reconcile that threw mid-apply). Falling back to the checkout is safe
        // ONLY for a lone Run per repo; spawning startable Runs on a shared
        // checkout while others are live in the SAME repo is the concurrent-main
        // collision isolation exists to prevent (issue 28). Count, per repo, the
        // Runs that would end up live on that checkout: the startable ones
        // (all fall back to their repo checkout) plus any Run already running
        // solo there (an isolated Run keeps its worktree, so it doesn't count).
        // If ANY repo would hold 2+, STOP the drain and surface the error.
        const liveOnCheckout = new globalThis.Map<string, number>();
        for (const r of runs) {
          if (runStatusOf(r) !== 'running' || isIsolated(r)) continue;
          const repo = repoForIssueId(r.target.issueId);
          liveOnCheckout.set(repo, (liveOnCheckout.get(repo) ?? 0) + 1);
        }
        for (const issue of startableIssues) {
          const repo = repoForIssueId(issue.id);
          liveOnCheckout.set(repo, (liveOnCheckout.get(repo) ?? 0) + 1);
        }
        const safe = [...liveOnCheckout.values()].every((count) => canFallBackToMain(count));
        if (safe) {
          addRuns((id) => repoForIssueId(id));
        } else {
          setDraining(false);
          const message =
            'Isolation failed while starting parallel Runs — stopped to avoid ' +
            'running multiple agents on main. Resolve the worktree/git error, ' +
            'then start the drain again.';
          setDrainMessage(message);
          // A halted drain is narrative (ADR-0014, issue 66) → the conversation.
          surfaceNarrative(
            'drain-halted',
            `drain-halted:isolation:${drainSeq.current}`,
            'relay',
            message,
          );
        }
      });

    return () => {
      cancelled = true;
    };
    // `runLog` is a dependency so a Receipt that lands a beat after its session
    // exits re-plans the drain with the park now visible (issue 64).
  }, [draining, backlog, runs, cap, projectPath, midMerge, runStatusOf, isIsolated, needsIsolation, runLog, surfaceNarrative, writeDrainJournalFor, issueRepoResolutions, repoForIssueId, workbenchPathsForRun, activeProject, logNote, finishedUnmergedIds]);

  // --- Merge readiness (issue 08, ADR-0002; issue 16) ---------------------
  // Whether a human-triggered Merge is offered — and which branches it targets —
  // is derived from the ON-DISK `afk/` state, not the in-memory tracked Runs, so
  // the affordance survives closing every Pane (issue 16). It appears once every
  // isolated Run's branch is committed-done (issue 15) and none is still in
  // flight, and never triggers on its own (ADR-0002).
  const mergePlan = mergeReadinessOnDisk(activeScan.branches, liveRunIssueIds);

  // The single merge invocation, shared by the manual Map button (`auto=false`)
  // and the Dispatcher's auto-proceed path (`auto=true`, issue 46). The git work,
  // the merge-status display, and the on-disk/tracking cleanup are IDENTICAL in
  // both modes — so the manual button behaves exactly as before. The only thing
  // `auto` adds is the Dispatcher posture on the RESULT: a clean merge records a
  // passive `merge` note and relays its summary; a conflict / preflight failure
  // records a blocking `merge-conflict` proposal and surfaces the reason (never
  // auto-resolved). The pure `decideDispatcherMerge` makes that auto-vs-gate call.
  const runMergeCore = useCallback((auto: boolean, confirmProtected = false): void => {
    if (projectPath === null || merging) return;
    // Merge stays PER REPO (issue 72): one afk-merge invocation integrates one
    // repo's branches. Group the mergeable set by the repo each branch lives
    // in (from the scan facts) and merge the FIRST group this invocation; a
    // remaining group re-derives as ready once the scan refreshes, so the next
    // click / auto-proceed round integrates it — sequential by construction.
    // A legacy Project has one repo, so the "first group" is the whole set,
    // byte-identical to before.
    const repoOf = (slug: string): string =>
      activeScan.branches.find((b) => b.slug === slug)?.repoPath ?? '';
    const firstRepo = mergePlan.mergeable.length > 0 ? repoOf(mergePlan.mergeable[0].slug) : '';
    const candidates = mergePlan.mergeable.filter((c) => repoOf(c.slug) === firstRepo);
    if (candidates.length === 0) {
      // Triggered with nothing mergeable on disk (e.g. stale in-memory
      // readiness after the branches were removed): say so plainly rather than
      // silently doing nothing or later showing "could not run".
      setMergeDisplay(emptyMergeDisplay());
      return;
    }
    const slugs = candidates.map((c) => c.slug);
    const mergedIds = new Set(candidates.map((c) => c.issueId));
    // Stable per-mergeable-set id so a re-render can't duplicate the note/gate.
    const sig = [...slugs].sort().join(',');

    setMerging(true);
    setMergeDisplay(pendingMergeDisplay(slugs.length));
    void window.mc
      .mergeRuns({
        projectPath,
        slugs,
        repoPath: firstRepo === '' ? undefined : firstRepo,
        confirmProtectedLand: confirmProtected,
      })
      .then((result) => {
        setMergeDisplay(mergeResultDisplay(result));
        // Protected-branch withhold (issue 113): the target is a protected branch
        // (`main`/`master`) and the human hasn't confirmed, so NOTHING landed.
        // Raise the blocking "big warning" gate (approve re-runs with confirmation)
        // and STOP — do not classify this as a conflict/preflight failure or run
        // the merged-cleanup below. Applies to the autonomous drain merge AND the
        // user-initiated Merge (both flow through here).
        if (result.protectedBranch && !confirmProtected) {
          const branch = result.protectedBranch;
          const pid = `protected-branch-land:merge:${sig}`;
          protectedLandTargets.current[pid] = { kind: 'merge', auto };
          setDispatcherActivities((prev) =>
            prev.some((a) => a.id === pid)
              ? prev
              : [
                  ...prev,
                  recordActivity(pid, 'protected-branch-land', protectedLandWarning(branch)),
                ],
          );
          surfaceEvent(pid, 'protected-branch-land', protectedLandWarning(branch));
          return;
        }
        if (auto) {
          // A stray-Receipt adoption (issue 62) is a repair MC did on its own:
          // it auto-committed known artifacts (dirty files under
          // `issues/completions/` on main) so the preflight could proceed.
          // A drain fact worth telling (ADR-0014, issue 66) — a message in the
          // Dispatcher conversation, plus the history line; unknown dirt still
          // halts below.
          if (result.adopted !== undefined && result.adopted.length > 0) {
            surfaceNarrative(
              'strays-adopted',
              `receipt-adopt:${sig}:${result.adopted.join(',')}`,
              'receipt-adopt',
              `Adopted stray Receipt(s) on main: ${result.adopted.join(', ')}`,
            );
          }
          // Dispatcher path only (ADR-0011): classify the completed merge into an
          // auto-proceed passive note vs a conflict/failure blocking gate.
          const decision = decideDispatcherMerge(result);
          if (decision.kind === 'auto') {
            // A CLEAN merge is a routine passive fact ("merged 05 clean") →
            // ambient log, carrying its own summary text; never typed into the
            // chat (ADR-0012, issue 48). `merge` is passive → channelForAction 'log'.
            logNote(`merge:${sig}`, 'merge', decision.note);
          } else if (decision.kind === 'gate') {
            // A REAL CONFLICT blocks: record the pending proposal (the panel's
            // approve/reject) and, because it is a blocking-approval prompt,
            // ALSO surface the reason in the chat via the pump — which holds it
            // queued until a Dispatcher session can really receive it (issue 60),
            // so a gate raised during session churn is never silently lost.
            setDispatcherActivities((prev) =>
              prev.some((a) => a.id === `merge-conflict:${sig}`)
                ? prev
                : [...prev, recordActivity(`merge-conflict:${sig}`, 'merge-conflict')],
            );
            surfaceEvent(`merge-conflict:${sig}`, 'merge-conflict', decision.reason);
          } else if (decision.kind === 'halt') {
            // A PREFLIGHT/tool failure is NOT a conflict and NOT approvable
            // (issue 59): an approval could only retry into the same dirty tree
            // and fail identically. Surface its truthful reason (the offending
            // paths) as its own passive note; once the tree is cleaned up (by
            // the user, or by MC committing a straggler Receipt), a retry — the
            // manual Merge button, or the next auto attempt — passes.
            logNote(`merge-preflight:${sig}`, 'merge-preflight', decision.reason);
          }
        }
        if (result.ok) {
          // Optimistically drop the merged slugs from the on-disk scan the
          // instant the merge succeeds, so `mergePlan` recomputes to not-ready
          // synchronously — before `merging` resets in `.finally` and re-enables
          // the button. Without this the scan keeps listing the now-deleted
          // branches until the next ~1.5s poll, so a rapid second click would
          // fire a merge at branches that no longer exist and surface an error
          // contradicting the success just shown (issue 29). The next real scan
          // confirms the same truth, so this is a safe optimistic prefix of it.
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
        }
      })
      .catch((err: unknown) => {
        setMergeDisplay(
          mergeThrewDisplay(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setMerging(false));
  }, [projectPath, merging, mergePlan, activeScan, logNote, surfaceEvent, surfaceNarrative]);

  // The manual Map Merge button — the unchanged, human-triggered path (ADR-0002).
  const runMerge = useCallback((): void => runMergeCore(false), [runMergeCore]);

  // --- Dispatcher auto-merge (issue 46, ADR-0011 refining ADR-0002) --------
  // Under a Dispatcher-driven drain a CLEAN merge of finished parallel work
  // AUTO-PROCEEDS — the Dispatcher invokes it on its own and leaves a passive
  // note ("merged 05 clean") — while a CONFLICT or preflight failure BLOCKS for a
  // one-click approval (the `merge-conflict` item on issue 45's blocking list) and
  // surfaces the reason (issues 17/23/24), never auto-resolving. The pure
  // `shouldAutoMerge` decides WHEN to fire (a live Dispatcher session, mergeable
  // `afk/` branches on disk, `main` not mid-merge, no merge already in flight, and
  // this mergeable set not already auto-attempted); `decideDispatcherMerge` (in
  // the shared core's result handler) makes the auto-note-vs-conflict-gate call.
  // `autoMergeSig` records the attempted set so a persistent preflight failure —
  // which leaves the branch set unchanged — can't loop the effect (a clean merge
  // drops the branches and a conflict sets `midMerge`, so those self-guard).
  useEffect(() => {
    const sig = mergePlan.mergeable.map((c) => c.slug).sort().join(',');
    const go = shouldAutoMerge({
      dispatcherActive: (dispatcher?.sessionId ?? null) !== null,
      mergeableCount: mergePlan.mergeable.length,
      midMerge,
      merging,
      alreadyAttempted: autoMergeSig.current === sig,
    });
    if (!go) return;
    autoMergeSig.current = sig;
    runMergeCore(true);
  }, [mergePlan, dispatcher, midMerge, merging, runMergeCore]);

  // Approve a pending proposal: mark it approved, then EXECUTE the action (the
  // gate's whole point — nothing ran until this click). Execution is dispatched
  // by the action; a Merge runs the existing merge path, an abort stops the
  // drain. Non-executable proposals are simply recorded as approved.
  const approveProposal = useCallback(
    (id: string): void => {
      let action: DispatcherActivity['action'] | null = null;
      setDispatcherActivities((prev) =>
        prev.map((a) => {
          if (a.id !== id || a.status !== 'pending') return a;
          action = a.action;
          return resolveActivity(a, 'approved');
        }),
      );
      if (action === 'merge') runMerge();
      else if (action === 'abort-drain') stopDrain();
      else if (action === 'discard-and-continue') {
        // Execute issue 22's discard for the stranded/blocked Run's worktree, if
        // it has one; a blocked solo Run has no worktree, so approving simply
        // clears the gate and the drain continues.
        const target = discardTargets.current[id];
        if (target) discardRun(target.issueId, target.slug);
      } else if (action === 'protected-branch-land') {
        // The human clicked through the "big warning" (issue 113): re-execute the
        // withheld landing WITH confirmation. A merge re-runs `runMergeCore` (same
        // auto posture); a solo commit re-fires that Run's `main`-commit — after
        // clearing its gated marker so the commit effect stops skipping it.
        const target = protectedLandTargets.current[id];
        if (target?.kind === 'merge') {
          // Re-run the withheld merge WITH confirmation. The direct call handles
          // it; the auto-merge effect stays guarded (a clean merge drops the
          // branches; a conflict sets midMerge — both self-guard against a re-fire).
          runMergeCore(target.auto, true);
        } else if (target?.kind === 'solo') {
          protectedGatedSoloIds.current.delete(target.issueId);
          const run = runs.find((r) => r.target.issueId === target.issueId);
          if (run) commitSoloRun(run, target.nextPhase, true);
        }
      }
    },
    [runMerge, stopDrain, discardRun, runMergeCore, commitSoloRun, runs],
  );

  // Reject a pending proposal: drop it (mark rejected) and DO NOT execute — the
  // Dispatcher continues without the scope change.
  const rejectProposal = useCallback((id: string): void => {
    setDispatcherActivities((prev) =>
      prev.map((a) => (a.id === id && a.status === 'pending' ? resolveActivity(a, 'rejected') : a)),
    );
  }, []);

  // Abort an in-progress merge left on `main` by a partial conflict (issue 24):
  // `git merge --abort` back to a clean `main` (already-merged slugs stay merged),
  // so a non-git user isn't stranded and a new drain/Run is unblocked. Refreshes
  // the scan immediately so `midMerge` clears without waiting for the next poll.
  const runAbortMerge = useCallback((): void => {
    if (projectPath === null || aborting) return;
    setAborting(true);
    void window.mc
      .abortMerge({ projectPath })
      .then((res) => {
        if (!res.ok) {
          window.alert(`Could not abort the merge: ${res.error ?? 'unknown error'}`);
          return;
        }
        // The conflicted merge is gone; drop the stale conflict panel and re-scan.
        setMergeDisplay(null);
        void window.mc
          .scanAfkRuns({ projectPath })
          .then((r) => setAfkScan({ projectPath, branches: r.branches, midMerge: r.midMerge, previews: r.previews, previewNote: r.previewNote }))
          .catch(() => {
            // The 1.5s poll will pick up the cleared mid-merge state regardless.
          });
      })
      .catch((err: unknown) => {
        window.alert(
          `Could not abort the merge: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => setAborting(false));
  }, [projectPath, aborting]);

  // Adaptive tiled grid: the pure layout function decides the shape from the
  // live Run count (issue 12) — plus the Just-talk Pane when one is live
  // (issue 81), which tiles beside the Runs like any other session. A
  // maximized tile overrides it with a single cell.
  const shape = gridShape(runs.length + (talk !== null ? 1 : 0));
  const maximizedRun = runs.find((r) => r.target.issueId === maximizedId) ?? null;

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

  // Open-here-or-new-Window choice (issue 121): this Window already has a
  // Project open and the user picked a DIFFERENT one from the home grid
  // (with nothing running — a live runner takes the stronger interrupt
  // dialog below instead). Rather than silently switching this Window,
  // offer the same choice the project bar's buttons give — so the user can
  // open the other Project alongside this one without touching the top bar.
  // Open here switches this Window; Open in new Window leaves it untouched;
  // Cancel stays put. Issue 124 moves this onto the Dialog primitive too (the
  // tracer replaced only the interrupt guard; the shell rebuild folds the last
  // hand-rolled overlay in), so every modal in the app is now one Radix Dialog
  // with the same overlay/focus-trap/Escape behavior.
  const openChoiceDialog = (
    <Dialog
      open={pendingOpenChoice !== null}
      onOpenChange={(open) => {
        if (!open) setPendingOpenChoice(null);
      }}
    >
      {pendingOpenChoice !== null && (
        <DialogContent>
          <DialogTitle>Open {pendingOpenChoice.label}</DialogTitle>
          <DialogDescription>
            <strong>
              {projects.find((p) => p.key === activeProjectKey)?.label ?? 'This project'}
            </strong>{' '}
            is open in this window. Open <strong>{pendingOpenChoice.label}</strong> here instead,
            or in a new window so you can work on both at once?
          </DialogDescription>
          <DialogActions>
            <Button
              variant="primary"
              onClick={() => {
                void openProjectHere(pendingOpenChoice.path);
                setPendingOpenChoice(null);
              }}
              title="Switch this window to the picked project"
            >
              Open here
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void window.mc.openWindow({ path: pendingOpenChoice.path });
                setPendingOpenChoice(null);
              }}
              title="Open the picked project in a new window; this window stays put"
            >
              Open in new window
            </Button>
            <Button
              variant="ghost"
              className="ui-btn--end"
              onClick={() => setPendingOpenChoice(null)}
            >
              Cancel
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );

  // Interrupt confirmation (issue 114): a runner is fixing an issue in the
  // Project this Window has open, and the user picked a different one in the
  // switcher or the Launcher's Continue list. Rather than silently killing
  // the live Run, offer to open the other Project in a NEW Window — which
  // leaves this one (and its runner) untouched. "Switch here anyway" performs
  // the interrupting change; Cancel stays put (the controlled
  // switcher/Launcher snap back on their own). The redesign's tracer (issue
  // 123): the first modal on the Dialog primitive — Radix supplies the
  // portal, overlay, focus trap, and Escape/outside-click dismissal (both
  // land on Cancel); the Atlas tokens supply every visual.
  const interruptDialog = (
    <Dialog
      open={pendingProjectChange !== null}
      onOpenChange={(open) => {
        if (!open) setPendingProjectChange(null);
      }}
    >
      {pendingProjectChange !== null && (
        <DialogContent>
          <DialogTitle>A runner is working here</DialogTitle>
          <DialogDescription>
            <strong>
              {projects.find((p) => p.key === activeProjectKey)?.label ?? 'This project'}
            </strong>{' '}
            has a runner fixing an issue. Opening{' '}
            <strong>{pendingProjectChange.label}</strong> in this window would interrupt it. Open{' '}
            <strong>{pendingProjectChange.label}</strong> in a new window instead so the running
            work keeps going?
          </DialogDescription>
          <DialogActions>
            <Button
              variant="primary"
              onClick={() => {
                void window.mc.openWindow({ path: pendingProjectChange.path });
                setPendingProjectChange(null);
              }}
              title="Open the other project in a new window; this window's runner keeps going"
            >
              Open in new window
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                pendingProjectChange.proceed();
                setPendingProjectChange(null);
              }}
              title="Switch this window now — the running work here is interrupted"
            >
              Switch here anyway
            </Button>
            <Button
              variant="ghost"
              className="ui-btn--end"
              onClick={() => setPendingProjectChange(null)}
            >
              Cancel
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
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
            onRun={startRun}
            onBacklogLoaded={handleBacklogLoaded}
            runLog={runLog}
            activeRunIssueIds={activeRunIssueIds}
            worktreeRunningIds={worktreeRunningIds}
            finishedUnmergedIds={finishedUnmergedIds}
            strandedIds={strandedIds}
            commitFailedIds={commitFailedIds}
            onDiscard={(slug, issueId) => discardRun(issueId, slug)}
            onDrain={startDrain}
            onStopDrain={stopDrain}
            draining={draining}
            drainMessage={drainMessage}
            cap={cap}
            onCapChange={setCap}
            mergeReady={mergePlan.ready}
            mergeCount={mergePlan.mergeable.length}
            onMerge={runMerge}
            merging={merging}
            mergeDisplay={mergeDisplay}
            midMerge={midMerge}
            onAbortMerge={runAbortMerge}
            aborting={aborting}
            previews={activeScan.previews}
            previewNote={activeScan.previewNote}
            focusIssueId={inboxFocus?.issueId ?? null}
            focusSeq={inboxFocusSeq}
            plannedIssueIds={plannedIssueIds}
            plannedRepos={plannedRepos}
            startProject={mapStartProject}
            onGrillFeature={(p) => void startPlanning(p)}
            onQuickFixRunNow={(p, issue) => void runQuickFixNow(p, issue)}
          />
          </div>
          {/* The Dispatcher chat panel beside the Map (ADR-0010): present once a
              drain has started this Project. Talk to the orchestrator here
              instead of watching every worker Pane; ask "what's left?" and it
              answers from the Completion blocks / Run log. Dismissable. */}
          {dispatcher && (
            <>
              {/* Draggable divider between the Map and the Dispatcher rail
                  (issue 44): drag to resize; the chat Pane reflows to fit. */}
              <div
                className="dispatcher-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the Dispatcher panel"
                title="Drag to resize the Dispatcher panel"
                onPointerDown={startDispatcherResize}
              />
              <DispatcherPanel
                target={dispatcher.target}
                onSession={handleDispatcherSession}
                onInput={handleDispatcherInput}
                onExit={handleDispatcherExit}
                onDismiss={dismissDispatcher}
                ingestedCount={runLog.filter((r) => r.outcome !== 'unknown').length}
                activities={dispatcherActivities}
                onApprove={approveProposal}
                onReject={rejectProposal}
                width={dispatcherWidth}
              />
            </>
          )}
        </div>

        {/* Every tracked Run's Pane stays mounted so its session persists; the
            adaptive grid (issue 12) tiles them so all live Runs are visible at
            once instead of hidden behind tabs. Maximizing a tile collapses the
            grid to one cell and hides (but keeps mounted) the others. A plain
            shell Pane (issue 01) shows when no Run is tracked. */}
        {(runs.length > 0 || talk !== null) && (
          <div
            className={`app__grid${shape.scroll ? ' app__grid--scroll' : ''}`}
            style={{
              display: view === 'pane' ? 'grid' : 'none',
              gridTemplateColumns: maximizedRun
                ? '1fr'
                : `repeat(${shape.cols}, minmax(0, 1fr))`,
              gridTemplateRows:
                maximizedRun || shape.scroll
                  ? undefined
                  : `repeat(${shape.rows}, minmax(0, 1fr))`,
            }}
          >
            {runs.map((r) => {
              const status = runStatusOf(r);
              const id = r.target.issueId;
              const slug = slugOf(r.target.issueFileName);
              // Take-over affordance (issue 144): a live headless Run offers
              // "Take over" (grab it mid-flight as a Pane); a finished one offers
              // "Resume" (reopen the session post-mortem to interrogate it). Both
              // need a captured claude session id — null until the init event
              // lands — and only apply to a headless (Feed) Run.
              const takeover = takeoverKindFor(status, r.target.headless, r.claudeSessionId);
              // The header shows the issue slug WITHOUT its numeric prefix (the
              // number is already the "Run NN" / issue-id cue); `slug` itself
              // keeps the prefix because it names the afk/<slug> branch below.
              const descriptor = slug.replace(/^\d+-/, '');
              const isStranded = strandedIds.includes(id);
              const isCommitFailed = commitFailedIds.includes(id);
              const isFinishedUnmerged =
                (status === 'finished' && isIsolated(r)) || finishedUnmergedIds.includes(id);
              // Any isolated Run whose worktree/branch still holds work — finished-
              // but-unmerged (committed), stranded, or commit-failed (uncommitted) —
              // has work that dismissing would hide, so warn first (issue 22, corr).
              // Previously only `finished` warned. Cross-checks the on-disk scan so a
              // Run whose state landed off-screen still triggers it.
              const worktreeWork = isFinishedUnmerged || isStranded || isCommitFailed;
              // Stranded / commit-failed Runs can never merge as-is: offer to
              // discard (force-remove the worktree + delete the branch) so the
              // batch can proceed (issue 22).
              const discardable = isStranded || isCommitFailed;
              const commitError = worktreeCommitErrors[id] ?? null;
              const requestDismiss = (): void => {
                const message = isFinishedUnmerged
                  ? `Issue ${String(id).padStart(2, '0')} has finished work on branch afk/${slug} ` +
                    `that hasn't been merged into main yet.\n\nDismiss it anyway? The branch stays ` +
                    `on disk and you can still Merge it from the Map.`
                  : `Issue ${String(id).padStart(2, '0')} has unmerged work in its worktree on ` +
                    `branch afk/${slug}.\n\nDismiss it anyway? Dismissing only hides it here — the ` +
                    `worktree stays on disk. Use Discard to remove the worktree and branch.`;
                if (worktreeWork && !window.confirm(message)) return;
                dismissRun(id);
              };
              const requestDiscard = (): void => {
                if (
                  window.confirm(
                    `Discard issue ${String(id).padStart(2, '0')}'s worktree and branch afk/${slug}?` +
                      `\n\nThis force-removes the worktree (uncommitted work is lost) and deletes ` +
                      `the branch. Use this to clear a blocked/stopped/commit-failed Run so the ` +
                      `batch can proceed.`,
                  )
                ) {
                  discardRun(id, slug);
                }
              };
              const isMax = maximizedRun?.target.issueId === r.target.issueId;
              const hidden = maximizedRun !== null && !isMax;
              return (
                <div
                  key={r.target.issueId}
                  className={`app__tile${isMax ? ' app__tile--max' : ''}`}
                  style={{ display: hidden ? 'none' : 'flex' }}
                >
                  <div
                    className="app__tile-head"
                    onClick={() => toggleMaximize(r.target.issueId)}
                    title={r.target.issueTitle}
                  >
                    <span
                      className={`app__tile-dot app__tile-dot--${dotTone(status)}`}
                      title={status}
                      aria-label={`Run status: ${status}`}
                    />
                    <span className="app__tile-run">Run {id}</span>
                    <span className="app__tile-id">{id}</span>
                    <span className="app__tile-sep">·</span>
                    <span className="app__tile-slug">{descriptor}</span>
                    {isCommitFailed && (
                      <span
                        className="run-status run-status--commit-failed"
                        title={
                          commitError
                            ? `Auto-commit failed: ${commitError}`
                            : 'The Run finished but its work could not be committed to the afk/ branch'
                        }
                      >
                        commit failed
                      </span>
                    )}
                    {isStranded && (
                      <span
                        className="run-status run-status--stranded"
                        title="This Run ended without committing done; its worktree is stranded"
                      >
                        stranded
                      </span>
                    )}
                    <span className="app__tile-controls">
                      {status === 'running' ? (
                        <>
                          {takeover === 'live' && (
                            <button
                              className="run-takeover run-takeover--tile"
                              title="Kill this headless Run and take over its session in an interactive Pane (same working directory)"
                              onClick={(e) => {
                                e.stopPropagation();
                                takeOverRun(r.target.issueId);
                              }}
                            >
                              Take over
                            </button>
                          )}
                          <button
                            className="run-stop run-stop--tile"
                            onClick={(e) => {
                              e.stopPropagation();
                              stopRun(r.target.issueId);
                            }}
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <>
                          {takeover === 'post-mortem' && (
                            <button
                              className="run-takeover run-takeover--tile"
                              title="Reopen this finished Run's session in an interactive Pane to interrogate it (no new Run)"
                              onClick={(e) => {
                                e.stopPropagation();
                                takeOverRun(r.target.issueId);
                              }}
                            >
                              Resume
                            </button>
                          )}
                          {discardable && (
                            <button
                              className="run-discard run-discard--tile"
                              title="Discard this Run's worktree and afk/ branch (force remove)"
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDiscard();
                              }}
                            >
                              Discard
                            </button>
                          )}
                          <button
                            className="app__tile-dismiss"
                            title={
                              worktreeWork
                                ? 'Dismiss this Run (its worktree/branch still has unmerged work)'
                                : 'Dismiss this finished Run'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              requestDismiss();
                            }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                      <button
                        className="app__tile-max"
                        title={isMax ? 'Restore the grid' : 'Maximize this tile'}
                        aria-label={isMax ? 'Restore the grid' : 'Maximize this tile'}
                        aria-pressed={isMax}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMaximize(r.target.issueId);
                        }}
                      >
                        <MaximizeIcon maximized={isMax} />
                      </button>
                    </span>
                  </div>
                  {r.target.headless ? (
                    // A drain Run is headless (issue 139): a read-only Feed strip
                    // (status + elapsed), not a terminal — there is no input to
                    // type into. The claude session id it captures is persisted
                    // on the Run for resume/take-over.
                    <RunFeed
                      run={r.target}
                      status={status}
                      stopSignal={r.stopSignal}
                      onSession={(sid) => handleRunSession(r.target.issueId, sid)}
                      onClaudeSession={(sid) => handleRunClaudeSession(r.target.issueId, sid)}
                      onStatusChange={r.target.issueId === focusedId ? setPaneStatus : undefined}
                      onExit={() => handleRunExit(r.target.issueId)}
                    />
                  ) : (
                    <Pane
                      run={r.target}
                      stopSignal={r.stopSignal}
                      onStatusChange={r.target.issueId === focusedId ? setPaneStatus : undefined}
                      onExit={() => handleRunExit(r.target.issueId)}
                    />
                  )}
                </div>
              );
            })}
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
                  onStatusChange={runs.length === 0 ? setPaneStatus : undefined}
                />
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
              onOpenItem={openAttentionItem}
              onOpenProject={openAttentionProject}
              onRegisterRepo={(item) => void registerRepoFromInbox(item)}
              notice={inboxNotice}
            />
          </div>
        )}
    </AppShell>
  );
}
