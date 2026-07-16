/**
 * Command registry (issue 124, ADR-0020) — the pure brain behind the Cmd+K
 * command palette. Providers contribute commands (registered **Projects**,
 * the shell's views, the active Project's open issues by title, and the
 * entry-point actions); this module merges them, fuzzy-ranks them against a
 * query, and owns the palette's keyboard-selection state machine.
 *
 * Pure by construction: no React, no DOM, no IPC. A command carries an opaque
 * `run` thunk the palette UI supplies — this module never calls it, so the
 * ranking/merging/selection logic is unit-testable on plain data (per the
 * PRD's testing guidance: given these commands, the palette ranks them in
 * this order).
 *
 * "Palette safety equals click safety" (ADR-0020) lives in the UI's thunks,
 * not here: a project command's `run` routes through the same interrupt guard
 * a click would; this module only decides what shows and in what order.
 */

/** What a command targets — also its badge + tie-break priority. */
export type CommandKind = 'project' | 'view' | 'issue' | 'action';

/** One thing the palette can surface and run. */
export interface Command {
  /** Stable, unique across the merged set (`<kind>:<discriminator>`). */
  id: string;
  kind: CommandKind;
  /** The primary label, fuzzy-matched first. */
  title: string;
  /** A quiet right-aligned hint ("Go to Map", "#124", the Project stage). */
  hint?: string;
  /** Extra searchable text (an issue's slug/id, a Project's key) — matched
   *  after the title, at a discount. */
  keywords?: string;
  /** Shown but not runnable (e.g. a Project owned by another Window). */
  disabled?: boolean;
  /** The UI-supplied action. Never invoked by this module. */
  run?: () => void;
}

/** A named group of commands from one source (projects, views, issues, …). */
export interface CommandProvider {
  id: string;
  commands: Command[];
}

/** A command with its match score for the current query. */
export interface RankedCommand {
  command: Command;
  score: number;
}

/**
 * Suggestion + tie-break order. Projects first (the most common jump), then
 * the views, then the entry-point actions; issues never appear as an
 * empty-query suggestion (there can be hundreds) — they surface only once the
 * user types.
 */
const KIND_PRIORITY: Record<CommandKind, number> = {
  project: 0,
  view: 1,
  action: 2,
  issue: 3,
};

/**
 * Merge providers into one flat command list. Provider order is preserved,
 * and the first command to claim an id wins — a later provider can never
 * shadow an earlier one's command, so the merge is deterministic regardless
 * of how many providers contribute.
 */
export function mergeProviders(providers: readonly CommandProvider[]): Command[] {
  const seen = new Set<string>();
  const merged: Command[] = [];
  for (const provider of providers) {
    for (const command of provider.commands) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      merged.push(command);
    }
  }
  return merged;
}

/** True at a token boundary — start of string, after a separator, or the
 *  first digit of a number — where a match reads as a "real" word hit. */
