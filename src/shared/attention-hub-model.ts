/**
 * Attention hub model (PURE) — issue 125, ADR-0020.
 *
 * The SINGLE source of truth for cross-project attention. It absorbs the two
 * models that used to answer "where am I needed?" separately (the old
 * `attention-model` and `inbox-model`), so the rail's needs-you badge, the
 * Launcher cards' needs-you counts, and the unified attention surface can
 * never disagree — they all read the numbers this module derives.
 *
 * Two layers live here:
 *
 *  1. **Per-project derivation** (`deriveAttention`) — turns one project's
 *     parsed workbench artifacts (backlog, Receipts, memory / HUMAN-SETUP /
 *     journal facts, self-heal input) into typed **attention items**:
 *
 *       - `hitl-park` — an `hitl: true` issue at `wip` whose latest Receipt
 *         declares `needs-verification`: a park awaiting the human's sign-off.
 *         A `needs-verification` Receipt on a non-HITL issue is NOT a park.
 *       - `curator-proposal` — `memory/CORE.proposed.md` exists: a curated CORE
 *         change awaiting human review (CORE edits always need sign-off).
 *       - `blocked-run` — an issue whose latest Receipt declares `blocked` while
 *         the issue isn't `done`: a Run stopped on something only the human can
 *         unstick.
 *       - `setup-gate` — an unchecked HUMAN-SETUP checkbox whose text names an
 *         issue that is open/wip in this backlog. Only explicit references count
 *         (`Unblocks: 07, 08`, `issue 12`) — a bare number in prose is not one.
 *       - `new-repo-candidate` — a git repo APPEARED under the project's
 *         workspace root but is not yet registered (issue 95, ADR-0017).
 *       - `briefing` — journal entries newer than the caller-supplied last-seen
 *         stamp, rendered as quiet one-liners (never notifications, ADR-0012).
 *
 *     Each item carries the project, kind, an issue/file reference, one line of
 *     human text, and a **stable id** — the same inputs always derive the same
 *     ids, so re-derivation dedupes and resolved items simply disappear.
 *
 *  2. **Cross-project presentation** — the aggregated items (every project's,
 *     as the background watch collected them) shaped for the surface, the rail,
 *     and the cards: the briefing split out, the actionable items grouped by
 *     Project and ordered by urgency (**parked HITL first**), and the needs-you
 *     counts (total and per-project) every badge reads from. Plus the last-seen
 *     stamp operations behind the briefing filter and the workbench-path helper
 *     click-through hands to the normal open flow.
 *
 * "Latest Receipt" follows receipt-audit's latest-wins rule, keyed here on the
 * Receipt's declared `finished` stamp — completions files carry no capture time.
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a value,
 * never a throw. Malformed artifacts degrade to no item plus an explicit
 * `notes` entry — never a guess, never silence about a skip.
 */
import { EMPTY_BACKLOG, type Backlog, type BacklogIssue } from './backlog-model';
import type { ReceiptRecord } from './receipt-parser';
import { detectAppearedRepos, type RepoCandidate, type SelfHealInput } from './self-heal';

export type AttentionKind =
  | 'hitl-park'
  | 'curator-proposal'
  | 'curator-report'
  | 'blocked-run'
  | 'setup-gate'
  | 'new-repo-candidate'
  | 'briefing';

/** One thing that needs the human, ready for the cross-project surface. */
export interface AttentionItem {
  /** The workbench project directory name this item belongs to. */
  project: string;
  kind: AttentionKind;
  /** The issue the item is about, when it is about one. */
  issueId: number | null;
  /** Project-root-relative file reference (the thing to open/focus). */
  fileRef: string | null;
  /** One quiet human-readable line. Never multi-line. */
  text: string;
  /** Stable across re-derivation: `<project>:<kind>[:<discriminator>]`. */
  id: string;
  /**
   * For a `new-repo-candidate` only (null otherwise): the appeared repo to
   * register — its absolute path and a suggested short key. The surface's
   * one-click register action needs both; every other kind leaves it null.
   */
  candidate?: RepoCandidate | null;
}

