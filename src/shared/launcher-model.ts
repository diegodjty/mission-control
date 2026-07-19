/**
 * Launcher model (PURE) — the front door's decisions (issue 81, ADR-0016).
 *
 * Every empty Window IS the Launcher: *what are we doing?* This module holds
 * the pure pieces behind its three fully-wired actions:
 *
 *  - **Quick fix** — turn one sentence into a well-formed STANDALONE issue
 *    (`## Source`, no `## Parent`) in a project's workbench backlog: the next
 *    free issue number, the `NN-slug.md` file name, and the full markdown
 *    content. The content round-trips through `backlog-model`'s `buildBacklog`
 *    as `standalone: true, status: 'open'` — the same shape the afk-issue-
 *    runner skill picks up as fallthrough work.
 *  - **Continue** — the truthful one-line state for a recent project ("3 open
 *    · 1 parked awaiting you"), and the recency ordering of the project list.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a
 * value, never a throw. The file writes / registry reads live in the main
 * process; the UI in `renderer/src/Launcher.tsx`.
 */

import type { LauncherProject, ProjectCardView, RunTarget } from './ipc-contract';
import type { PipelineStage } from './project-registry';

/** Matches issue files (`NN-slug.md`); everything else is not an issue. */
const ISSUE_FILE = /^(\d+)-.+\.md$/;

/**
 * The next free issue number given a backlog directory's file names: one past
 * the highest `NN` prefix present (gaps are never reused — numbers are
 * history), or 1 for an empty/issue-less directory. Non-issue names
 * (CONFIG.md, completions/, dotfiles) are ignored.
 */
