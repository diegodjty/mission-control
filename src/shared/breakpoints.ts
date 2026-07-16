/**
 * Responsive breakpoint tokens (issue 126) — the canonical narrow-width scale
 * the Atlas shell's icon-collapse (issue 124) and every view rebuild (issues
 * 127–130) share.
 *
 * The pixel widths themselves live as CSS custom properties in `:root`
 * (index.css, the `--bp-*` tokens) so the stylesheet is their SINGLE source of
 * truth — the same place the colour, shadow, and easing tokens live. This
 * module does NOT re-declare the pixel values; it names the breakpoints and
 * maps each to the CSS token it reads and the shell-root data-attribute it
 * drives. That bridge exists because a CSS `@media` condition cannot itself
 * read a custom property: the AppShell reads a token off `:root` at runtime,
 * builds the matching media query with {@link maxWidthQuery}, and toggles the
 * data-attribute the stylesheet's collapse/reflow rules consume. So a
 * breakpoint is defined once (the `:root` token) and consumed everywhere.
 *
 * Pure (no React, no DOM) so the token contract is unit-testable in isolation;
 * the DOM reading and matchMedia wiring are the AppShell's job.
 */

/** A named breakpoint: the CSS token that holds its width and the shell
 *  data-attribute the stylesheet keys its narrow rules off. */
export interface Breakpoint {
  /** The CSS custom property (declared in `:root`) holding this width. */
  readonly token: `--bp-${string}`;
  /** The attribute the shell root carries while the viewport is at/below it. */
  readonly attribute: `data-${string}`;
}

/**
 * The breakpoint set, widest name first. `narrow` is what the shell consumes
 * today (rail collapses to icons, header text yields); `compact` is the
 * single-column tier the per-view rebuilds (127–130) reflow against. Adding a
 * tier here + a matching `--bp-*` token in `:root` is all a future view needs.
 */
export const BREAKPOINTS = {
  /** Rail collapses to icons; header text yields to the essential controls. */
  narrow: { token: '--bp-narrow', attribute: 'data-narrow' },
  /** Shared grids and panels drop to a single fluid column. */
  compact: { token: '--bp-compact', attribute: 'data-compact' },
} as const satisfies Record<string, Breakpoint>;

/** The names of the defined breakpoints. */
export type BreakpointName = keyof typeof BREAKPOINTS;

/** Every breakpoint as a list, in declaration order — what the shell iterates. */
export const BREAKPOINT_LIST: readonly Breakpoint[] = Object.values(BREAKPOINTS);

/**
 * Build the `max-width` media query string for a resolved breakpoint width
 * (e.g. the `"900px"` read off the `--bp-narrow` token). Whitespace is trimmed
 * because `getComputedStyle` returns custom-property values with a leading
 * space. A blank value yields an empty string so the caller can skip a token
 * that isn't declared rather than build an invalid, always-matching query.
 */
export function maxWidthQuery(value: string): string {
  const v = value.trim();
  return v ? `(max-width: ${v})` : '';
}
