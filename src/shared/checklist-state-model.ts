/**
 * HITL checklist check-state (PURE) — issue 156.
 *
 * Which of a parked issue's checklist items are ticked is ephemeral working
 * state (like the Run log), not something committed to git — so it persists
 * in a main-process userData store, keyed by project + issue file, rather
 * than being written back into the issue file. This module is the pure
 * parse/serialize/toggle logic; `main/checklist-state-store.ts` is the fs
 * edge that reads/writes the JSON file (mirrors `attention-hub-model.ts` /
 * `attention-last-seen.ts`'s split).
 *
 * Stored shape: one boolean array per key (checked flags in checklist
 * order). A key's array is aligned to the checklist's CURRENT item count on
 * every read — a Receipt/body edit that changes the step count shouldn't
 * crash or misalign; items beyond the stored array's length read as
 * unchecked, and a shorter checklist just ignores the extra stored flags.
 */

/** One project+issue key's checked flags, in checklist order. */
export type ChecklistStateMap = Record<string, boolean[]>;

/** The persistence key for one issue's checklist state within one project. */
export function checklistStateKey(projectKey: string, fileName: string): string {
  return `${projectKey}::${fileName}`;
}

/**
 * Parse the persisted state file (`{ key: boolean[] }` JSON). Malformed
 * content — missing file, junk JSON, non-object, non-array/non-boolean
 * values — degrades to the empty map: everything then reads as unchecked,
 * the safe direction (never a phantom "already verified").
 */
export function parseChecklistState(content: string | null): ChecklistStateMap {
  if (typeof content !== 'string' || content.length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const state: ChecklistStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'boolean')) {
      state[key] = value;
    }
  }
  return state;
}

/** Serialize the state map for the userData file (stable key order). */
export function serializeChecklistState(state: ChecklistStateMap): string {
  const ordered: ChecklistStateMap = {};
  for (const key of Object.keys(state ?? {}).sort()) ordered[key] = state[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The checked flags for one key, aligned to `itemCount`: missing/short
 * entries pad with `false`, a longer stored entry is truncated. This is what
 * the renderer's checklist rendering reads — always exactly `itemCount` long.
 */
export function checkedFlagsFor(
  state: ChecklistStateMap,
  key: string,
  itemCount: number,
): boolean[] {
  const stored = state[key] ?? [];
  return Array.from({ length: Math.max(0, itemCount) }, (_, i) => stored[i] ?? false);
}

/**
 * Toggle one item's checked flag and return a NEW state map (pure). The
 * array is aligned to `itemCount` first, so toggling item 2 of a 3-item
 * checklist never crashes on a shorter/missing stored entry.
 */
export function toggleChecklistItem(
  state: ChecklistStateMap,
  key: string,
  index: number,
  itemCount: number,
): ChecklistStateMap {
  const flags = checkedFlagsFor(state, key, itemCount);
  if (index < 0 || index >= flags.length) return state;
  flags[index] = !flags[index];
  return { ...state, [key]: flags };
}

/** Whether every one of `itemCount` items is checked (all-checked → done gate). */
export function allChecked(flags: readonly boolean[], itemCount: number): boolean {
  return itemCount > 0 && flags.length === itemCount && flags.every(Boolean);
}
