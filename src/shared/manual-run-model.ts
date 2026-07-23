/**
 * Manual single-issue Run model picker (issue 203) — the ONE carve-out to the
 * rule "every interactive entry point inherits the interactive default and is
 * never tiered." Clicking "▶ Run" on a single issue from the Map now asks which
 * Claude model to use BEFORE the Pane spawns; every other interactive entry
 * point (Quick fix, Grill/Planning, Just talk, and every drain-spawned Run)
 * keeps inheriting the interactive default exactly as before.
 *
 * PURE: no React, no Electron. The picker UI (AppDialogs `ModelPickerDialog`)
 * and the spawn edge both consume these decisions. The chosen tier rides through
 * `RunTarget.model` (`shared/ipc-contract`) into `resolveRunCommand`'s existing
 * `options.model` (`main/resolve-run-command`), which injects `--model <id>` via
 * `modelIdForTier` — the same issue-154 plumbing the drain uses, never a second
 * model-id mapping. Keeping the choice model here makes "default == interactive
 * default == no --model flag" a declared, unit-tested fact rather than a UI
 * implementation detail (ADR-0013, declare-don't-imply).
 */
import { TIER_LADDER, type WorkerModelTier } from './worker-model';

/**
 * A picker selection: one of the four drain-side tiers (verbatim — no new
 * naming) or `null` for today's interactive default. `null` is exactly the
 * value that keeps a confirmed-default Run byte-identical to before: it flows
 * to `resolveRunCommand`'s `options.model` as absent, so NO `--model` flag is
 * injected and the interactive default model is inherited, never downgraded.
 */
export type ManualRunModelChoice = WorkerModelTier | null;

/** The pre-selected default: today's interactive default (untiered). */
export const MANUAL_RUN_DEFAULT_CHOICE: ManualRunModelChoice = null;

/** One row in the picker. */
export interface ManualRunModelOption {
  /** The choice this row selects (`null` = the interactive default). */
  value: ManualRunModelChoice;
  /**
   * A stable string key for the option — the `null` default keys as `'default'`,
   * each tier keys as its own name — so a radio group / React list has a
   * non-null value to bind to without inventing per-render ids.
   */
  key: string;
  /** True for the pre-selected interactive-default row. */
  isDefault: boolean;
}

/**
 * The picker's ordered rows: the interactive default (pre-selected) FIRST, then
 * the four tiers cheapest → priciest, reusing `TIER_LADDER` so the vocabulary
 * stays byte-identical to the drain side (issue 154) and no new naming is
 * invented. Confirming the first row reproduces today's exact spawn command.
 */
export const MANUAL_RUN_MODEL_OPTIONS: readonly ManualRunModelOption[] = [
  { value: null, key: 'default', isDefault: true },
  ...TIER_LADDER.map((tier) => ({ value: tier, key: tier, isDefault: false })),
];

/** The option's stable radio/list key for a given choice (`null` ⇒ `'default'`). */
export function manualRunModelKey(choice: ManualRunModelChoice): string {
  return choice ?? 'default';
}

/**
 * Resolve a radio/list key back to its choice — the inverse of
 * `manualRunModelKey`. An unknown key degrades to the interactive default
 * (`null`), so a stray value can never silently tier a manual Run.
 */
export function manualRunModelChoiceForKey(key: string): ManualRunModelChoice {
  const match = MANUAL_RUN_MODEL_OPTIONS.find((opt) => opt.key === key);
  return match ? match.value : MANUAL_RUN_DEFAULT_CHOICE;
}
