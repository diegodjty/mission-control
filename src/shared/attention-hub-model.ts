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
