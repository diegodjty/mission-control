/**
 * Inbox model (PURE) — presentation logic for the cross-project Inbox
 * (issue 80, ADR-0016), on top of the attention model's items (issue 78).
 *
 * The Inbox is a place you look, never a notifier (ADR-0012): this module
 * only arranges what the background watch (issue 79) already derived —
 * splitting the quiet journal **briefing** from the actionable items,
 * grouping the actionable items by project, and labeling each kind — plus
 * the **last-seen stamp** operations behind the briefing filter. The stamps
 * are app-level state (Electron userData, per ADR-0016 — reading the Inbox
 * must never create workbench commits); the fs read/write lives in
 * `src/main/attention-last-seen.ts`, the semantics live here.
 *
 * House PURE contract: no I/O, any input yields a value, never a throw.
 */
import type { AttentionItem, AttentionKind } from './attention-model';

/** One project's actionable attention items, ready to render as a group. */
export interface InboxGroup {
  project: string;
  items: AttentionItem[];
}

/** The Inbox's two surfaces: the briefing strip and the grouped item list. */
export interface InboxView {
  /** Journal one-liners (kind `briefing`), in the aggregate's order. */
  briefing: AttentionItem[];
  /** Actionable items grouped by project, projects ascending. */
  groups: InboxGroup[];
}

/** A defensively-read array: anything non-array degrades to empty. */
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

/**
 * Split the aggregated attention list into the briefing (quiet journal lines)
 * and the actionable items grouped by project. Projects ascend; within a
 * group the aggregate's deterministic order (issue 78/79) is preserved.
 */
export function splitInbox(items: readonly AttentionItem[]): InboxView {
  const briefing: AttentionItem[] = [];
  const byProject = new Map<string, AttentionItem[]>();
  for (const item of asItems(items)) {
    if (item.kind === 'briefing') {
      briefing.push(item);
      continue;
    }
    const group = byProject.get(item.project);
    if (group) group.push(item);
    else byProject.set(item.project, [item]);
  }
  const groups = [...byProject.keys()]
    .sort()
    .map((project) => ({ project, items: byProject.get(project) as AttentionItem[] }));
  return { briefing, groups };
}

/**
 * The briefing the OPEN Inbox shows: the lines frozen when it was opened
 * (viewing advanced the stamp, so a re-derive drops them — they must not
 * blink out mid-read) plus anything that arrived live since, deduped by the
 * items' stable ids. Live items lead: they are the newest.
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
      return 'HITL';
    case 'curator-proposal':
      return 'proposal';
    case 'blocked-run':
      return 'blocked';
    case 'setup-gate':
      return 'setup';
    case 'new-repo-candidate':
      return 'new repo';
    case 'briefing':
      return 'journal';
    default:
      return 'note';
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
 * Inbox" moment. Non-listed projects keep their stamps; a stamp never moves
 * backwards (a skewed clock must not resurrect already-seen entries as new
 * forever, nor mark future entries seen). Pure: returns a new map.
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