export function nextIssueNumber(fileNames: readonly string[]): number {
  let max = 0;
  for (const name of fileNames) {
    const match = ISSUE_FILE.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

/** Issue numbers are zero-padded to at least two digits (`05`, `112`). */
export function padIssueNumber(id: number): string {
  return String(id).padStart(2, '0');
}

/**
 * A file-name slug for a quick-fix sentence: lowercased, non-alphanumerics
 * collapsed to `-`, capped at a few words so the file name stays scannable.
 * A sentence with nothing usable degrades to `quick-fix`, never ''.
 */
export function quickFixSlug(sentence: string): string {
  const words = (typeof sentence === 'string' ? sentence : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  const slug = words.join('-').slice(0, 48).replace(/-+$/, '');
  return slug.length > 0 ? slug : 'quick-fix';
}

/** The `NN-slug.md` file name for a quick-fix issue. */
export function quickFixFileName(id: number, sentence: string): string {
  return `${padIssueNumber(id)}-${quickFixSlug(sentence)}.md`;
}

export interface QuickFixIssueInput {
  /** The issue number this file claims (from `nextIssueNumber`). */
  id: number;
  /** The user's one sentence, verbatim (newlines are collapsed). */
  sentence: string;
  /** The creation date, `YYYY-MM-DD`, for the `## Source` line. */
  date: string;
}

/**
 * The full markdown content of a quick-fix issue: `status: open`, no
 * dependencies, a `## Source` section naming the Launcher and date, and NO
 * `## Parent` — which is exactly what makes it standalone (backlog-model) and
 * afk-eligible as fallthrough work (the skill's eligibility rule).
 */
export function buildQuickFixIssue(input: QuickFixIssueInput): string {
  const sentence = (typeof input.sentence === 'string' ? input.sentence : '')
    .replace(/\s+/g, ' ')
    .trim();
  const num = padIssueNumber(input.id);
  return [
    '---',
    'status: open',
    'depends_on: []',
    '---',
    '',
    `# ${num} — ${sentence}`,
    '',
    '## Source',
    '',
    `Launcher quick fix, ${input.date}`,
    '',
    '## What to build',
    '',
    sentence,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The one-sentence request above is implemented and verified per the afk-issue-runner verify gate.',
    '',
  ].join('\n');
}

/**
 * The `YYYY-MM-DD` stamp for a quick-fix `## Source` line: the user's LOCAL
 * calendar day (issue 88 — a UTC slice made an evening quick fix land
 * "tomorrow" for anyone west of UTC).
 */
export function localDateStamp(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The project identity a quick-fix Run is built from (a LauncherProject subset). */
export interface QuickFixRunProject {
  /** The repo the Run's session starts in (the project's default repo). */
  defaultRepoPath: string;
  /** Where the created issue file lives. */
  issuesRoot: string;
  /** Where the Run's Receipt lands. */
  completionsRoot: string;
}

/** The created issue, as QuickFixCreate handed it back. */
export interface QuickFixCreatedIssue {
  issueId: number;
  fileName: string;
  title: string;
}

/**
 * The Run target for a quick fix's Run-now (issue 88, walkthrough-86 finding):
 * built ENTIRELY from the created issue's project — the project the issue was
 * just written to. The Window's active project is deliberately not an input:
 * Run-now used to re-derive paths from window-active state, so an issue
 * created in project A could spawn a Run with project B's repo + workbench
 * paths (the Worker then rightly refused). The created issue's identity is
 * carried end-to-end instead; the mismatch is unrepresentable here.
 */
export function quickFixRunTarget(
  project: QuickFixRunProject,
  issue: QuickFixCreatedIssue,
): RunTarget {
  return {
    issueId: issue.issueId,
    issueFileName: issue.fileName,
    issueTitle: issue.title,
    projectPath: project.defaultRepoPath,
    workbench: {
      issuesRoot: project.issuesRoot,
      completionsRoot: project.completionsRoot,
    },
  };
}

// ---------------------------------------------------------------------------
// ＋ Start something — the two per-Project entry verbs (issue 116, ADR-0019)
// ---------------------------------------------------------------------------

/**
 * The three verbs ＋ Start something offers on the Map (issue 116, ADR-0019;
 * `talk` added by issue 168): `grill` (plan a feature), `simple` (a
 * one-sentence standalone issue), and `talk` (a warm bare Pane scoped to this
 * project, no issue claimed).
 */
export type StartVerb = 'grill' | 'simple' | 'talk';

/**
 * The button labels, EXACTLY as ADR-0019 names them — the single source of
 * truth for both the Map's empty-state chooser and its populated ＋ Start
 * something control, so the two never drift.
 */
export const START_VERB_LABELS: Record<StartVerb, string> = {
  grill: 'Grill a feature',
  simple: 'Simple issue',
  talk: 'Just talk',
};

/**
 * Where a ＋ Start something verb routes for a Project (issue 116): the pure
 * verb→target that `startSomething` resolves. `route` picks the existing
 * machinery — `planning` opens the Planning view (grill → PRD → issues),
 * `quick-fix` opens the one-sentence quick-fix form (Run-now / leave-queued),
 * `talk` opens the same warm bare Pane the Launcher home's Just talk offers
 * (issue 168) — and the `project` is carried through so the renderer
 * dispatches on the verdict instead of re-deriving anything from
 * window-active state (the same end-to-end-identity discipline as
 * `quickFixRunTarget`).
 */
export interface StartTarget<P> {
  /** `planning` → the Planning view; `quick-fix` → the quick-fix form; `talk` → a warm bare Pane. */
  route: 'planning' | 'quick-fix' | 'talk';
  /** The verb's label (from `START_VERB_LABELS`), echoed for the affordance. */
  label: string;
  /** The Project the verb acts on, unchanged. */
  project: P;
}

/**
 * Resolve a ＋ Start something verb to its route for `project` (issue 116,
 * folded in alongside `quickFixRunTarget`; `talk` added by issue 168). PURE
 * and total: `grill` routes to the Planning view, `talk` to a warm bare Pane,
 * every other verb (`simple`) to the quick-fix form; the project is passed
 * straight through. This slice only relocates and re-labels — neither route
 * is a new flow, so the resolver names a destination and nothing more.
 */
export function startSomething<P>(verb: StartVerb, project: P): StartTarget<P> {
  const route = verb === 'grill' ? 'planning' : verb === 'talk' ? 'talk' : 'quick-fix';
  return {
    route,
    label: START_VERB_LABELS[verb] ?? '',
    project,
  };
}

/**
 * The Quick fix dropdown's initial selection (issue 88): the project the user
 * is visibly on — the Window's active project, when it is one of the listed
 * workbench projects — or `''`, which the UI renders as an unchosen
 * "Pick a project…" placeholder that blocks submit. NEVER a silent
 * `projects[0]` default: that is exactly how a quick fix landed in whichever
 * project happened to sort first.
 */
export function quickFixDefaultDir(
  projects: readonly { workbenchDir: string }[],
  activeProjectKey: string | null,
): string {
  if (activeProjectKey === null) return '';
  const match = projects.find((p) => p.workbenchDir === activeProjectKey);
  return match?.workbenchDir ?? '';
}

/**
 * The names of every workbench project the Launcher should list — the union of
 * two truths that only coincide for repo-full projects:
 *
 *  - **registry-active projects** — every distinct project named by a
 *    `status: active` registry entry (one workbench project may have several
 *    member repos, hence the dedupe); and
 *  - **repo-less project directories** — every `~/Workbench/<dir>` that is a
 *    repo-less project (a `CONFIG.md` with an empty `repos:` map), which by
 *    definition has no registry entry to be found under the first source.
 *
 * A **repo-less project** (ADR-0017) is exactly the case these diverge: New
 * project writes its `~/Workbench/<dir>` skeleton but NO registry entry
 * (registration is deferred until a repo appears via self-heal), so a
 * registry-only list renders it invisible even though its directory exists —
 * the "created it, but it shows in no list, yet re-creating is refused because
 * it already exists" bug. Listing the union makes a just-created repo-less
 * project appear immediately; the two collapse back into one the moment a repo
 * is registered. (The edge intentionally passes only *repo-less* directories as
 * the second source, so a repo-full project whose registry entries were removed
 * — issue 92, removal is registry-only — does not reappear.) Returns a deduped,
 * ascending set (the caller re-orders by recency), so the contract is
 * deterministic and pure.
 */
export function workbenchProjectNames(
  activeRegistryProjects: readonly string[],
  workbenchProjectDirs: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const name of activeRegistryProjects) if (typeof name === 'string' && name.length > 0) names.add(name);
  for (const dir of workbenchProjectDirs) if (typeof dir === 'string' && dir.length > 0) names.add(dir);
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Continue — truthful one-line project state + recency ordering
// ---------------------------------------------------------------------------

/** A backlog's status counts, as the Launcher list carries them. */
export interface BacklogCounts {
  open: number;
  wip: number;
  done: number;
}

/**
 * The one-line state a Continue row shows for a project. Truthful and quiet:
 * only what is non-zero, with parked HITL items (awaiting the human) called
 * out explicitly; a fully-done backlog says so; an empty one says so.
 */
export function projectStateLine(counts: BacklogCounts, parked: number): string {
  const open = Math.max(0, counts?.open ?? 0);
  const wip = Math.max(0, counts?.wip ?? 0);
  const done = Math.max(0, counts?.done ?? 0);
  const parks = Math.max(0, parked ?? 0);

  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (wip > 0) parts.push(`${wip} wip`);
  if (parks > 0) parts.push(`${parks} parked awaiting you`);
  if (parts.length > 0) return parts.join(' · ');
  if (done > 0) return `all ${done} done`;
  return 'empty backlog';
}

/** The subset of a Launcher project row the ordering needs. */
export interface RecencySortable {
  /** ISO-8601 stamp of the most recent backlog/Receipt change, or null. */
  lastActivity: string | null;
  /** Display label — the deterministic tiebreak. */
  label: string;
}

/**
 * Order Continue's project list most-recently-active first; projects with no
 * observable activity sort last, alphabetically. Stable and pure — returns a
 * new array, never mutates the input.
 */
export function sortLauncherProjects<T extends RecencySortable>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    const aStamp = a.lastActivity ?? '';
    const bStamp = b.lastActivity ?? '';
    if (aStamp !== bStamp) return aStamp < bStamp ? 1 : -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Project grid — the project-first home (issue 115, ADR-0019)
// ---------------------------------------------------------------------------
//
// The pure core behind the home page's noun-first chooser: given the per-
// Project signals the portfolio aggregator already gathers (this slice: the
// backlog counts + last-activity `LauncherProject` carries), shape each card's
// display labels and order the grid. Written as a seam so issue 118 can add
// HITL / liveness / stage signals — and the attention-float ordering — without
// reshaping the aggregator or the renderer.

/**
 * The home grid's two renderings (issue 119): the default `cards` grid, or a
 * dense one-row-per-Project `list`. The choice is user-toggled and persisted.
 */
export type ProjectViewMode = 'cards' | 'list';

/**
 * The localStorage key the cards⇄list choice persists under (issue 119) —
 * mirroring `mc.theme` / `mc.dispatcherWidth`. Cards is the default on first
 * run.
 */
export const PROJECT_VIEW_KEY = 'mc.projectView';

/**
 * Normalize a persisted (or absent / garbage) `mc.projectView` value to a view
 * mode. ONLY the exact string `'list'` selects the dense list; everything else
 * — `null` (never set), `''`, an old or unknown value, wrong case — falls back
 * to `'cards'`, so cards is the first-run default and a corrupt stored value can
 * never wedge the grid into an unknown state. Pure and total.
 */
export function normalizeProjectView(raw: string | null | undefined): ProjectViewMode {
  return raw === 'list' ? 'list' : 'cards';
}

/**
 * The `open · wip · done` tally a project card shows. Unlike `projectStateLine`
 * (which hides zeros for a quiet Continue row), a card names ALL THREE counts
 * even when zero — the grid is an at-a-glance portfolio, so "0 open · 0 wip ·
 * 0 done" is a truthful "nothing here yet", not an omitted fact. Negatives and
 * absent fields clamp to 0; pure and total.
 */
export function cardCountsLabel(counts: BacklogCounts): string {
  const open = Math.max(0, counts?.open ?? 0);
  const wip = Math.max(0, counts?.wip ?? 0);
  const done = Math.max(0, counts?.done ?? 0);
  return `${open} open · ${wip} wip · ${done} done`;
}

/**
 * A relative last-activity label for a card ("just now", "5m ago", "3h ago",
 * "2d ago", "3w ago", "5mo ago", "2y ago") from an ISO stamp and a reference
 * `now`. Null / empty / unparseable stamps degrade to "no activity yet", and a
 * future (clock-skewed) stamp reads "just now" — the function is total, never
 * throws. Timezone-free: it measures a DURATION, so the local-calendar-day
 * concern that bit the quick-fix `## Source` stamp does not apply here.
 */
export function relativeActivityLabel(iso: string | null, now: Date): string {
  if (typeof iso !== 'string' || iso.length === 0) return 'no activity yet';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'no activity yet';
  const sec = Math.floor((now.getTime() - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

// ---------------------------------------------------------------------------
// Full card stats — needs-you / liveness / stage / attention-float (issue 118)
// ---------------------------------------------------------------------------
//
// Issue 118 enriches the tracer's minimal card (open·wip·done + last-activity)
// to the full at-a-glance read, and FLOATS the Projects that want attention to
// the top. It adds three derived card fields — the needs-you (parked HITL)
// count, the liveness label, and the pipeline-stage badge — and replaces the
// recency-only comparator with the attention-float order. Each new field is fed
// by a signal the aggregator JOINS (parked HITL from the Inbox's attention
// watch, live-Run count from run-coordinator/Dispatcher state, stage from the
// registry, repo-less from the project identity); the pure model still owns all
// shaping and ordering.

/**
 * The extra per-Project signals the portfolio aggregator joins for issue 118 —
 * the ones `LauncherProject` (backlog counts + last-activity) does not already
 * carry. Gathered by the main-process aggregator; shaped here.
 */
export interface ProjectCardSignals {
  /** Count of live Runs (run-coordinator / Dispatcher state) — drives "N running" and the float. */
  liveRuns: number;
  /** Parked HITL count (attention-hub-model) — the attention-float's second tier. */
  parkedHitl: number;
  /**
   * Needs-you count (attention-hub-model, issue 125): this Project's actionable
   * attention items. The card's needs-you badge, and the SAME number the rail
   * badge and the unified attention surface read for this Project — so the
   * three can never disagree. Distinct from `parkedHitl`, which counts only
   * parked HITL and stays the ordering tier issue 118 defined.
   */
  needsYou: number;
  /** The Project's pipeline stage (registry / CONFIG) — the stage badge. */
  stage: PipelineStage;
  /** True for a repo-less Project (no member repos) — enables the "not started" state. */
  repoless: boolean;
}

/**
 * The pipeline-stage badge labels — the single source of truth for a stage's
 * display text on a card (the raw stage keys are `planning → backlog →
 * executing → merge-qa`).
 */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  planning: 'Planning',
  backlog: 'Backlog',
  executing: 'Executing',
  'merge-qa': 'Merge / QA',
};

/** A stage's badge label; '' for an unknown stage (total, never throws). */
export function stageBadgeLabel(stage: PipelineStage): string {
  return STAGE_LABELS[stage] ?? '';
}

/** The inputs the liveness label is derived from (issue 118). */
export interface LivenessInput {
  /** Count of live Runs for this Project. */
  liveRuns: number;
  /** The backlog status counts (for the "not started" empty-backlog test). */
  counts: BacklogCounts;
  /** ISO-8601 last-activity stamp, or null. */
  lastActivity: string | null;
  /** True when this is a repo-less Project (no member repos). */
  repoless: boolean;
  /** Reference "now" for the relative label. */
  now: Date;
}

/**
 * A card's liveness label (issue 118), in precedence order:
 *   1. `"N running"` when at least one Run is live — the strongest signal.
 *   2. `"not started"` for a repo-less Project whose backlog is still empty (a
 *      just-created project with no code and no issues yet).
 *   3. otherwise the relative last-activity label (an idle Project's recency).
 * Total and pure: a negative/absent live count clamps to zero, and the
 * relative-label fallback never throws.
 */
export function livenessLabel(input: LivenessInput): string {
  const runs = Math.max(0, input?.liveRuns ?? 0);
  if (runs >= 1) return `${runs} running`;
  const open = Math.max(0, input?.counts?.open ?? 0);
  const wip = Math.max(0, input?.counts?.wip ?? 0);
  const done = Math.max(0, input?.counts?.done ?? 0);
  if (input?.repoless && open + wip + done === 0) return 'not started';
  return relativeActivityLabel(input?.lastActivity ?? null, input.now);
}

/** The subset of a card the attention-float comparator orders by (issue 118). */
export interface AttentionFloatSortable extends RecencySortable {
  /** Live-Run count — the top ordering tier (desc). */
  liveRuns: number;
  /** Parked HITL count — the second ordering tier (desc). */
  parkedHitl: number;
}

/**
 * The grid ordering (issue 118): the ATTENTION-FLOAT order — live Runs desc →
 * parked HITL desc → last-activity desc → label asc — so the Project most
 * wanting the human's attention is first, and quiet/no-activity projects sink
 * (alphabetically) to the bottom. This replaces issue 115's recency-only
 * comparator; the aggregator and renderer call this and never re-sort, so the
 * whole ordering lives in one place. With no live Runs and no parks it degrades
 * exactly to the recency sort issue 115 shipped. Stable and pure — returns a
 * new array, never mutates the input.
 */
export function orderProjectCards<T extends AttentionFloatSortable>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => {
    const aRuns = Math.max(0, a.liveRuns ?? 0);
    const bRuns = Math.max(0, b.liveRuns ?? 0);
    if (aRuns !== bRuns) return bRuns - aRuns; // live Runs desc
    const aParked = Math.max(0, a.parkedHitl ?? 0);
    const bParked = Math.max(0, b.parkedHitl ?? 0);
    if (aParked !== bParked) return bParked - aParked; // parked HITL desc
    const aStamp = a.lastActivity ?? '';
    const bStamp = b.lastActivity ?? '';
    if (aStamp !== bStamp) return aStamp < bStamp ? 1 : -1; // recency desc, no-activity last
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; // deterministic tiebreak
  });
}

/**
 * Shape the gathered per-Project signals into the home grid's ordered cards —
 * the pure core the portfolio aggregator delegates ALL shaping and ordering to.
 * Given the `LauncherProject` signals `listLauncherProjects` gathers, a
 * `signalsFor` lookup of the joined issue-118 signals (live Runs, parked HITL,
 * stage, repo-less), and a reference `now`, it derives each card's display
 * fields and returns a `ProjectCardView[]` in attention-float order. A superset
 * mapping: every raw `LauncherProject` field survives (the renderer clicks a
 * card and hands its `workbenchDir` to the in-place switch), with the card-model
 * fields added on top.
 */
export function buildProjectGrid(
  projects: readonly LauncherProject[],
  signalsFor: (project: LauncherProject) => ProjectCardSignals,
  now: Date,
): ProjectCardView[] {
  const cards = projects.map((p): ProjectCardView => {
    const signals = signalsFor(p);
    const liveRuns = Math.max(0, signals?.liveRuns ?? 0);
    const parkedHitl = Math.max(0, signals?.parkedHitl ?? 0);
    const needsYou = Math.max(0, signals?.needsYou ?? 0);
    const stage: PipelineStage = signals?.stage ?? 'backlog';
    const repoless = signals?.repoless ?? false;
    return {
      ...p,
      countsLabel: cardCountsLabel(p.counts),
      activityLabel: relativeActivityLabel(p.lastActivity, now),
      liveRuns,
      parkedHitl,
      needsYou,
      livenessLabel: livenessLabel({ liveRuns, counts: p.counts, lastActivity: p.lastActivity, repoless, now }),
      stage,
      stageLabel: stageBadgeLabel(stage),
    };
  });
  return orderProjectCards(cards);
}