/** A raw journal file: base name (`YYYY-MM-DD[-n].md`) and full content. */
export interface JournalFile {
  name: string;
  content: string;
}

/** One project's artifacts, as plain parsed values — the adapter reads fs. */
export interface AttentionInput {
  /** The workbench project directory name. */
  project: string;
  /** The parsed backlog (backlog-model's `buildBacklog`). */
  backlog: Backlog;
  /** Parsed Receipts from `completions/` (receipt-parser's `parseReceipt`). */
  receipts: readonly ReceiptRecord[];
  /** Whether `memory/CORE.proposed.md` exists. */
  coreProposedPresent: boolean;
  /** Raw `HUMAN-SETUP.md` content, or null when the file is absent. */
  humanSetup: string | null;
  /** Raw `memory/journal/` entries. */
  journal: readonly JournalFile[];
  /**
   * The caller's last-seen stamp for the briefing (ISO-8601), or null when
   * this app has never looked — every journal entry is then unseen.
   */
  lastSeen: string | null;
  /**
   * The self-heal detector's input (issue 95, ADR-0017): the workspace root's
   * top-level entries, this project's `repos:` map, and the registry — from
   * which appeared-but-unregistered repos become `new-repo-candidate` items.
   * Null/absent for a legacy or pre-0017 project (no workspace root to watch),
   * which then derives no candidates. The adapter gathers the facts.
   */
  selfHeal?: SelfHealInput | null;
}

