/**
 * Home-card open decision (issue 121) — the pure rule for what happens when the
 * user clicks a Project card on the Launcher's home grid.
 *
 * Before this issue a card click always switched THIS Window in place. But once
 * a Window already has a Project open, the user often wants the *other* Project
 * without losing this one — that choice lived only on the top project bar's
 * "Open here" / "Open in new Window" buttons. This rule brings the same choice
 * to the home grid so two Projects can run side by side without reaching for the
 * bar: when a Project is open here and a genuinely DIFFERENT one is picked, ask.
 *
 * Three outcomes, layered on the existing pure rules so the component stays a
 * thin dispatcher:
 *   - `open-here` — nothing to weigh: no Project open yet, OR the card is the
 *     Project already open here (re-selecting interrupts nothing). Open/return
 *     in place, no prompt.
 *   - `confirm-interrupt` — a Run is live in this Window, so switching would tear
 *     it down. The stronger interrupt overlay (issue 114) owns the ask; this rule
 *     just defers to `shouldConfirmInterrupt`.
 *   - `choose-window` — a Project is open, a different one was picked, nothing is
 *     running: offer "Open here" vs "Open in new Window" (the issue 121 case).
 *
 * Pure (no React, no Electron) so the branch table is unit-testable in isolation;
 * the renderer maps each outcome to an action (open in place / show the interrupt
 * overlay / show the choice overlay).
 */
import { isProjectSwitch } from './project-switch';
import { shouldConfirmInterrupt } from './interrupt-guard';

/** The facts a home-card click carries for the open decision. */
export interface CardOpenInput {
  /** The Project key this Window currently manages, or null when none is open. */
  currentKey: string | null;
  /**
   * The clicked card's Project key — its workbench directory, which IS the
   * Project's identity/ownership key (ipc-contract `ProjectView.key`), so it
   * compares directly against `currentKey`.
   */
  cardKey: string;
  /**
   * Whether a Run is still `running` in this Window (a live Worker fixing an
   * issue). Drives the interrupt guard exactly as a project-bar switch does.
   */
  hasLiveRunner: boolean;
}

/** What the renderer should do with a home-card click. */
export type CardOpenDecision =
  /** Open/return in place — no prompt. */
  | { kind: 'open-here' }
  /** Show the interrupt overlay (issue 114) — a live Run would be torn down. */
  | { kind: 'confirm-interrupt' }
  /** Show the "Open here vs Open in new Window" choice overlay (issue 121). */
  | { kind: 'choose-window' };

/**
 * Decide what a home-grid card click does. See the module comment for the three
 * outcomes; the ordering matters — an in-place open (no open Project, or the
 * same Project) short-circuits before either confirmation is considered.
 */
export function decideCardOpen(input: CardOpenInput): CardOpenDecision {
  // No Project open here, or the card IS the open Project: interrupts nothing
  // and offers no second Window to weigh — open/return in place.
  if (input.currentKey === null || !isProjectSwitch(input.currentKey, input.cardKey)) {
    return { kind: 'open-here' };
  }
  // A genuinely different Project. If a runner is live, the interrupt overlay's
  // stronger warning owns the ask; otherwise offer the plain here/new-Window
  // choice this issue is about.
  if (
    shouldConfirmInterrupt({
      hasLiveRunner: input.hasLiveRunner,
      currentKey: input.currentKey,
      targetKey: input.cardKey,
    })
  ) {
    return { kind: 'confirm-interrupt' };
  }
  return { kind: 'choose-window' };
}