function isBoundary(haystack: string, index: number): boolean {
  if (index === 0) return true;
  const prev = haystack[index - 1];
  if (/[\s\-_/:.·#]/.test(prev)) return true;
  // camelCase / digit boundary: a digit right after a non-digit.
  return /[0-9]/.test(haystack[index]) && !/[0-9]/.test(prev);
}

/**
 * Forgiving subsequence score: every query character must appear in order in
 * the haystack (case-insensitive), or the result is `null` (no match). A
 * higher score is a better match. Bonuses reward matches at word boundaries
 * and contiguous runs; a small length penalty prefers tighter haystacks so
 * "map" ranks Map above a longer title that merely contains m…a…p.
 * A blank query matches everything with a neutral score of 0.
 */
export function fuzzyScore(haystack: string, query: string): number | null {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  let firstMatch = -1;
  let matched = 0;
  for (const ch of q) {
    if (ch === ' ') continue; // spaces are soft — treat as a gap, not a char
    let found = -1;
    for (let k = from; k < h.length; k++) {
      if (h[k] === ch) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    if (firstMatch === -1) firstMatch = found;
    let s = 1;
    if (isBoundary(h, found)) s += 10;
    if (found === prev + 1) s += 5; // contiguous with the previous match
    score += s;
    prev = found;
    from = found + 1;
    matched += 1;
  }
  if (matched === 0) return 0; // all-whitespace query
  if (firstMatch === 0) score += 8; // a true prefix match
  score -= Math.max(0, h.length - matched) * 0.05;
  return score;
}

/** A stable sort by a comparator (Array.prototype.sort is spec-stable in
 *  modern engines, but pin it explicitly so ranking never depends on that). */
function stableSort<T>(items: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => cmp(a.item, b.item) || a.index - b.index)
    .map((w) => w.item);
}

/**
 * Rank commands for a query. A blank query returns the suggestion set —
 * everything except issues, ordered by kind priority — so the palette is
 * useful before the user types. A non-blank query fuzzy-matches every command
 * (issues included) on its title (with a small edge) and its keywords (at a
 * discount), keeps only the matches, and orders them best-score first, with
 * kind priority then title as the tie-break.
 */
export function rankCommands(commands: readonly Command[], query: string): RankedCommand[] {
  const q = query.trim();

  if (q === '') {
    const suggestions = commands.filter((c) => c.kind !== 'issue');
    return stableSort(suggestions, (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]).map(
      (command) => ({ command, score: 0 }),
    );
  }

  const ranked: RankedCommand[] = [];
  for (const command of commands) {
    const titleScore = fuzzyScore(command.title, q);
    const keywordScore = command.keywords ? fuzzyScore(command.keywords, q) : null;
    let best: number | null = null;
    if (titleScore !== null) best = titleScore + 5; // the title is the primary label
    if (keywordScore !== null) best = Math.max(best ?? -Infinity, keywordScore);
    if (best === null) continue;
    ranked.push({ command, score: best });
  }

  return stableSort(
    ranked,
    (a, b) =>
      b.score - a.score ||
      KIND_PRIORITY[a.command.kind] - KIND_PRIORITY[b.command.kind] ||
      a.command.title.length - b.command.title.length ||
      a.command.title.localeCompare(b.command.title),
  );
}

// ---------------------------------------------------------------------------
// Keyboard-selection state machine
// ---------------------------------------------------------------------------

/** The palette's live selection: the query, its ranked results, and which
 *  row is highlighted (always a valid index while results exist, else 0). */
export interface PaletteState {
  query: string;
  ranked: RankedCommand[];
  activeIndex: number;
}

/** Open the palette on an empty query — the suggestion set, top row active. */
export function openPalette(commands: readonly Command[]): PaletteState {
  return { query: '', ranked: rankCommands(commands, ''), activeIndex: 0 };
}

/** Re-rank for a new query and reset the highlight to the top match — typing
 *  always re-anchors selection at the best result (standard palette feel). */
export function setQuery(commands: readonly Command[], query: string): PaletteState {
  return { query, ranked: rankCommands(commands, query), activeIndex: 0 };
}

/**
 * Move the highlight by `delta` (arrow keys), wrapping around the ends so
 * Down past the last row lands on the first and Up past the first lands on
 * the last. A no-op when there are no results.
 */
export function moveActive(state: PaletteState, delta: number): PaletteState {
  const n = state.ranked.length;
  if (n === 0) return { ...state, activeIndex: 0 };
  const next = (((state.activeIndex + delta) % n) + n) % n;
  return { ...state, activeIndex: next };
}

/** Point the highlight at a specific row (hover / click), clamped to range. */
export function setActive(state: PaletteState, index: number): PaletteState {
  const n = state.ranked.length;
  if (n === 0) return { ...state, activeIndex: 0 };
  return { ...state, activeIndex: Math.max(0, Math.min(index, n - 1)) };
}

/** The currently highlighted command, or null when nothing matches. */
export function activeCommand(state: PaletteState): Command | null {
  return state.ranked[state.activeIndex]?.command ?? null;
}
