import { useEffect, useRef, useState } from 'react';
import './Map.css';
import { Badge, type BadgeTone } from './components';
import type { Backlog, BacklogIssue } from '../../shared/backlog-model';
import { deleteRefusal } from '../../shared/issue-file-ops';
import type { LauncherProject, RunLogRecord, RunTarget } from '../../shared/ipc-contract';
import { QuickFixForm, type QuickFixIssueRef } from './QuickFixForm';
import { START_VERB_LABELS, startSomething, type StartVerb } from '../../shared/launcher-model';
import { eligibleForRun, type InFlightRuns } from '../../shared/run-eligibility';
import { drainAvailability } from '../../shared/run-coordinator';
import {
  deriveIssueState,
  dependents,
  type IssueMapState,
  type UnmetDependency,
} from '../../shared/issue-graph';
import {
  summarizeRunGuidance,
  describeRunGuidance,
  type RunGuidance,
} from '../../shared/run-guidance';
import type { MergeDisplay } from '../../shared/merge-display';
import type { MergeAffordance } from '../../shared/merge-affordance';
import {
  previewBadge,
  type BranchPreview,
  type MergePreviewVerdict,
} from '../../shared/merge-preview';
import { latestReceiptFor } from '../../shared/receipt-audit';
import type { ScheduledDrainState } from '../../shared/scheduled-drain';
import {
  parseChecklist,
  checklistSourceText,
  markVerifiedDoneText,
  type ChecklistItem,
} from '../../shared/checklist-model';
import { allChecked } from '../../shared/checklist-state-model';

/**
 * Turn an `<input type="time">` value ("HH:MM") into the next epoch-ms
 * occurrence of that wall-clock time — today if it hasn't passed yet, else
 * tomorrow. Returns null for a blank/unparseable input (nothing to schedule).
 */