export interface AttentionResult {
  /** Deterministically ordered: parks, proposal, blocked, gates, briefing. */
  items: AttentionItem[];
  /** Human-readable notes about malformed artifacts that derived no item. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** One line, bounded — an item's text must never become a pasted block. */
function oneLine(text: string, max = 160): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `issue 05 — slug` label, matching the house display convention. */
function issueLabel(issue: BacklogIssue): string {
  return `issue ${String(issue.id).padStart(2, '0')} — ${issue.slug}`;
}

/** A defensive array read: anything non-array degrades to empty. */
function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Receipts — latest declared outcome per issue (receipt-audit's rule, keyed
// on `finished` since completions files carry no capture time)
// ---------------------------------------------------------------------------

function latestReceiptsByIssue(
  receipts: readonly ReceiptRecord[],
  notes: string[],
): Map<number, ReceiptRecord> {
  const latest = new Map<number, ReceiptRecord>();
  for (const rec of receipts) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.issueId === null) {
      notes.push('a Receipt with no readable issue id was skipped');
      continue;
    }
    const prior = latest.get(rec.issueId);
    // Later `finished` wins; a missing stamp loses to any dated Receipt.
    if (!prior || (rec.finished ?? '') >= (prior.finished ?? '')) {
      latest.set(rec.issueId, rec);
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// (a) hitl-park + (c) blocked-run — Receipt-declared states on live issues
// ---------------------------------------------------------------------------

function deriveReceiptItems(
  project: string,
  backlog: Backlog,
  receipts: readonly ReceiptRecord[],
  notes: string[],
): AttentionItem[] {
  const issuesById = new Map(asArray(backlog?.issues).map((i) => [i.id, i]));
  const items: AttentionItem[] = [];

  for (const [issueId, rec] of latestReceiptsByIssue(receipts, notes)) {
    const issue = issuesById.get(issueId);
    if (!issue) {
      if (rec.outcome === 'blocked' || rec.outcome === 'needs-verification') {
        notes.push(
          `Receipt for issue ${issueId} declares ${rec.outcome}, but no such issue exists in the backlog — skipped`,
        );
      }
      continue;
    }

    if (rec.outcome === 'needs-verification' && issue.hitl && issue.status === 'wip') {
      items.push({
        project,
        kind: 'hitl-park',
        issueId,
        fileRef: `issues/${issue.fileName}`,
        text: `${issueLabel(issue)} is parked (HITL) — awaiting your verification`,
        id: `${project}:hitl-park:${issueId}`,
      });
    }

    if (rec.outcome === 'blocked' && issue.status !== 'done') {
      const detail = oneLine(rec.detail ?? '', 80);
      items.push({
        project,
        kind: 'blocked-run',
        issueId,
        fileRef: `issues/${issue.fileName}`,
        text: `${issueLabel(issue)} reported blocked${detail ? ` — ${detail}` : ''}`,
        id: `${project}:blocked-run:${issueId}`,
      });
    }
  }

  return items.sort((a, b) => (a.issueId ?? 0) - (b.issueId ?? 0));
}

// ---------------------------------------------------------------------------
// (d) setup-gate — unchecked HUMAN-SETUP boxes gating open/wip issues
// ---------------------------------------------------------------------------

const CHECKBOX = /^\s*-\s*\[([ xX])\]\s*(.+)$/;

/**
 * The issue ids a checkbox's text explicitly names: numbers in an
 * `Unblocks: …` list (up to the sentence's end) and `issue NN` references.
 * Bare numbers in prose ("Node 22") are deliberately NOT references.
 */
function namedIssueIds(text: string): number[] {
  const ids = new Set<number>();
  const unblocks = /unblocks\s*:\s*([^.\n]*)/i.exec(text);
  if (unblocks) {
    for (const m of unblocks[1].matchAll(/\d+/g)) ids.add(Number(m[0]));
  }
  for (const m of text.matchAll(/\bissues?\s+#?(\d+)/gi)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

/** Stable per-checkbox discriminator: the text, normalized and bounded. */
function checkboxKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

function deriveSetupGates(
  project: string,
  backlog: Backlog,
  humanSetup: string | null,
): AttentionItem[] {
  if (typeof humanSetup !== 'string' || humanSetup.length === 0) return [];

  const gateable = new Set(
    asArray(backlog?.issues)
      .filter((i) => i.status === 'open' || i.status === 'wip')
      .map((i) => i.id),
  );

  const items: AttentionItem[] = [];
  for (const line of humanSetup.split('\n')) {
    const box = CHECKBOX.exec(line);
    if (!box || box[1] !== ' ') continue; // checked (or not a checkbox) — done
    const text = box[2].trim();
    const gated = namedIssueIds(text).filter((id) => gateable.has(id));
    if (gated.length === 0) continue;
    items.push({
      project,
      kind: 'setup-gate',
      issueId: gated[0],
      fileRef: 'HUMAN-SETUP.md',
      text: `HUMAN-SETUP: "${oneLine(text, 60)}" gates issue${gated.length > 1 ? 's' : ''} ${gated.join(', ')}`,
      id: `${project}:setup-gate:${checkboxKey(text)}`,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// (e) briefing — journal entries newer than last-seen, as quiet one-liners
// ---------------------------------------------------------------------------

/** The entry's timestamp: its `Ended:` line, else the file name's date. */
function journalStamp(file: JournalFile): string | null {
  const ended = /^-\s*Ended\s*:\s*(\S+)/m.exec(file.content ?? '');
  if (ended) return ended[1];
  const fromName = /^(\d{4}-\d{2}-\d{2})/.exec(file.name ?? '');
  return fromName ? fromName[1] : null;
}

/** A quiet one-liner for a drain-journal entry: day + reason + run count. */
function journalLine(file: JournalFile): string {
  const day =
    /^(\d{4}-\d{2}-\d{2})/.exec(file.name)?.[1] ??
    /—\s*(\S+)/.exec(oneLine(file.content))?.[1] ??
    file.name;
  const reason = /^-\s*Reason\s*:\s*(.*)$/m.exec(file.content)?.[1]?.trim();
  const runs = (file.content.match(/^-\s+.+:\s+(completed|parked|blocked)/gm) ?? []).length;
  const parts = [reason ? oneLine(reason, 80) : null, runs > 0 ? `${runs} run${runs > 1 ? 's' : ''}` : null]
    .filter((p): p is string => p !== null)
    .join('; ');
  return `${day}${parts ? ` — ${parts}` : ''}`;
}

function deriveBriefing(
  project: string,
  journal: readonly JournalFile[],
  lastSeen: string | null,
  notes: string[],
): AttentionItem[] {
  const fresh: { item: AttentionItem; stamp: string }[] = [];
  for (const file of asArray(journal)) {
    if (!file || typeof file.name !== 'string' || typeof file.content !== 'string') continue;
    // Only markdown files are journal entries — a `.gitkeep` (the scaffold's
    // placeholder) or stray dotfile is not "something you haven't seen".
    if (!/\.md$/i.test(file.name)) continue;
    const stamp = journalStamp(file);
    if (stamp === null) {
      if (lastSeen !== null) {
        notes.push(`journal entry ${file.name} has no readable date — left out of the briefing`);
        continue;
      }
      // Never looked: everything counts as unseen, even an undated entry.
      fresh.push({ item: briefingItem(project, file), stamp: '' });
      continue;
    }
    if (lastSeen !== null && stamp <= lastSeen) continue;
    fresh.push({ item: briefingItem(project, file), stamp });
  }
  // Newest first — the briefing reads top-down from "just now" backwards.
  fresh.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return fresh.map((f) => f.item);
}

function briefingItem(project: string, file: JournalFile): AttentionItem {
  return {
    project,
    kind: 'briefing',
    issueId: null,
    fileRef: `memory/journal/${file.name}`,
    text: journalLine(file),
    id: `${project}:briefing:${file.name}`,
  };
}

// ---------------------------------------------------------------------------
// (f) new-repo-candidate — a git repo appeared under the workspace root but is
// not yet registered (issue 95, ADR-0017). Candidacy is the pure self-heal
// detector's call; this only shapes the items.
// ---------------------------------------------------------------------------

function deriveRepoCandidates(project: string, selfHeal: SelfHealInput | null): AttentionItem[] {
  if (!selfHeal || typeof selfHeal !== 'object') return [];
  return detectAppearedRepos(selfHeal).map((candidate) => ({
    project,
    kind: 'new-repo-candidate' as const,
    issueId: null,
    // Not a project-root-relative file — a candidate is registered, not opened;
    // the repo path rides in `candidate` for the one-click register action.
    fileRef: null,
    text: `a new repo "${candidate.name}" appeared under ${selfHeal.workspaceRoot} — register it?`,
    id: `${project}:new-repo-candidate:${candidate.name}`,
    candidate,
  }));
}

// ---------------------------------------------------------------------------
// The per-project derivation
// ---------------------------------------------------------------------------

const KIND_ORDER: readonly AttentionKind[] = [
  'hitl-park',
  'curator-proposal',
  'blocked-run',
  'setup-gate',
  'new-repo-candidate',
  'briefing',
];

/**
 * Derive one project's attention items from its parsed workbench artifacts.
 * Deterministic: the same inputs yield the same items, ids, and order.
 * Never throws — malformed pieces degrade to `notes` entries.
 */
export function deriveAttention(input: AttentionInput): AttentionResult {
  const notes: string[] = [];
  const project = typeof input?.project === 'string' ? input.project : 'unknown-project';
  const backlog: Backlog =
    input?.backlog && Array.isArray(input.backlog.issues) ? input.backlog : EMPTY_BACKLOG;

  const receiptItems = deriveReceiptItems(project, backlog, asArray(input?.receipts), notes);

  const proposal: AttentionItem[] = input?.coreProposedPresent
    ? [
        {
          project,
          kind: 'curator-proposal',
          issueId: null,
          fileRef: 'memory/CORE.proposed.md',
          text: 'curator proposal awaiting your review — memory/CORE.proposed.md',
          id: `${project}:curator-proposal`,
        },
      ]
    : [];

  const gates = deriveSetupGates(project, backlog, input?.humanSetup ?? null);
  const candidates = deriveRepoCandidates(project, input?.selfHeal ?? null);
  const briefing = deriveBriefing(project, asArray(input?.journal), input?.lastSeen ?? null, notes);

  const items = [...receiptItems, ...proposal, ...gates, ...candidates, ...briefing].sort(
    (a, b) => {
      const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      if (kind !== 0) return kind;
      if (a.kind === 'briefing') return 0; // already newest-first
      const byIssue = (a.issueId ?? Infinity) - (b.issueId ?? Infinity);
      return byIssue !== 0 ? byIssue : a.id.localeCompare(b.id);
    },
  );

  return { items, notes };
}

// ===========================================================================
// Cross-project presentation — the unified attention surface / rail / cards
// ===========================================================================

/** A defensively-read attention-item array: anything malformed degrades out. */
function asItems(value: readonly AttentionItem[] | null | undefined): AttentionItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (i): i is AttentionItem =>
      i !== null &&
      typeof i === 'object' &&
      typeof (i as AttentionItem).id === 'string' &&
      typeof (i as AttentionItem).project === 'string',
  );
}

/** An actionable item is anything a human might act on — everything but the
 *  quiet journal briefing. This is THE needs-you set the whole app counts. */
function isActionable(item: AttentionItem): boolean {
  return item.kind !== 'briefing';
}

/** One project's actionable attention items, ready to render as a group. */
export interface AttentionGroup {
  project: string;
  /** The project's actionable items, in the aggregate's deterministic order. */
  items: AttentionItem[];
  /** Parked-HITL count — what floats this group up the urgency order. */
  parkedHitl: number;
  /** This project's needs-you count (its actionable item count). */
  needsYou: number;
}

/** The unified attention surface's shape: the briefing, the grouped items, and
 *  the one needs-you total the rail badge shows. */
export interface AttentionHub {
  /** Journal one-liners (kind `briefing`), in the aggregate's newest-first order. */
  briefing: AttentionItem[];
  /** Actionable items grouped by Project, ordered by urgency (parked HITL first). */
  groups: AttentionGroup[];
  /** Cross-project needs-you: the total actionable (non-briefing) item count. */
  needsYou: number;
}

/**
 * Shape the aggregated cross-project attention list into the unified surface:
 * the quiet journal **briefing** split out, the actionable items grouped by
 * Project and ordered by **urgency** — a group with parked HITL floats above
 * one without (by park count, desc), ties broken alphabetically — so the top
 * of the list is always the right next thing. Within a group the aggregate's
 * deterministic order (parked HITL already first per `deriveAttention`) is
 * preserved. The `needsYou` total is the same number the rail badge reads, so
 * the surface and the rail cannot disagree. Pure; any input yields a value.
 */
export function buildAttentionHub(items: readonly AttentionItem[]): AttentionHub {
  const briefing: AttentionItem[] = [];
  const byProject = new Map<string, AttentionItem[]>();
  for (const item of asItems(items)) {
    if (!isActionable(item)) {
      briefing.push(item);
      continue;
    }
    const group = byProject.get(item.project);
    if (group) group.push(item);
    else byProject.set(item.project, [item]);
  }

  const groups: AttentionGroup[] = [...byProject.entries()].map(([project, groupItems]) => ({
    project,
    items: groupItems,
    parkedHitl: groupItems.filter((i) => i.kind === 'hitl-park').length,
    needsYou: groupItems.length,
  }));
  // Urgency float: parked HITL desc, then project name asc (deterministic).
  groups.sort(
    (a, b) =>
      b.parkedHitl - a.parkedHitl ||
      (a.project < b.project ? -1 : a.project > b.project ? 1 : 0),
  );

  const needsYou = groups.reduce((n, g) => n + g.needsYou, 0);
  return { briefing, groups, needsYou };
}

/**
 * The cross-project needs-you count — the actionable (non-briefing) item total
 * the rail badge shows. Equal to `buildAttentionHub(items).needsYou`; kept as a
 * standalone function so the rail can read the one number without building the
 * whole surface. Pure and total.
 */
export function needsYouCount(items: readonly AttentionItem[]): number {
  return asItems(items).filter(isActionable).length;
}

/**
 * The per-project needs-you counts — a `project → actionable count` map the
 * Launcher cards read, so a card's badge is the same number the surface shows
 * for that project and the rail's total is their sum. Projects with no
 * actionable item are absent (a card then shows no badge). Pure and total.
 */
export function needsYouByProject(items: readonly AttentionItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of asItems(items)) {
    if (!isActionable(item)) continue;
    counts.set(item.project, (counts.get(item.project) ?? 0) + 1);
  }
  return counts;
}

/**
 * The briefing the OPEN surface shows: the lines frozen when it was opened
 * (viewing advanced the stamp, so a re-derive drops them — they must not blink
 * out mid-read) plus anything that arrived live since, deduped by the items'
 * stable ids. Live items lead: they are the newest.
 */
export function mergeBriefing(
  frozen: readonly AttentionItem[],
  live: readonly AttentionItem[],
): AttentionItem[] {
  const liveItems = asItems(live);
  const seen = new Set(liveItems.map((i) => i.id));
  return [...liveItems, ...asItems(frozen).filter((i) => !seen.has(i.id))];
}

/** The short badge text for an attention kind. */
export function kindLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'hitl-park':
      return 'PARKED';
    case 'curator-proposal':
      return 'PROPOSAL';
    case 'curator-report':
      return 'REPORT';
    case 'blocked-run':
      return 'BLOCKED';
    case 'setup-gate':
      return 'SETUP';
    case 'new-repo-candidate':
      return 'NEW REPO';
    case 'briefing':
      return 'JOURNAL';
    default:
      return 'NOTE';
  }
}

// ---------------------------------------------------------------------------
// Last-seen stamps — the briefing's "newer than when I last looked" filter
// ---------------------------------------------------------------------------

/**
 * Parse the persisted stamp file (`{ project: iso }` JSON). Malformed content
 * — missing file, junk JSON, non-object, non-string values — degrades to the
 * empty map: everything then reads as unseen, which is the safe direction.
 */
export function parseLastSeen(content: string | null): Record<string, string> {
  if (typeof content !== 'string' || content.length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const stamps: Record<string, string> = {};
  for (const [project, stamp] of Object.entries(raw)) {
    if (typeof stamp === 'string' && stamp.length > 0) stamps[project] = stamp;
  }
  return stamps;
}

/** Serialize the stamp map for the userData file (stable key order). */
export function serializeLastSeen(stamps: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(stamps ?? {}).sort()) ordered[key] = stamps[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Advance the given projects' stamps to `nowIso` — the "I looked at the
 * attention surface" moment. Non-listed projects keep their stamps; a stamp
 * never moves backwards (a skewed clock must not resurrect already-seen entries
 * as new forever, nor mark future entries seen). Pure: returns a new map.
 */
export function advanceLastSeen(
  stamps: Record<string, string> | null | undefined,
  projects: readonly string[],
  nowIso: string,
): Record<string, string> {
  const next: Record<string, string> = { ...(stamps ?? {}) };
  if (typeof nowIso !== 'string' || nowIso.length === 0) return next;
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project !== 'string' || project.length === 0) continue;
    const prior = next[project];
    next[project] = prior !== undefined && prior > nowIso ? prior : nowIso;
  }
  return next;
}

/**
 * The workbench project directory an attention item's `project` names, under
 * the snapshot's workbench root — what click-through hands to the normal
 * `openProject` flow (ownership rules and all). Null when either half is
 * unusable: a path is never guessed from junk (a `project` carrying
 * separators or `..` is not a directory NAME).
 */
export function workbenchProjectPath(workbenchRoot: string, project: string): string | null {
  if (typeof workbenchRoot !== 'string' || workbenchRoot.trim() === '') return null;
  if (typeof project !== 'string' || project.trim() === '') return null;
  if (project.includes('/') || project.includes('\\') || project === '.' || project === '..') {
    return null;
  }
  return `${workbenchRoot.replace(/\/+$/, '')}/${project}`;
}

/**
 * The workbench project directory NAME a `ProjectView.key` names, when that
 * key sits directly under the given workbench root (`<workbenchRoot>/<name>`)
 * — the inverse of `workbenchProjectPath`. Null for a legacy Project's key (a
 * repo path, not a workbench directory) or malformed input. Used to resolve
 * which `AttentionItem.project` is "this Window's own" (issue 150).
 */
export function projectDirNameFromKey(workbenchRoot: string, key: string): string | null {
  if (typeof workbenchRoot !== 'string' || workbenchRoot.trim() === '') return null;
  if (typeof key !== 'string' || key.trim() === '') return null;
  const root = workbenchRoot.replace(/\/+$/, '');
  if (!key.startsWith(`${root}/`)) return null;
  const rest = key.slice(root.length + 1);
  if (rest.length === 0 || rest.includes('/') || rest.includes('\\')) return null;
  return rest;
}

// ---------------------------------------------------------------------------
// Per-Window scoping — own project first-class, elsewhere collapsed (issue 150)
// ---------------------------------------------------------------------------

/** One other project's items, collapsed to a count for the Window surface. */
export interface AttentionElsewhere {
  project: string;
  needsYou: number;
}

/** The attention hub, scoped to one Window's own Project (issue 150). */
export interface WindowAttentionView {
  /** This Window's own project's group, expanded — null when it has no
   *  actionable items, or no project is open in this Window. */
  own: AttentionGroup | null;
  /** Every OTHER project with actionable items, collapsed to a count, in the
   *  hub's urgency order (parked HITL first). Empty when there are none. */
  elsewhere: AttentionElsewhere[];
  /** Sum of `elsewhere[].needsYou` — the collapsed line's total. */
  elsewhereTotal: number;
}

/**
 * Partition a cross-project `AttentionHub` into this Window's own Project
 * (shown expanded, as today) and everything else (collapsed to a per-project
 * count) — ADR-0016's cross-project guarantee is unchanged, only the
 * presentation narrows to Window identity. `ownProject` is the workbench
 * directory name of the Project this Window has open, or null when this
 * Window has none open (the Launcher/home case, which shows the flat list
 * instead of calling this at all). Pure; any input yields a value.
 */
export function scopeAttentionToWindow(
  hub: AttentionHub,
  ownProject: string | null,
): WindowAttentionView {
  const own =
    ownProject !== null ? (hub.groups.find((g) => g.project === ownProject) ?? null) : null;
  const elsewhere = hub.groups
    .filter((g) => g.project !== ownProject)
    .map((g) => ({ project: g.project, needsYou: g.needsYou }));
  const elsewhereTotal = elsewhere.reduce((n, e) => n + e.needsYou, 0);
  return { own, elsewhere, elsewhereTotal };
}

// ---------------------------------------------------------------------------
// Curator reports — global (cross-project) pass files as attention items
// (issue 151). `~/Workbench/tools/curator-reports/*.md` is written by the
// weekly memory-curator skill; it lives outside any single project's
// workbench dir, so these items are derived independently of `deriveAttention`
// and folded into the same aggregated item list by the caller (main).
// ---------------------------------------------------------------------------

/** One raw curator-report file: base name (`YYYY-MM-DD[-n].md`) and content. */
export interface CuratorReportFile {
  name: string;
  content: string;
}

interface CuratorReportFrontmatter {
  outcome: string | null;
  proposals: number | null;
}

/** The frontmatter fields this surface needs — malformed/missing degrades to null. */
function parseCuratorReportFrontmatter(content: string): CuratorReportFrontmatter {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content ?? '');
  if (!fm) return { outcome: null, proposals: null };
  const outcome = /^outcome:\s*(.+)$/m.exec(fm[1]);
  const proposals = /^proposals:\s*(\d+)/m.exec(fm[1]);
  return {
    outcome: outcome ? outcome[1].trim() : null,
    proposals: proposals ? Number(proposals[1]) : null,
  };
}

/** The `YYYY-MM-DD` a report's file name starts with, or null. */
function curatorReportDate(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1] : null;
}

/** `curator pass 2026-07-17 — defects-found · 2 proposals` — the one-liner. */
function curatorReportText(name: string, fm: CuratorReportFrontmatter): string {
  const date = curatorReportDate(name) ?? name;
  const outcome = fm.outcome ?? 'unknown outcome';
  const proposals = fm.proposals ?? 0;
  const proposalPart = proposals > 0 ? ` · ${proposals} proposal${proposals === 1 ? '' : 's'}` : '';
  return `curator pass ${date} — ${outcome}${proposalPart}`;
}

/**
 * Derive attention items for curator-report files the human hasn't opened yet
 * (issue 151). "Seen" is per-file-name, set once a report is opened — never a
 * last-seen time window — so a re-derive never resurrects one already read,
 * and a brand-new file always surfaces regardless of the others' history.
 * Newest-file-name first. Pure; malformed frontmatter degrades to a generic
 * label rather than a throw; a non-`.md` file (the curator's log files) is
 * never a report.
 */
export function deriveCuratorReportItems(
  files: readonly CuratorReportFile[],
  seen: ReadonlySet<string>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const f of asArray(files)) {
    if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') continue;
    if (!/\.md$/i.test(f.name)) continue;
    if (seen.has(f.name)) continue;
    const fm = parseCuratorReportFrontmatter(f.content);
    items.push({
      project: 'tools',
      kind: 'curator-report',
      issueId: null,
      fileRef: `tools/curator-reports/${f.name}`,
      text: curatorReportText(f.name, fm),
      id: `curator-report:${f.name}`,
    });
  }
  return items.sort((a, b) => (b.fileRef ?? '').localeCompare(a.fileRef ?? ''));
}

// ---------------------------------------------------------------------------
// Curator-report seen state — "opened it" persisted as a plain name list
// (app userData, like the briefing's last-seen stamps). Pure parse/serialize/
// mark so the fs edge (main) stays a thin adapter and the transitions are
// unit-testable without touching disk.
// ---------------------------------------------------------------------------

/** Parse the persisted seen-reports file (`string[]` JSON of file names).
 *  Malformed content — missing file, junk JSON, non-array, non-string
 *  entries — degrades to the empty list: everything then reads as unseen. */
export function parseSeenReports(content: string | null): string[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Serialize the seen-reports list for the userData file (sorted, deduped). */
export function serializeSeenReports(names: readonly string[]): string {
  const unique = [...new Set(names.filter((n): n is string => typeof n === 'string'))].sort();
  return `${JSON.stringify(unique, null, 2)}\n`;
}

/**
 * Mark one report name seen — "opened it". Pure: returns a new deduped list;
 * a blank/non-string name is a no-op (returns the deduped input unchanged).
 */
export function markReportSeen(names: readonly string[], name: string): string[] {
  const unique = [...new Set(names)];
  if (typeof name !== 'string' || name.length === 0) return unique;
  const set = new Set(unique);
  set.add(name);
  return [...set];
}

// ---------------------------------------------------------------------------
// Debrief affordance — once per drain (issue 152). When a drain ends, the
// drain-summary surface offers one "Debrief" button that opens a Just-talk
// Pane with `/debrief` pre-typed (issue-91 pattern: typed, never submitted).
// The affordance is offered exactly once per journal entry — keyed on a
// caller-built string (project + journal file name) — and never resurfaces
// after a refresh/restart, mirroring the curator-report seen-state above
// (same parse/serialize/mark shape, generalized past file names).
// ---------------------------------------------------------------------------

/** Parse the persisted seen-debriefs file (`string[]` JSON of entry keys).
 *  Malformed content degrades to the empty list: everything then offers. */
export function parseSeenDebriefs(content: string | null): string[] {
  return parseSeenReports(content);
}

/** Serialize the seen-debriefs list for the userData file (sorted, deduped). */
export function serializeSeenDebriefs(keys: readonly string[]): string {
  return serializeSeenReports(keys);
}

/** Mark one journal entry's key seen. Pure: a blank/non-string key is a no-op. */
export function markDebriefSeen(keys: readonly string[], key: string): string[] {
  return markReportSeen(keys, key);
}

/**
 * Should a drain's journal entry offer the Debrief affordance? True exactly
 * once per entry key — an unseen (or blank) key never offers twice; a blank
 * key never offers at all (no journal entry landed, nothing to debrief).
 */
export function shouldOfferDebrief(key: string, seen: ReadonlySet<string>): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  return !seen.has(key);
}