function nextOccurrenceOfTimeOfDay(hhmm: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/** `HH:MM` in the local timezone, for the pending-schedule label. */
function formatFireTime(fireAt: number): string {
  const d = new Date(fireAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface MapProps {
  /**
   * The active Project's repo path, driven by the Project Registry (issue 09).
   * When provided (controlled), the Map loads this repo and re-loads whenever it
   * changes, and hides its own path input — the ProjectBar owns Project choice.
   * When `undefined` (uncontrolled), the Map keeps its original self-driven
   * behavior of loading the backend's own repo on mount.
   */
  projectPath?: string | null;
  /** Start a Run on an eligible issue (opens a Pane scoped to it). */
  onRun?: (target: RunTarget) => void;
  /** Bump to force a reload from disk (used to reflect a Run reaching done). */
  reloadKey?: number;
  /** Fired after each load so the parent can track live issue statuses. */
  onBacklogLoaded?: (backlog: Backlog | null, projectPath: string) => void;
  /** The issue ids currently being Run (highlighted, Run action suppressed). */
  activeRunIssueIds?: number[];
  /**
   * Issue ids with a LIVE isolated Run in its worktree (issue 16, from the
   * on-disk `afk/` scan) — shown as `running` (in-worktree) even though the main
   * checkout still reads `open`.
   */
  worktreeRunningIds?: number[];
  /**
   * Issue ids whose isolated Run is committed on its `afk/` branch but not yet
   * merged (issue 16) — shown as `finished (unmerged)`, distinct from plain
   * `open` and merged-`done`. Derived from disk, so it survives closing Panes.
   */
  finishedUnmergedIds?: number[];
  /**
   * Issue ids whose isolated Run ended without a `done` commit and no live
   * session drives it (issue 22) — shown as `stranded`, with a Discard action so
   * it stops blocking the batch. Derived from disk, so it survives closing Panes.
   */
  strandedIds?: number[];
  /**
   * Issue ids whose isolated Run finished in its worktree but the auto-commit
   * never landed on the branch (issue 22) — shown as `commit failed`, also with a
   * Discard action.
   */
  commitFailedIds?: number[];
  /**
   * Discard a stranded / commit-failed Run: force-remove its worktree and delete
   * its `afk/NN-slug` branch (issue 22). Given the slug and issue id.
   */
  onDiscard?: (slug: string, issueId: number) => void;
  /** Start draining the backlog with the given max-concurrent cap (issue 06). */
  onDrain?: (cap: number) => void;
  /** Stop an in-progress drain (start no further Runs). */
  onStopDrain?: () => void;
  /** True while a drain is actively starting/queueing Runs. */
  draining?: boolean;
  /** The reason the last drain stopped, shown when not draining. */
  drainMessage?: string;
  /**
   * True when this drain's journal entry hasn't yet had its "Debrief this
   * drain" affordance offered (issue 152) — passive tier, once per entry.
   */
  debriefAvailable?: boolean;
  /** Open/focus a Just-talk Pane with `/debrief` typed and unsubmitted. */
  onDebrief?: () => void;
  /** The user-configurable max-concurrent cap. */
  cap?: number;
  /** Change the cap. */
  onCapChange?: (cap: number) => void;
  /**
   * A drain armed to fire later at a chosen wall-clock time (issue 190,
   * ADR-0024), or idle. Absent/`undefined` hides the schedule affordance
   * entirely (an uncontrolled Map, same convention as `onDrain`).
   */
  schedule?: ScheduledDrainState;
  /**
   * Arm a scheduled drain: `fireAt` is the chosen time as epoch ms, `cap` the
   * concurrency cap it starts with (same meaning as the manual Drain's cap),
   * and `selectedIds` the in-scope issue selection (issue 192, ADR-0024) —
   * omitted/undefined means every eligible issue is in scope, identical to
   * 190's whole-backlog default. At `fireAt` the schedule fires the SAME
   * start path as pressing Drain now, filtered to this selection.
   */
  onScheduleDrain?: (fireAt: number, cap: number, selectedIds?: readonly number[]) => void;
  /** Cancel the pending schedule before it fires. */
  onCancelScheduledDrain?: () => void;
  /**
   * The Merge button's exceptions-entry decision (issue 148, ADR-0021):
   * everyday merging belongs to the always-on lane now, so the button only
   * surfaces a paused conflict (named) and/or adopted stray branches — both
   * independent facts. `null`/absent hides the whole affordance (no lane data
   * yet); an empty decision (`{pausedConflict: null, strays: []}`) means the
   * lane is healthy and the button recedes.
   */
  mergeAffordance?: MergeAffordance | null;
  /** Resolve a paused conflict: attempt the real merge of this branch. */
  onResolveConflict?: (slug: string) => void;
  /** Merge the given adopted stray branches (no Receipt backs them). */
  onMergeStrays?: (slugs: string[]) => void;
  /** Force one auto-merge lane sweep now, reporting what it did. */
  onForceSweep?: () => void;
  /** The last force-sweep's plain-language report (a pause/hold reason), or null. */
  sweepNote?: string | null;
  /** True while a Merge (resolve / stray / lane) is running. */
  merging?: boolean;
  /**
   * What to show for the last (or in-flight) Merge: a headline plus, on a
   * failure/conflict, the script's verbatim `output` in a details panel (issue
   * 17). Null when no Merge has been triggered yet.
   */
  mergeDisplay?: MergeDisplay | null;
  /**
   * True when `main` is left mid-merge by a partial merge conflict (issue 24):
   * some slugs merged then a later one conflicted, leaving a conflicted index.
   * While true the Map blocks new Runs/Drain and shows an Abort affordance.
   */
  midMerge?: boolean;
  /** Abort the in-progress merge, returning `main` to a clean state (issue 24). */
  onAbortMerge?: () => void;
  /** True while an Abort is running. */
  aborting?: boolean;
  /**
   * Per-branch merge-preview verdicts (issues 104 & 105, ADR-0018): computed in
   * the background from the FULL sequential merge (merge order, ascending issue
   * id) and kept fresh as any tip moves. Every finished-unmerged branch carries
   * a verdict — `clean` / `conflicts (files…)` / `blocked behind NN` /
   * `recalculating`. Purely advisory — the Merge/Abort affordances are untouched.
   */
  previews?: BranchPreview[];
  /**
   * The single passive note shown when merge previews are unavailable because
   * git is below the 2.38 floor (ADR-0018 degradation), else null. Never shown
   * alongside badges.
   */
  previewNote?: string | null;
  /**
   * The persistent self-hosting stale-build banner (issue 173): non-null only
   * when this Project's repo IS mission-control and MC's own running build is
   * behind that repo's tip. Names how far behind and the rebuild command;
   * never blocks the drain.
   */
  staleBuildNote?: string | null;
  /**
   * The active Project's captured Completion blocks, newest first (issue 34).
   * The Map itself only reads this to source a selected HITL issue's latest
   * Receipt (`latestReceiptFor`, below) — the browsable feed of every finished
   * Run moved to the dedicated Receipts tab (issue 180), which replaced the
   * inline Run-log strip this prop used to feed.
   */
  runLog?: RunLogRecord[];
  /**
   * An Inbox click-through's focus request (issue 80): select this issue so
   * its detail opens — the parked/blocked issue the item referenced. Null when
   * nothing was requested.
   */
  focusIssueId?: number | null;
  /**
   * Bumped per click-through so re-focusing the SAME issue still re-selects it
   * (the user may have clicked elsewhere in the Map since).
   */
  focusSeq?: number;
  /**
   * Issue ids whose `repo:` targets a PLANNED (declared-but-absent) repo (issue
   * 96, ADR-0017): rendered grayed and un-runnable — they can't start until
   * their repo is created. An id leaves this set once its repo appears, so the
   * row ungrays automatically.
   */
  plannedIssueIds?: number[];
  /**
   * The Project's declared-but-absent repos (issue 96): shown grayed so the
   * intended codebase shape is visible before any code exists. Each becomes
   * real (leaves this list) once its directory appears and is registered.
   */
  plannedRepos?: { key: string; path: string }[];
  /**
   * The current Project as ＋ Start something acts on it (issue 116, ADR-0019):
   * the open workbench project, shaped as a LauncherProject so the two verbs
   * reuse `startPlanning` / `createQuickFix` unchanged. Null for a legacy
   * Project (no workbench machinery) — the verbs are then not offered and the
   * empty state keeps its passive "No issues found" message.
   */
  startProject?: LauncherProject | null;
  /**
   * Grill a feature (issue 116): open the Planning view for this Project — the
   * same `startPlanning` flow the Launcher's "Big feature" used.
   */
  onGrillFeature?: (project: LauncherProject) => void;
  /**
   * Simple issue → Run now (issue 116): launch a single bare Run on the
   * freshly created quick-fix issue — the same `runQuickFixNow` the Launcher used.
   */
  onQuickFixRunNow?: (project: LauncherProject, issue: QuickFixIssueRef) => void;
  /**
   * Just talk (issue 168, ADR-0019): open the same warm bare Pane the
   * Launcher home's Just talk offers, scoped to this Project (CORE.md
   * injected) — reachable without navigating back to the home page. No issue
   * claimed, no Run tracked.
   */
  onJustTalk?: (project: LauncherProject) => void;
  /**
   * True when this Project's workspace root is repo-less and not (yet) a git
   * repository (issue 158, ADR-0017) — shows the "not under git" badge next
   * to the run controls; Drain's cap>1 gate (in the parent) reads the same
   * signal to offer "Initialize git" instead of silently proceeding.
   */
  notUnderGit?: boolean;
  /**
   * The Project checkout's CURRENT branch (issue 167) — the one a Run/drain
   * integrates into (ADR-0002/0021, the target follows HEAD). Shown next to
   * the run controls; a protected (`main`/`master`) branch or a detached HEAD
   * gets an amber badge (the parent's `onRun`/`onDrain` wrapper shows the
   * pre-start Create/Switch/Proceed prompt before acting). Null/absent hides
   * the badge (no read yet).
   */
  branchStatus?: { branch: string | null; detached: boolean; protectedBranch: boolean } | null;
}

/**
 * The Map view: point at a Project's repo path and see its backlog — every
 * issue with its status, in-batch/standalone classification and HITL flag.
 * Clicking an issue shows its full body; eligible issues have a Run action.
 * The Map reads from disk (via the main-process Backlog Reader adapter over
 * IPC).
 */
export function Map({
  projectPath: controlledPath,
  onRun,
  reloadKey,
  onBacklogLoaded,
  activeRunIssueIds,
  worktreeRunningIds,
  finishedUnmergedIds,
  strandedIds,
  commitFailedIds,
  onDiscard,
  onDrain,
  onStopDrain,
  draining,
  drainMessage,
  debriefAvailable,
  onDebrief,
  cap,
  onCapChange,
  schedule,
  onScheduleDrain,
  onCancelScheduledDrain,
  mergeAffordance,
  onResolveConflict,
  onMergeStrays,
  onForceSweep,
  sweepNote,
  merging,
  mergeDisplay,
  midMerge,
  onAbortMerge,
  aborting,
  previews,
  previewNote,
  staleBuildNote,
  runLog,
  focusIssueId,
  focusSeq,
  plannedIssueIds,
  plannedRepos,
  startProject,
  onGrillFeature,
  onQuickFixRunNow,
  onJustTalk,
  notUnderGit,
  branchStatus,
}: MapProps = {}): JSX.Element {
  const activeRunSet = new Set(activeRunIssueIds ?? []);
  // Merge-preview verdicts keyed by issue id (issues 104 & 105): the
  // finished-unmerged row shows this branch's badge. Every branch with a
  // non-null verdict appears (the full sequential batch); a null verdict is a
  // defensive "no badge". A plain record, not a Map, since this component IS
  // named `Map` and shadows the constructor.
  const previewByIssueId: Record<number, MergePreviewVerdict> = {};
  for (const p of previews ?? []) {
    if (p.verdict) previewByIssueId[p.issueId] = p.verdict;
  }
  const plannedIssueSet = new Set(plannedIssueIds ?? []);
  const worktreeRunningSet = new Set(worktreeRunningIds ?? []);
  const finishedUnmergedSet = new Set(finishedUnmergedIds ?? []);
  const strandedSet = new Set(strandedIds ?? []);
  const commitFailedSet = new Set(commitFailedIds ?? []);
  // The on-disk worktree scan (issue 16) that gates "can I Run this?" on truth
  // the main checkout can't see (issue 21): an issue live in a worktree or
  // finished-but-unmerged on its `afk/` branch is not runnable even while `main`
  // still reads it `open`. Fed to the guidance banner and the detail Run button
  // so both agree with the per-row indicators.
  const inFlight: InFlightRuns = {
    worktreeRunningIds,
    finishedUnmergedIds,
    strandedIds,
    commitFailedIds,
  };
  const [path, setPath] = useState('');
  const [lastRequest, setLastRequest] = useState('');
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // ＋ Start something (issue 116): whether the populated Map's chooser is
  // expanded. The empty-state chooser is always visible, so it needs no toggle.
  const [startOpen, setStartOpen] = useState(false);

  // Scheduled drain (issue 190, ADR-0024): the `<input type="time">` draft the
  // human is picking, before "Schedule" arms it. Purely local UI state — the
  // armed schedule itself lives in the parent (`schedule` prop), same split as
  // `cap`/`onCapChange` above.
  const [scheduleTimeInput, setScheduleTimeInput] = useState('');
  // Scoped selection for the drain being scheduled (issue 192, ADR-0024): the
  // eligible issues UNCHECKED by the human, empty by default so "everything
  // eligible" (today's whole-backlog default, matching 190 exactly) needs no
  // interaction — the checklist starts fully checked. Reset whenever the
  // schedule panel goes back to idle (a fresh schedule starts fresh).
  const [scheduleExcludedIds, setScheduleExcludedIds] = useState<Set<number>>(new Set());

  // Issue-file Edit / Delete (issue 89): the Map's one write exception. The
  // editor seeds from a FRESH disk read (never a possibly-stale push), saves
  // are parser-validated in main (a refusal shows here with its reason), and
  // the delete sits behind an inline confirm naming the file. All of it
  // resets whenever the selection changes.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [issueOpBusy, setIssueOpBusy] = useState(false);
  const [issueOpError, setIssueOpError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft('');
    setIssueOpBusy(false);
    setIssueOpError(null);
    setConfirmingDelete(false);
  }, [selectedId]);

  // Interactive HITL checklist (issue 156): tick off a parked issue's
  // verification steps in-app instead of driving them by hand outside the
  // app. Checked flags persist in a main-process store keyed by project +
  // issue file (loaded fresh whenever the selection changes), and an
  // all-checked checklist offers a human-initiated "Mark verified & done"
  // that flips the issue through the existing issue-file edit path.
  const [checklistChecked, setChecklistChecked] = useState<boolean[]>([]);
  const [checklistLoaded, setChecklistLoaded] = useState(false);
  const [checklistBusy, setChecklistBusy] = useState(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [markDoneBusy, setMarkDoneBusy] = useState(false);
  const [markDoneError, setMarkDoneError] = useState<string | null>(null);

  useEffect(() => {
    setChecklistChecked([]);
    setChecklistLoaded(false);
    setChecklistBusy(false);
    setChecklistError(null);
    setMarkDoneBusy(false);
    setMarkDoneError(null);
  }, [selectedId]);

  // An Inbox click-through focuses its referenced issue (issue 80): select it
  // so the detail panel opens on it. Keyed on the bump too, so clicking the
  // same item again re-focuses even after the user selected something else.
  useEffect(() => {
    if (focusIssueId !== null && focusIssueId !== undefined) setSelectedId(focusIssueId);
  }, [focusIssueId, focusSeq]);

  // The currently-shown Project path, read inside the live-change listener
  // without re-subscribing on every load.
  const resolvedPathRef = useRef<string | null>(null);
  resolvedPathRef.current = resolvedPath;

  async function load(projectPath: string): Promise<void> {
    setLoading(true);
    setError(null);
    setLastRequest(projectPath);
    try {
      const res = await window.mc.loadBacklog({ projectPath });
      setResolvedPath(res.projectPath);
      setBacklog(res.backlog);
      setError(res.error);
      onBacklogLoaded?.(res.backlog, res.projectPath);
      // Point the live file-watch at whatever Project we just loaded, so the
      // Map updates itself on disk changes (Run flips, hand-edits, add/remove).
      window.mc.watchBacklog({ projectPath: res.projectPath });
    } catch (err) {
      setBacklog(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const controlled = controlledPath !== undefined;

  // Uncontrolled (no Project Registry): on mount, load the backend's own repo so
  // the Map is populated without the user typing a path first.
  useEffect(() => {
    if (!controlled) void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled by the Project Registry: load the active Project whenever it
  // changes (a switch, or the initial claim resolving). Null means "no Project
  // open yet" — wait for one.
  useEffect(() => {
    if (!controlled || controlledPath === null || controlledPath === undefined) return;
    void load(controlledPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledPath]);

  // Live updates: the main process pushes a fresh backlog whenever the watched
  // `issues/` directory changes on disk (issue 05). This is the general
  // mechanism that replaces the Run slice's targeted poll — a Run reaching
  // `done`, a hand-edit, or an added/removed issue all arrive here. We apply a
  // push only when it matches the Project we're currently showing.
  useEffect(() => {
    const off = window.mc.onBacklogChanged((msg) => {
      if (msg.projectPath !== resolvedPathRef.current) return;
      setBacklog(msg.backlog);
      setError(msg.error);
      onBacklogLoaded?.(msg.backlog, msg.projectPath);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explicit one-shot reload when the parent bumps reloadKey (e.g. right as a
  // Run starts, to capture the issue's status immediately). Ongoing changes are
  // handled by the live watch above — this is not a poll.
  useEffect(() => {
    if (reloadKey === undefined || reloadKey === 0) return;
    void load(lastRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const selected = backlog?.issues.find((i) => i.id === selectedId) ?? null;

  // The checklist itself: parsed from the selected issue's latest Receipt
  // `detail` body (a parked HITL Run's "Ready for manual verification" steps),
  // falling back to the issue file's own body. Non-HITL issues never look at
  // this — the detail panel gates rendering on `issue.hitl`.
  const selectedReceipt =
    selected !== null ? latestReceiptFor(runLog ?? [], selected.id) : null;
  const checklistItems: ChecklistItem[] = selected
    ? parseChecklist(checklistSourceText(selectedReceipt?.detail ?? null, selected.body))
    : [];
  const checklistItemCount = checklistItems.length;

  // Load the persisted checked flags whenever the selection (or its item
  // count) changes — a fresh read, same pattern as the issue-file editor's
  // seed-from-disk, so a stale push never shows a wrong check state.
  useEffect(() => {
    if (!selected || !selected.hitl || resolvedPath === null) return;
    if (checklistItemCount === 0) {
      setChecklistChecked([]);
      setChecklistLoaded(true);
      return;
    }
    let cancelled = false;
    setChecklistLoaded(false);
    window.mc
      .getChecklistState({
        projectPath: resolvedPath,
        fileName: selected.fileName,
        itemCount: checklistItemCount,
      })
      .then((res) => {
        if (cancelled) return;
        setChecklistChecked(res.checked);
        setChecklistLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setChecklistError(err instanceof Error ? err.message : String(err));
        setChecklistLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, resolvedPath, checklistItemCount]);

  async function handleToggleChecklistItem(index: number): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setChecklistBusy(true);
    setChecklistError(null);
    try {
      const res = await window.mc.toggleChecklistItem({
        projectPath: resolvedPath,
        fileName: selected.fileName,
        itemCount: checklistItemCount,
        index,
      });
      setChecklistChecked(res.checked);
    } catch (err) {
      setChecklistError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecklistBusy(false);
    }
  }

  // "Mark verified & done" (issue 156): a human sign-off, never a silent
  // flip — it re-reads the file fresh, flips `status: wip` → `done` and
  // appends a dated note, then saves through the SAME parser-validated,
  // auto-committed issue-file edit path issue 89 already exposes.
  async function markChecklistVerifiedDone(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setMarkDoneBusy(true);
    setMarkDoneError(null);
    try {
      const read = await window.mc.readIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
      });
      if (read.content === null) {
        setMarkDoneError(read.error ?? 'Could not read the issue file.');
        return;
      }
      const dateIso = new Date().toISOString().slice(0, 10);
      const updated = markVerifiedDoneText(read.content, dateIso);
      if (updated === null) {
        setMarkDoneError('This issue is already done — nothing to flip.');
        return;
      }
      const res = await window.mc.editIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
        content: updated,
      });
      if (!res.ok) {
        setMarkDoneError(res.error ?? 'Save failed.');
        return;
      }
      // The reparsed backlog arrives via the live watch push — nothing to do.
    } catch (err) {
      setMarkDoneError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarkDoneBusy(false);
    }
  }

  // The eligible-issue set the schedule panel offers per-issue selection over
  // (issue 192): the same `eligibleForRun` predicate the Coordinator itself
  // uses, so the checklist never diverges from what a drain would actually
  // start. A live re-plan at fire time may see a different eligible set (an
  // issue's dependency lands, another goes `wip`) — selection only narrows
  // what's picked from whatever is eligible then, it never widens it.
  const scheduleEligibleIds = (backlog?.issues ?? [])
    .filter((i) => eligibleForRun(i, backlog?.issues ?? [], finishedUnmergedIds ?? []))
    .map((i) => i.id)
    .sort((a, b) => a - b);

  // Map list order (issue 102): show the latest issues at the top. The shared
  // Backlog Model sorts ascending by id (and eligibility / the lowest-numbered
  // pick logic depend on that order), so we reverse ONLY here at the display
  // layer — a descending-by-id copy — without touching the model.
  const displayIssues = backlog ? [...backlog.issues].sort((a, b) => b.id - a.id) : [];

  // Drain honesty (issue 90): the control is enabled only when the coordinator
  // would actually have work — an issue startable now, or unblockable by the
  // drain (a live Run counts toward unblocking; a parked wip does not). The
  // backlog arrives via the live watch push, so adding an eligible issue
  // enables the button within a watch beat with no extra plumbing. Live Runs =
  // in-memory running Panes plus in-worktree Runs from the on-disk scan.
  const drainGate = drainAvailability(backlog?.issues ?? [], [
    ...activeRunSet,
    ...worktreeRunningSet,
  ]);

  // Open the editor on a fresh disk read of the full file (frontmatter +
  // body) — the backlog push only carries the body, and could be stale.
  async function startEdit(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    setConfirmingDelete(false);
    try {
      const res = await window.mc.readIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
      });
      if (res.content === null) {
        setIssueOpError(res.error ?? 'Could not read the issue file.');
        return;
      }
      setDraft(res.content);
      setEditing(true);
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueOpBusy(false);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    try {
      const res = await window.mc.editIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
        content: draft,
      });
      if (!res.ok) {
        // A refused save (parse-breaking text) keeps the editor open with the
        // draft intact, so the user fixes the text instead of losing it.
        setIssueOpError(res.error ?? 'Save failed.');
        return;
      }
      setEditing(false);
      setDraft('');
      // The reparsed backlog arrives via the live watch push — nothing to do.
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueOpBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!selected || resolvedPath === null) return;
    setIssueOpBusy(true);
    setIssueOpError(null);
    try {
      const res = await window.mc.deleteIssueFile({
        projectPath: resolvedPath,
        fileName: selected.fileName,
      });
      if (!res.ok) {
        setIssueOpError(res.error ?? 'Delete failed.');
        setConfirmingDelete(false);
        return;
      }
      // The file is gone; clear the selection (the watch push drops the row).
      setConfirmingDelete(false);
      setSelectedId(null);
    } catch (err) {
      setIssueOpError(err instanceof Error ? err.message : String(err));
      setConfirmingDelete(false);
    } finally {
      setIssueOpBusy(false);
    }
  }

  return (
    <div className="map">
      {/* Controlled by the Project Registry (issue 09): the shell header owns the
          Project name + path breadcrumb, so the Map draws no path bar of its own —
          matching the approved mock, whose top row is shell chrome. Uncontrolled
          (legacy / no Registry) keeps the Map's own path input + Load. */}
      {!controlled && (
        <div className="map__pathbar">
          <input
            className="map__pathinput"
            type="text"
            placeholder="Project repo path (blank = this repo)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(path);
            }}
          />
          <button className="map__load" onClick={() => void load(path)} disabled={loading}>
            {loading ? 'Loading…' : 'Load'}
          </button>
          {resolvedPath && (
            <span className="map__meta">
              {resolvedPath}
              {backlog?.activePrd ? ` · PRD: ${backlog.activePrd}` : ' · no active PRD'}
            </span>
          )}
        </div>
      )}

      {/* Primary controls (mock: one prominent row) — ＋ Start something on the
          left; the run controls (max-concurrent cap, Drain, Merge) grouped on the
          right so the highest-consequence actions read the easiest (story 36).
          Each piece keeps its own guard, so a legacy Project (no startProject)
          shows just the run controls, and an uncontrolled Map shows none. */}
      {resolvedPath !== null &&
        (onDrain ||
          onForceSweep ||
          (startProject && backlog && backlog.issues.length > 0)) && (
          <div className="map__controls">
            {/* ＋ Start something (issue 116, ADR-0019): the two per-Project entry
                verbs behind a disclosure so they never crowd the backlog. Only
                for a workbench Project with a populated backlog — the empty case
                is the chooser-as-empty-state below. */}
            {startProject &&
              backlog &&
              backlog.issues.length > 0 &&
              (onGrillFeature || onQuickFixRunNow || onJustTalk) && (
                <button
                  className={`map__start-toggle${startOpen ? ' map__start-toggle--open' : ''}`}
                  onClick={() => setStartOpen((v) => !v)}
                  aria-expanded={startOpen}
                  title="Start something in this project: grill a feature, or add a simple issue"
                >
                  ＋ Start something
                </button>
              )}

            <div className="map__controls-run">
              {branchStatus && (
                <Badge
                  tone={branchStatus.detached || branchStatus.protectedBranch ? 'amber' : 'neutral'}
                  className="map__branch-badge"
                  title={
                    branchStatus.detached
                      ? 'This checkout has no branch checked out (detached HEAD) — a Run/drain will prompt to create or switch one first.'
                      : branchStatus.protectedBranch
                        ? `On ${branchStatus.branch} — a protected branch. A Run/drain will prompt to create or switch first.`
                        : `A Run/drain integrates into ${branchStatus.branch}.`
                  }
                >
                  ⎇ {branchStatus.detached ? 'detached HEAD' : branchStatus.branch}
                </Badge>
              )}
              {notUnderGit && (
                <Badge
                  tone="amber"
                  className="map__nogit-badge"
                  title="This project's workspace root isn't a git repository yet — Runs can't isolate here until it is."
                >
                  not under git
                </Badge>
              )}
              {onDrain && (
                <label className="map__cap">
                  max concurrent
                  <input
                    className="map__cap-input"
                    type="number"
                    min={1}
                    step={1}
                    value={cap ?? 2}
                    disabled={draining}
                    onChange={(e) =>
                      onCapChange?.(Math.max(1, Math.floor(Number(e.target.value) || 1)))
                    }
                  />
                </label>
              )}
              {onDrain &&
                (draining ? (
                  <button
                    className="map__drain map__drain--stop"
                    onClick={() => onStopDrain?.()}
                  >
                    ■ Stop drain
                  </button>
                ) : (
                  <button
                    className="map__drain"
                    onClick={() => onDrain(cap ?? 2)}
                    disabled={branchStatus === null || midMerge || !drainGate.available}
                    title={
                      branchStatus === null
                        ? 'Resolving branch status…'
                        : midMerge
                          ? 'Blocked: main is mid-merge — resolve or abort the merge first'
                          : (drainGate.reason ??
                            'Drain the backlog, starting eligible Runs up to the cap')
                    }
                  >
                    ▶▶ Drain backlog
                  </button>
                ))}
              {/* Scheduled drain (issue 190, ADR-0024): a deferred press of
                  Drain — pick a wall-clock time, an open Window's timer fires
                  it later via the exact same start path. One-shot and
                  un-persisted: closing this Window/quitting MC before the
                  time just means it never fires, nothing saved. */}
              {onScheduleDrain &&
                (schedule && schedule.kind === 'pending' ? (
                  <span className="map__schedule map__schedule--pending">
                    ⏰ Drain scheduled for {formatFireTime(schedule.fireAt)}
                    {schedule.selectedIds !== undefined && (
                      <span
                        className="map__schedule-scope-note"
                        title={`Scoped to issue(s) ${schedule.selectedIds.join(', ')}`}
                      >
                        {' '}
                        · {schedule.selectedIds.length} selected
                      </span>
                    )}
                    <button
                      className="map__schedule-cancel"
                      onClick={() => onCancelScheduledDrain?.()}
                      title="Cancel the scheduled drain before it fires"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  // Schedule popover (issue 195): a self-contained panel opened
                  // by a clock button, so scheduling no longer competes for room
                  // in the run toolbar. Built on a native <details> — no extra
                  // open/close state, and arming replaces this whole node with
                  // the pending pill above, which closes it.
                  <details className="map__schedule-popover">
                    <summary
                      className="map__schedule-trigger"
                      title="Schedule a drain to start later"
                    >
                      ⏰ Schedule
                    </summary>
                    <div className="map__schedule-panel">
                      <div className="map__schedule-panel-title">Schedule a drain</div>
                      <label className="map__schedule-field">
                        <span className="map__schedule-field-label">Fire at</span>
                        <input
                          className="map__schedule-time"
                          type="time"
                          value={scheduleTimeInput}
                          onChange={(e) => setScheduleTimeInput(e.target.value)}
                          title="Time of day to start a drain (today, or tomorrow if it's already passed)"
                        />
                      </label>
                      {onCapChange && (
                        <label className="map__schedule-field">
                          <span className="map__schedule-field-label">Max concurrent</span>
                          <input
                            className="map__cap-input"
                            type="number"
                            min={1}
                            step={1}
                            value={cap ?? 2}
                            onChange={(e) =>
                              onCapChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))
                            }
                          />
                        </label>
                      )}
                      {/* Per-issue scope (issue 192, ADR-0024): defaults to every
                          eligible issue selected until the human unchecks one. */}
                      {scheduleEligibleIds.length > 0 && (
                        <div className="map__schedule-field">
                          <span className="map__schedule-field-label">
                            Scope · {scheduleEligibleIds.length - scheduleExcludedIds.size} of{' '}
                            {scheduleEligibleIds.length} eligible
                          </span>
                          <ul className="map__schedule-scope-list">
                            {scheduleEligibleIds.map((id) => (
                              <li key={id}>
                                <label className="map__schedule-scope-item">
                                  <input
                                    type="checkbox"
                                    checked={!scheduleExcludedIds.has(id)}
                                    onChange={(e) =>
                                      setScheduleExcludedIds((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.delete(id);
                                        else next.add(id);
                                        return next;
                                      })
                                    }
                                  />
                                  #{String(id).padStart(2, '0')}
                                </label>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {/* Arm-time branch warning (issue 195): the same protected-
                          branch/detached-HEAD guard the manual Drain shows,
                          surfaced now so you can create a branch before the timer
                          fires. Pressing Schedule drain on a protected branch
                          routes through the Create/Switch/Schedule-anyway dialog. */}
                      {branchStatus &&
                        (branchStatus.detached || branchStatus.protectedBranch) && (
                          <p className="map__schedule-warn">
                            {branchStatus.detached ? (
                              <>
                                ⚠ HEAD is detached. Scheduling will offer to create a branch first —
                                otherwise the drain is skipped at fire time.
                              </>
                            ) : (
                              <>
                                ⚠ You're on <strong>{branchStatus.branch}</strong> — a protected
                                branch. Scheduling will offer to create a branch first — otherwise
                                the drain is skipped at fire time.
                              </>
                            )}
                          </p>
                        )}
                      <div className="map__schedule-actions">
                        <button
                          className="map__schedule-arm"
                          disabled={
                            nextOccurrenceOfTimeOfDay(scheduleTimeInput, Date.now()) === null ||
                            (scheduleEligibleIds.length > 0 &&
                              scheduleExcludedIds.size === scheduleEligibleIds.length)
                          }
                          onClick={() => {
                            const fireAt = nextOccurrenceOfTimeOfDay(scheduleTimeInput, Date.now());
                            if (fireAt === null) return;
                            const selectedIds =
                              scheduleExcludedIds.size === 0
                                ? undefined
                                : scheduleEligibleIds.filter((id) => !scheduleExcludedIds.has(id));
                            onScheduleDrain(fireAt, cap ?? 2, selectedIds);
                            setScheduleExcludedIds(new Set());
                          }}
                          title="Schedule a drain to start at this time (today, or tomorrow if it's already passed)"
                        >
                          Schedule drain
                        </button>
                      </div>
                    </div>
                  </details>
                ))}
              {/* Merge exceptions entry (issue 148, ADR-0021): everyday merging
                  belongs to the always-on lane, so this only surfaces a paused
                  conflict (named) and/or adopted strays — a healthy lane with
                  no strays shows neither, and the button recedes. Force sweep
                  stays available regardless, as the low-key fallback action. */}
              {onResolveConflict && mergeAffordance?.pausedConflict && (
                <button
                  className="map__merge map__merge--conflict"
                  onClick={() => onResolveConflict(mergeAffordance.pausedConflict!.slug)}
                  disabled={merging}
                  title={mergeAffordance.pausedConflict.reason}
                >
                  {merging ? 'Resolving…' : `⚠ Conflict paused · ${mergeAffordance.pausedConflict.slug}`}
                </button>
              )}
              {onMergeStrays && mergeAffordance && mergeAffordance.strays.length > 0 && (
                <button
                  className="map__merge map__merge--stray"
                  onClick={() => onMergeStrays(mergeAffordance.strays.map((s) => s.slug))}
                  disabled={merging}
                  title="Merge adopted stray branch(es) — no Receipt backs them, so the lane never merges them on its own"
                >
                  {merging ? 'Merging…' : `Merge strays · ${mergeAffordance.strays.length}`}
                </button>
              )}
              {onForceSweep && (
                <button
                  className="map__sweep"
                  onClick={() => onForceSweep()}
                  disabled={merging}
                  title="Force one auto-merge lane sweep now"
                >
                  {merging ? 'Sweeping…' : '↻ Force sweep'}
                </button>
              )}
            </div>
          </div>
        )}

      {/* ＋ Start something expansion (issue 116): the grill / simple-issue verbs
          (or the quick-fix form) drop below the controls when opened. */}
      {startOpen &&
        startProject &&
        resolvedPath !== null &&
        backlog &&
        backlog.issues.length > 0 &&
        (onGrillFeature || onQuickFixRunNow || onJustTalk) && (
          <div className="map__startpanel">
            <StartSomething
              project={startProject}
              onGrill={(p) => onGrillFeature?.(p)}
              onRunNow={(p, issue) => onQuickFixRunNow?.(p, issue)}
              onTalk={(p) => onJustTalk?.(p)}
            />
          </div>
        )}

      {/* Drain status (issue 90): while draining, what it's doing; when idle, the
          truthful reason the control is disabled — never a dead click. */}
      {onDrain &&
        resolvedPath !== null &&
        (draining ||
          (!midMerge && drainGate.reason) ||
          (drainMessage && drainMessage !== drainGate.reason) ||
          debriefAvailable) && (
          <div className="map__notes">
            {draining && (
              <span className="map__note">
                draining… starting eligible Runs up to {cap ?? 2}
              </span>
            )}
            {!draining && !midMerge && drainGate.reason && (
              <span className="map__note map__note--muted">{drainGate.reason}</span>
            )}
            {!draining && drainMessage && drainMessage !== drainGate.reason && (
              <span className="map__note map__note--muted">{drainMessage}</span>
            )}
            {/* "Debrief this drain" (issue 152): passive, once per journal
                entry — opens/focuses a Just-talk Pane with `/debrief` typed
                but unsubmitted (issue-91 pattern). */}
            {!draining && debriefAvailable && (
              <button className="map__debrief-btn" onClick={onDebrief}>
                Debrief this drain
              </button>
            )}
          </div>
        )}

      {/* Mid-merge banner (issue 24): main is mid-merge; new Runs/Drain are paused
          until the human resolves or aborts. The most consequential state, so it
          reads as a prominent alert (story 36). */}
      {midMerge && resolvedPath !== null && (
        <div className="map__alert">
          <span className="map__alert-text">
            main is mid-merge — a merge stopped on a conflict with some branches
            already integrated. Resolve the conflict and commit, or abort to return
            main to a clean state. New Runs and Drain are paused until then.
          </span>
          {onAbortMerge && (
            <button
              className="map__alert-action"
              onClick={() => onAbortMerge()}
              disabled={aborting}
              title="Run git merge --abort to return main to a clean state (already-merged branches stay merged)"
            >
              {aborting ? 'Aborting…' : 'Abort merge'}
            </button>
          )}
        </div>
      )}

      {/* Self-hosting stale-build banner (issue 173): MC's own running build is
          behind the repo it is draining — a stale checkout silently ignores
          current CONFIG values (run_timeout) and merge behavior. Persistent
          and prominent (amber, not blocking) so the drift is impossible to
          miss; never gates Runs/Drain. */}
      {staleBuildNote && resolvedPath !== null && (
        <div className="map__stale-build-banner" title={staleBuildNote}>
          <span className="map__stale-build-text">{staleBuildNote}</span>
        </div>
      )}

      {/* Force-sweep report (issue 148): what a manually-triggered sweep did
          when it held or paused rather than merging (a merge attempt reports
          through the same `mergeDisplay` panel below). */}
      {resolvedPath !== null && sweepNote && (
        <div className="map__notes">
          <span className="map__note map__note--muted">{sweepNote}</span>
        </div>
      )}

      {/* Merge outcome (issue 17): the tone-coded headline plus, on a
          failure/conflict, the script's verbatim output in a collapsible panel. */}
      {resolvedPath !== null && mergeDisplay && (
        <div className="map__mergeout">
          <span className={`map__merge-state map__merge-state--${mergeDisplay.tone}`}>
            {mergeDisplay.headline}
          </span>
          {mergeDisplay.showOutput && mergeDisplay.output && (
            <details className="map__merge-details" open>
              <summary className="map__merge-details-summary">Merge output</summary>
              <pre className="map__merge-output">{mergeDisplay.output}</pre>
            </details>
          )}
        </div>
      )}

      {/* Planned repos (issue 96, ADR-0017): declared-but-absent repos, grayed to
          read as intended-not-yet-real; each leaves this bar once its directory
          appears and is registered. */}
      {resolvedPath !== null && plannedRepos && plannedRepos.length > 0 && (
        <div className="map__plannedbar">
          <span className="map__planned-label">
            Planned repos — declared, not yet created:
          </span>
          {plannedRepos.map((r) => (
            <span
              key={r.key}
              className="map__planned-repo"
              title={`${r.path || r.key} does not exist yet — a scaffold Run (or issue 95 registration) will create it`}
            >
              <code>{r.key}</code>
              {r.path ? <span className="map__planned-repo-path"> · {r.path}</span> : null}
            </span>
          ))}
        </div>
      )}

      {/* Stranded / commit-failed Runs (issue 22): can never merge as-is; each
          offers a Discard so the batch can proceed. Derived from the on-disk scan
          so it survives closing every Pane. */}
      {onDiscard &&
        resolvedPath !== null &&
        backlog &&
        (strandedSet.size > 0 || commitFailedSet.size > 0) && (
          <div className="map__strandedbar">
            <span className="map__stranded-label">
              Stranded Runs — these can’t merge; discard to unblock the batch:
            </span>
            {backlog.issues
              .filter((i) => strandedSet.has(i.id) || commitFailedSet.has(i.id))
              .map((i) => {
                const failed = commitFailedSet.has(i.id);
                return (
                  <span key={i.id} className="map__stranded-item">
                    <Badge tone="red">
                      {String(i.id).padStart(2, '0')} {failed ? 'commit failed' : 'stranded'}
                    </Badge>
                    <button
                      className="map__discard"
                      title="Force-remove this Run's worktree and afk/ branch"
                      onClick={() => onDiscard(i.fileName.replace(/\.md$/, ''), i.id)}
                    >
                      Discard
                    </button>
                  </span>
                );
              })}
          </div>
        )}

      {/* Merge-preview degradation note (issue 104, ADR-0018): git < 2.38 — one
          passive line naming the version floor, no fallback merge machinery. */}
      {previewNote && resolvedPath !== null && (
        <div className="map__preview-note" title={previewNote}>
          {previewNote}
        </div>
      )}

      {/* Empty state (issue 14): a Registry-driven Window with no active Project
          opens NOTHING — prompt the user to open or choose one. */}
      {controlled && controlledPath == null && (
        <div className="map__no-project">
          No Project open. Choose one from the Project switcher in the header, or
          open a repo in a new Window.
        </div>
      )}

      {error && <div className="map__error">Could not read backlog: {error}</div>}

      {/* Live "what can I Run right now" guidance (issue 11): the eligibility
          banner, derived every render from the same source of truth the rows use,
          so it never points at a stale issue number. */}
      {backlog && (
        <RunGuidanceBanner
          issues={backlog.issues}
          inFlight={inFlight}
          onSelect={(id) => setSelectedId(id)}
        />
      )}

      {/* Empty-backlog chooser (issue 116, ADR-0019): a workbench Project with an
          empty backlog leads with the two verbs instead of a passive line. */}
      {startProject &&
        resolvedPath !== null &&
        backlog &&
        backlog.issues.length === 0 &&
        (onGrillFeature || onQuickFixRunNow || onJustTalk) && (
          <div className="map__start-empty">
            <p className="map__start-empty-text">This backlog is empty — start something:</p>
            <StartSomething
              project={startProject}
              onGrill={(p) => onGrillFeature?.(p)}
              onRunNow={(p, issue) => onQuickFixRunNow?.(p, issue)}
              onTalk={(p) => onJustTalk?.(p)}
            />
          </div>
        )}

      {/* Backlog (mock: single column, collapsible) — clear status/dependency/
          blocker hierarchy per row (story 34); the selected row expands in place
          to its full detail. Scrolls in its own region (issue 159) so a 100+
          issue backlog never pushes the Run log (above) out of view. */}
      <details className="map__section" open>
        <summary className="map__section-summary">
          <span className="map__section-title">Backlog</span>
          {backlog && (
            <span className="map__section-count">
              {backlog.issues.length} issue{backlog.issues.length === 1 ? '' : 's'}
            </span>
          )}
        </summary>
        <ul className="map__list">
          {displayIssues.flatMap((issue) => {
            const row = (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={issue.id === selectedId}
                planned={plannedIssueSet.has(issue.id)}
                running={activeRunSet.has(issue.id)}
                previewVerdict={previewByIssueId[issue.id] ?? null}
                worktreeRun={
                  finishedUnmergedSet.has(issue.id)
                    ? 'finished-unmerged'
                    : commitFailedSet.has(issue.id)
                      ? 'commit-failed'
                      : strandedSet.has(issue.id)
                        ? 'stranded'
                        : worktreeRunningSet.has(issue.id)
                          ? 'running'
                          : null
                }
                state={deriveIssueState(issue, backlog!.issues, finishedUnmergedIds ?? [])}
                onSelect={() =>
                  setSelectedId((cur) => (cur === issue.id ? null : issue.id))
                }
                onRun={
                  onRun && resolvedPath !== null && !midMerge && branchStatus !== null
                    ? () =>
                        onRun({
                          issueId: issue.id,
                          issueFileName: issue.fileName,
                          issueTitle: issue.title,
                          projectPath: resolvedPath,
                        })
                    : undefined
                }
              />
            );
            if (issue.id !== selectedId || !backlog) return [row];
            // Inline detail: the selected row expands in place (single-column
            // mock) to its dependency detail, the issue-file Edit/Delete ops, and
            // the full body/editor. Actions operate on `selected` (=== this row).
            return [
              row,
              <li key={`${issue.id}-detail`} className="map__detail">
                <DependencySection
                  issue={issue}
                  issues={backlog.issues}
                  finishedUnmergedIds={finishedUnmergedIds ?? []}
                />

                {/* Interactive HITL checklist (issue 156): only HITL issues
                    render one — a normal issue shows nothing here. The human
                    can close a HITL issue by hand from ANY non-done status
                    (issue 195): a walkthrough never has to be drained/parked
                    into `wip` first — `canMarkDone` enables straight from
                    `open`, and the button shows even when there is no checklist. */}
                {issue.hitl && (
                  <ChecklistSection
                    items={checklistItems}
                    checked={checklistChecked}
                    loaded={checklistLoaded}
                    busy={checklistBusy}
                    error={checklistError}
                    onToggle={(index) => void handleToggleChecklistItem(index)}
                    canMarkDone={issue.status !== 'done'}
                    onMarkDone={() => void markChecklistVerifiedDone()}
                    markDoneBusy={markDoneBusy}
                    markDoneError={markDoneError}
                  />
                )}

                {/* Edit / Delete (issue 89): the Map's one write exception —
                    issue FILES only. Edit is a raw editor over the whole file
                    (frontmatter + body), saved verbatim once the real backlog
                    parser accepts it; Delete is refused for wip (the flip is a
                    claim) and puts done behind an explicit "delete anyway". */}
                {resolvedPath !== null && !editing && (
                  <div className="map__issue-ops">
                    <button
                      className="map__issue-op"
                      onClick={() => void startEdit()}
                      disabled={issueOpBusy}
                      title="Edit this issue file (raw text: frontmatter + body)"
                    >
                      ✎ Edit
                    </button>
                    {(() => {
                      const refusal = deleteRefusal(issue.status);
                      return (
                        <button
                          className="map__issue-op map__issue-op--delete"
                          onClick={() => {
                            setIssueOpError(null);
                            setConfirmingDelete(true);
                          }}
                          disabled={issueOpBusy || confirmingDelete || refusal !== null}
                          title={refusal ?? `Delete ${issue.fileName}`}
                        >
                          🗑 Delete
                        </button>
                      );
                    })()}
                  </div>
                )}

                {confirmingDelete && !editing && (
                  <div className="map__delete-confirm">
                    <span className="map__delete-confirm-text">
                      Delete <code>{issue.fileName}</code>?
                      {issue.status === 'done'
                        ? ' This issue is done — its Receipt and history survive in git, but the file goes.'
                        : ' This removes the issue from the backlog.'}
                    </span>
                    <button
                      className="map__issue-op map__issue-op--delete"
                      onClick={() => void confirmDelete()}
                      disabled={issueOpBusy}
                    >
                      {issue.status === 'done' ? 'Delete anyway' : 'Delete file'}
                    </button>
                    <button
                      className="map__issue-op"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={issueOpBusy}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {issueOpError && <div className="map__issue-op-error">{issueOpError}</div>}

                {editing ? (
                  <div className="issue-editor">
                    <textarea
                      className="issue-editor__textarea"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                    />
                    <div className="issue-editor__row">
                      <button
                        className="map__issue-op map__issue-op--save"
                        onClick={() => void saveEdit()}
                        disabled={issueOpBusy}
                      >
                        {issueOpBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="map__issue-op"
                        onClick={() => {
                          setEditing(false);
                          setDraft('');
                          setIssueOpError(null);
                        }}
                        disabled={issueOpBusy}
                      >
                        Cancel
                      </button>
                      <span className="issue-editor__hint">
                        Saved verbatim once it parses (status: open | wip | done).
                      </span>
                    </div>
                  </div>
                ) : (
                  <pre className="issue__body">{issue.body}</pre>
                )}
              </li>,
            ];
          })}
          {backlog && backlog.issues.length === 0 && !startProject && (
            <li className="map__empty">No issues found in this backlog.</li>
          )}
        </ul>
      </details>

    </div>
  );
}

/**
 * ＋ Start something (issue 116, ADR-0019; "Just talk" added by issue 168):
 * the per-Project entry verbs, relocated from the Launcher's front door onto
 * the Map. "Grill a feature" opens the Planning view; "Simple issue" opens
 * the one-sentence quick-fix form (Run-now / leave-queued); "Just talk" opens
 * the same warm bare Pane the Launcher home's Just talk offers, scoped to
 * this project. Routing is the pure `startSomething` resolver — this
 * component only dispatches on its verdict and reuses existing machinery,
 * building no new planning, run, or talk flow.
 */
function StartSomething({
  project,
  onGrill,
  onRunNow,
  onTalk,
}: {
  project: LauncherProject;
  onGrill: (project: LauncherProject) => void;
  onRunNow: (project: LauncherProject, issue: QuickFixIssueRef) => void;
  onTalk: (project: LauncherProject) => void;
}): JSX.Element {
  // Whether the "Simple issue" quick-fix form is open (vs. the verb picker).
  const [simple, setSimple] = useState(false);
  // A quiet "leave it queued" confirmation after the form dismisses.
  const [queuedNote, setQueuedNote] = useState<string | null>(null);

  const choose = (verb: StartVerb): void => {
    const target = startSomething(verb, project);
    if (target.route === 'planning') {
      onGrill(target.project);
    } else if (target.route === 'talk') {
      onTalk(target.project);
    } else {
      setQueuedNote(null);
      setSimple(true);
    }
  };

  if (simple) {
    return (
      <QuickFixForm
        // The Map's project is fixed — no picker, just this one project.
        projects={[project]}
        initialDir={project.workbenchDir}
        pickable={false}
        onRunNow={(p, issue) => {
          onRunNow(p, issue);
          // The Map stays mounted across the view switch to the Run's Pane;
          // close the form so returning here isn't a stale "Run now" panel.
          setSimple(false);
        }}
        onLeaveQueued={(p, issue) => {
          setQueuedNote(
            `Issue ${String(issue.issueId).padStart(2, '0')} is queued in ${p.label} — the next drain (or a manual Run) picks it up.`,
          );
          setSimple(false);
        }}
        onCancel={() => setSimple(false)}
      />
    );
  }

  return (
    <div className="map__start-verbs">
      {queuedNote !== null && <p className="map__start-note">{queuedNote}</p>}
      <button
        className="map__start-verb"
        onClick={() => choose('grill')}
        title="Plan a feature: a Planning session (grill → PRD → issues) for this project"
      >
        {START_VERB_LABELS.grill}
      </button>
      <button
        className="map__start-verb"
        onClick={() => choose('simple')}
        title="One sentence becomes a standalone issue in this project's backlog"
      >
        {START_VERB_LABELS.simple}
      </button>
      <button
        className="map__start-verb"
        onClick={() => choose('talk')}
        title="Open a warm chat scoped to this project — no issue claimed, no Run tracked"
      >
        {START_VERB_LABELS.talk}
      </button>
    </div>
  );
}

/**
 * Live Run guidance (issue 11). Recomputes on every render from the current
 * issues, so a status change elsewhere in the batch is reflected immediately.
 * Eligible → lists the runnable issues as clickable chips (click selects the
 * row, where the existing Run button lives). Otherwise → an explicit
 * empty-state naming what's blocking, or that everything is done/wip.
 */
function RunGuidanceBanner({
  issues,
  inFlight,
  onSelect,
}: {
  issues: BacklogIssue[];
  inFlight: InFlightRuns;
  onSelect: (id: number) => void;
}): JSX.Element {
  const guidance: RunGuidance = summarizeRunGuidance(issues, inFlight);
  const eligible = guidance.kind === 'eligible';
  return (
    <div className={`map__guidance map__guidance--${eligible ? 'eligible' : 'none'}`}>
      {guidance.kind === 'eligible' ? (
        <>
          {/* Mock: "● You can Run 1 issue right now  #123 ready". The runnable
              ids ride as clickable ready-chips (they select the row where the
              Run button lives), so the sentence stays short — describeRunGuidance
              still owns the blocked/settled/empty phrasings below. */}
          <span className="map__guidance-text">
            You can Run <strong>{guidance.runnable.length}</strong>{' '}
            {guidance.runnable.length === 1 ? 'issue' : 'issues'} right now
          </span>
          <span className="map__guidance-chips">
            {guidance.runnable.map((r) => (
              <button
                key={r.id}
                className="map__guidance-chip"
                title={`Show ${stripId(r.title)}`}
                onClick={() => onSelect(r.id)}
              >
                #{String(r.id).padStart(2, '0')} ready
              </button>
            ))}
          </span>
        </>
      ) : (
        <span className="map__guidance-text">{describeRunGuidance(guidance)}</span>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  selected,
  planned,
  running,
  previewVerdict,
  worktreeRun,
  state,
  onSelect,
  onRun,
}: {
  issue: BacklogIssue;
  selected: boolean;
  /**
   * The issue's `repo:` targets a PLANNED (declared-but-absent) repo (issue 96,
   * ADR-0017): the row grays and offers no Run — it can't start until its repo
   * is created. Ungrays automatically once the repo appears.
   */
  planned: boolean;
  running: boolean;
  /**
   * This branch's merge-preview verdict (issue 104): shown as an advisory badge
   * beside `finished (unmerged)`. Null when there is no verdict (not a
   * finished-unmerged row, a later branch in the tracer slice, or git < 2.38).
   */
  previewVerdict: MergePreviewVerdict | null;
  /**
   * The issue's isolated-Run state derived from the on-disk `afk/` scan: `running`
   * (live in its worktree), `stranded` (Run ended without a done commit, issue
   * 22), `commit-failed` (finished but the commit never landed, issue 22), or
   * `finished-unmerged` (committed but not merged, issue 16). Null when it has no
   * worktree Run. Takes precedence over the main-checkout status/eligibility for
   * the row indicator, so a Run in flight, stranded, or awaiting merge never
   * looks like plain `open`.
   */
  worktreeRun: 'running' | 'stranded' | 'commit-failed' | 'finished-unmerged' | null;
  state: IssueMapState;
  onSelect: () => void;
  onRun?: () => void;
}): JSX.Element {
  // A worktree Run (in flight or finished-unmerged) is being worked/awaiting
  // merge — so it is neither "eligible" to start nor offered a Run button, even
  // though the main checkout still reads `open`.
  // A planned-repo issue can never start until its repo is created — treat it
  // like a worked row for Run-affordance purposes so no Run button shows.
  const worked = worktreeRun !== null || running || planned;
  const unmet = state.kind === 'blocked' ? state.unmet : [];
  return (
    <li
      className={`issue${selected ? ' issue--selected' : ''}${planned ? ' issue--planned' : ''}`}
      onClick={onSelect}
    >
      {/* Leading status dot (approved mock): the at-a-glance readiness signal —
          red blocked, teal ready, green done, amber wip, violet awaiting-merge —
          so the backlog's state reads down the left edge without parsing badges. */}
      <StatusDot
        tone={rowDotTone(state, worktreeRun, running, planned)}
        label={rowDotLabel(state, worktreeRun, running, planned)}
      />
      <span className="issue__id">{String(issue.id).padStart(2, '0')}</span>
      <span className="issue__title">{stripId(issue.title)}</span>
      <span className="issue__tags">
        {/* Every signal on the shared Badge primitive (issue 127, ADR-0020) so
            the Map reads consistently with the rest of the app in both themes. */}
        {issue.hitl && <Badge tone="amber">HITL</Badge>}
        <Badge tone={kindTone(issue)}>{kindLabel(issue)}</Badge>
        {planned && (
          <Badge
            tone="neutral"
            title="Targets a planned repo — declared but not yet created; can't run until it exists"
          >
            planned
          </Badge>
        )}
        {/* Compact dependency signal (mock: "✕ 122"): the unmet blockers, so
            "what is this waiting on" is answerable without opening the row. */}
        {unmet.length > 0 && (
          <span
            className="issue__deps"
            title={`Blocked: waiting on ${unmet.map((d) => depLabel(d)).join(', ')}`}
          >
            ✕ {unmet.map((d) => String(d.id).padStart(2, '0')).join(', ')}
          </span>
        )}
        {state.kind === 'done' && <Badge tone="green">done</Badge>}
        {state.kind === 'wip' && <Badge tone="amber">wip</Badge>}
        {state.kind === 'blocked' && (
          <Badge
            tone="red"
            title={`Blocked: waiting on ${state.unmet.map((d) => depLabel(d)).join(', ')}`}
          >
            blocked
          </Badge>
        )}
        {state.kind === 'waiting-on-merge' && !worked && (
          <Badge
            tone="violet"
            title={`Waiting on the auto-merge lane to land issue ${state.mergeIssueId}`}
          >
            waiting on merge of {String(state.mergeIssueId).padStart(2, '0')}
          </Badge>
        )}
        {state.kind === 'eligible' && !worked && <Badge tone="teal">ready</Badge>}
        {worktreeRun === 'finished-unmerged' ? (
          <>
            <Badge
              tone="violet"
              title="This Run's work is committed on its afk/ branch but not yet merged into main"
            >
              finished (unmerged)
            </Badge>
            {/* Merge preview (issues 104 & 105): advisory — the branch's verdict
                in the full sequential merge (clean / conflicts / blocked behind
                NN), without pressing Merge. */}
            {previewVerdict && <MergePreviewBadge verdict={previewVerdict} />}
          </>
        ) : worktreeRun === 'commit-failed' ? (
          <Badge
            tone="red"
            title="This Run finished but its work could not be committed to the afk/ branch — discard it from the bar above"
          >
            commit failed
          </Badge>
        ) : worktreeRun === 'stranded' ? (
          <Badge
            tone="amber"
            title="This Run ended without committing done; its worktree is stranded — discard it from the bar above"
          >
            stranded
          </Badge>
        ) : worktreeRun === 'running' || running ? (
          <Badge
            tone="teal"
            title={
              worktreeRun === 'running'
                ? 'A Run is live in this issue’s worktree'
                : 'A Run is in progress'
            }
          >
            running{worktreeRun === 'running' ? ' (in-worktree)' : ''}
          </Badge>
        ) : (
          state.kind === 'eligible' &&
          !planned &&
          onRun && (
            <button
              className="run-btn run-btn--row"
              title="Start a Run on this issue"
              onClick={(e) => {
                e.stopPropagation();
                onRun();
              }}
            >
              ▶ Run
            </button>
          )
        )}
      </span>
    </li>
  );
}

/** Upstream/downstream dependency edges plus the blocked reason for one issue. */
function DependencySection({
  issue,
  issues,
  finishedUnmergedIds = [],
}: {
  issue: BacklogIssue;
  issues: BacklogIssue[];
  finishedUnmergedIds?: number[];
}): JSX.Element | null {
  const state = deriveIssueState(issue, issues, finishedUnmergedIds);
  const downstream = dependents(issue, issues);

  if (issue.dependsOn.length === 0 && downstream.length === 0) return null;

  return (
    <div className="map__detail-deps">
      {state.kind === 'blocked' && (
        <div className="map__blocked">
          Blocked — waiting on {state.unmet.map((d) => depLabel(d)).join(', ')}
        </div>
      )}
      {state.kind === 'waiting-on-merge' && (
        <div className="map__blocked">
          Waiting on merge of {String(state.mergeIssueId).padStart(2, '0')}
        </div>
      )}
      {state.kind === 'eligible' && (
        <div className="map__eligible">Eligible — all dependencies are done.</div>
      )}
      {issue.dependsOn.length > 0 && (
        <div className="map__edges">
          <span className="map__edges-label">depends on</span>
          {issue.dependsOn.map((depId) => {
            const dep = issues.find((i) => i.id === depId);
            const met = dep?.status === 'done';
            return (
              <Badge
                key={depId}
                tone={met ? 'green' : 'amber'}
                title={dep ? dep.title : 'missing from backlog'}
              >
                {met ? '✓' : '○'} {String(depId).padStart(2, '0')}
                {dep ? ` (${dep.status})` : ' (missing)'}
              </Badge>
            );
          })}
        </div>
      )}
      {downstream.length > 0 && (
        <div className="map__edges">
          <span className="map__edges-label">blocks</span>
          {downstream.map((id) => (
            <Badge key={id} tone="teal">
              {String(id).padStart(2, '0')}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The interactive HITL checklist (issue 156): the parked issue's steps as
 * real tickable checkboxes, in order. Renders an empty state — never an
 * error — when the Receipt/body carries no checklist.
 *
 * Closing a HITL issue is a first-class HUMAN action (issue 195): the human
 * can mark it `done` straight from the panel without draining/parking it first
 * (`canMarkDone` — true for any non-`done` status). When the issue HAS a
 * checklist, the flip stays gated behind all-checked ("Mark verified & done") —
 * the sign-off still means "I walked the steps". When it has NO checklist (a
 * never-drained walkthrough, or one whose steps live only in prose), there is
 * nothing to tick, so a plain "Mark done" button is offered directly.
 */
function ChecklistSection({
  items,
  checked,
  loaded,
  busy,
  error,
  onToggle,
  canMarkDone,
  onMarkDone,
  markDoneBusy,
  markDoneError,
}: {
  items: ChecklistItem[];
  checked: boolean[];
  loaded: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (index: number) => void;
  canMarkDone: boolean;
  onMarkDone: () => void;
  markDoneBusy: boolean;
  markDoneError: string | null;
}): JSX.Element {
  const hasItems = items.length > 0;
  const allDone = loaded && allChecked(checked, items.length);
  // With a checklist, verification means all-checked; with none, there is
  // nothing to verify, so the human may close it directly.
  const offerMarkDone = canMarkDone && (!hasItems || allDone);

  const markDoneButton = offerMarkDone ? (
    <div className="map__checklist-done">
      <button
        className="map__issue-op map__issue-op--save"
        onClick={onMarkDone}
        disabled={markDoneBusy}
      >
        {markDoneBusy
          ? 'Marking done…'
          : hasItems
            ? '✓ Mark verified & done'
            : '✓ Mark done'}
      </button>
    </div>
  ) : null;

  if (!hasItems) {
    return (
      <div className="map__checklist">
        <div className="map__checklist-empty">
          No checklist steps found in this issue's Receipt or body.
        </div>
        {markDoneButton}
        {markDoneError && <div className="map__checklist-error">{markDoneError}</div>}
      </div>
    );
  }

  return (
    <div className="map__checklist">
      <span className="map__checklist-label">Verification checklist</span>
      <ul className="map__checklist-items">
        {items.map((item, index) => (
          <li key={index} className="map__checklist-item">
            <label>
              <input
                type="checkbox"
                checked={checked[index] ?? false}
                disabled={!loaded || busy}
                onChange={() => onToggle(index)}
              />
              {item.text}
            </label>
          </li>
        ))}
      </ul>
      {error && <div className="map__checklist-error">{error}</div>}
      {markDoneButton}
      {markDoneError && <div className="map__checklist-error">{markDoneError}</div>}
    </div>
  );
}

/** "03 — Run one issue … (wip)" for a blocked reason. */
function depLabel(dep: UnmetDependency): string {
  const id = String(dep.id).padStart(2, '0');
  const title = dep.title ? ` ${stripId(dep.title)}` : '';
  return `${id}${title} (${dep.status})`;
}

type WorktreeRunState = 'running' | 'stranded' | 'commit-failed' | 'finished-unmerged' | null;

/**
 * The leading status dot (issue 127, approved mock): a small filled circle whose
 * tone is the row's derived readiness — so the backlog's shape reads down the
 * left edge at a glance. The textual state still rides a Badge to its right.
 */
function StatusDot({ tone, label }: { tone: BadgeTone; label: string }): JSX.Element {
  return <span className={`issue__dot issue__dot--${tone}`} title={label} aria-label={label} />;
}

/** The dot tone for a row: worktree-Run state wins over the main-checkout state
 *  (a live / awaiting-merge Run never reads as plain open), else the derived
 *  state — red blocked, teal ready, green done, amber wip, violet unmerged. */
function rowDotTone(
  state: IssueMapState,
  worktreeRun: WorktreeRunState,
  running: boolean,
  planned: boolean,
): BadgeTone {
  if (planned) return 'neutral';
  if (worktreeRun === 'stranded') return 'amber';
  if (worktreeRun === 'commit-failed') return 'red';
  if (worktreeRun === 'finished-unmerged') return 'violet';
  if (worktreeRun === 'running' || running) return 'teal';
  switch (state.kind) {
    case 'done':
      return 'green';
    case 'wip':
      return 'amber';
    case 'eligible':
      return 'teal';
    case 'blocked':
      return 'red';
    case 'waiting-on-merge':
      return 'violet';
  }
}

/** A short human label for the dot's tooltip, mirroring its tone. */
function rowDotLabel(
  state: IssueMapState,
  worktreeRun: WorktreeRunState,
  running: boolean,
  planned: boolean,
): string {
  if (planned) return 'planned repo — not yet runnable';
  if (worktreeRun === 'stranded') return 'stranded Run';
  if (worktreeRun === 'commit-failed') return 'commit failed';
  if (worktreeRun === 'finished-unmerged') return 'finished (unmerged)';
  if (worktreeRun === 'running' || running) return 'running';
  switch (state.kind) {
    case 'done':
      return 'done';
    case 'wip':
      return 'wip';
    case 'eligible':
      return 'ready to Run';
    case 'blocked':
      return 'blocked';
    case 'waiting-on-merge':
      return `waiting on merge of ${String(state.mergeIssueId).padStart(2, '0')}`;
  }
}

/**
 * The advisory merge-preview badge (issues 104, 105, 106 & 107, ADR-0018): `merges
 * clean`, `conflicts (files…)`, `blocked behind NN`, `won't merge — adds install
 * artifacts (paths…)`, `recalculating…`, or (while the repo is mid-merge, issue
 * 107) `merge in progress` — driven by the pure `previewBadge` display selector.
 * The conflict file list, the blocking branch, and the offending artifact paths
 * are in both the label and the tooltip so the blast radius is visible without
 * pressing Merge.
 */
function MergePreviewBadge({ verdict }: { verdict: MergePreviewVerdict }): JSX.Element {
  const badge = previewBadge(verdict);
  return (
    <Badge tone={previewTone(badge.tone)} title={badge.title}>
      {badge.label}
    </Badge>
  );
}

/** Map a merge-preview verdict tone onto a shared-Badge tone (issue 127): clean
 *  lands green, conflicts/artifact red, blocked-behind amber (downstream), and
 *  recalculating/suspended neutral (no live verdict). */
function previewTone(tone: ReturnType<typeof previewBadge>['tone']): BadgeTone {
  switch (tone) {
    case 'clean':
      return 'green';
    case 'conflicts':
    case 'artifact':
      return 'red';
    case 'blocked':
      return 'amber';
    default:
      return 'neutral';
  }
}

/** The shared-Badge tone for an issue's batch classification: in-batch reads
 *  teal (part of the active feature), standalone violet, out-of-batch neutral. */
function kindTone(issue: BacklogIssue): BadgeTone {
  if (issue.inBatch) return 'teal';
  if (issue.standalone) return 'violet';
  return 'neutral';
}

function kindLabel(issue: BacklogIssue): string {
  if (issue.inBatch) return 'in-batch';
  if (issue.standalone) return 'standalone';
  return 'out-of-batch';
}

/** Titles usually start with "NN — "; drop that since the row shows the id. */
function stripId(title: string): string {
  return title.replace(/^\d+\s*[—-]\s*/, '');
}
