/**
 * Shell model (issue 123, ADR-0020) — the pure decision logic behind the
 * AppShell: which views exist, which tabs show, which hosts stay mounted
 * while hidden, and where the active view moves when shell-level events
 * happen (a project opens, a Run starts, a planning session ends).
 *
 * The load-bearing invariant this module pins: **Map, Pane, and Planning
 * survive navigation.** Their hosts hold live state — the Map's backlog
 * watch, every Pane's PTY session (unmounting a Pane kills its terminal,
 * see Pane.tsx cleanup), the Planning view's session and file watch — so
 * they are keep-mounted: hidden when inactive, never unmounted while their
 * live state exists. The Launcher and the Inbox are the opposite by design:
 * mounting the Inbox IS "viewing" it (issue 80 — it advances the briefing's
 * last-seen stamp), so both remount fresh on every visit.
 *
 * Pure (no React, no DOM, no Electron) so the policy is unit-testable in
 * isolation; the AppShell renders exactly what this module decides.
 */

/** The five views a Window can show. */
export type ViewId = 'launcher' | 'map' | 'pane' | 'inbox' | 'planning';

/** Every empty Window is the Launcher — the front door (issue 81, ADR-0016). */
export const DEFAULT_VIEW: ViewId = 'launcher';

/**
 * The live facts the shell's decisions depend on. Everything here is
 * observable app state the root component already tracks; the model never
 * caches or derives its own copy.
 */
export interface ShellContext {
  /** A Big-feature planning session exists on this Window's Project (issue 83). */
  hasPlanning: boolean;
  /** How many Runs this Window is tracking (live or finished, Panes on screen). */
  runCount: number;
  /** A Just-talk session's Pane is open (issue 81). */
  hasTalk: boolean;
  /**
   * Cross-project needs-you count for the Attention rail badge (issue 124):
   * how many attention items across every project want the human right now.
   * Fed for now by the existing attention snapshot (the same non-briefing
   * item count the Inbox shows); issue 125 swaps the source to
   * `attention-hub-model` without changing this field.
   */
  attentionNeedsYou: number;
}

/**
 * How a view's host behaves when the view is inactive: `keep-mounted` hosts
 * are hidden (display: none) but stay in the tree so their live state
 * survives; `remount-on-visit` hosts exist only while their view is active.
 */
export type MountPolicy = 'keep-mounted' | 'remount-on-visit';

/** One entry in the shell's navigation, in render order. */
export interface ShellTab {
  id: ViewId;
  /** The tab's visible label ('Home', 'Map', 'Pane', 'Plan', 'Inbox'). */
  label: string;
  /**
   * A live count the tab carries, or null for none. Today only the Pane tab
   * is badged (its tracked-Run count). The Inbox is deliberately never
   * badged: it is a place you look, not a pusher (ADR-0012).
   */
  badge: number | null;
  /** Hover text, when the tab warrants an explanation. */
  title?: string;
}

/**
 * The view registry: every view the shell can host, in navigation order,
 * with its mount policy. The single source of truth the tabs, the slot
 * hosting, and the transitions all read from.
 */
const REGISTRY: ReadonlyArray<{ id: ViewId; label: string; policy: MountPolicy }> = [
  { id: 'launcher', label: 'Home', policy: 'remount-on-visit' },
  { id: 'map', label: 'Map', policy: 'keep-mounted' },
  { id: 'pane', label: 'Pane', policy: 'keep-mounted' },
  { id: 'planning', label: 'Plan', policy: 'keep-mounted' },
  // The Atlas rail names this entry 'Attention' (issue 124, per the approved
  // shell mock); the ViewId stays `inbox` — issue 125 rebuilds the surface it
  // hosts into the unified attention view.
  { id: 'inbox', label: 'Attention', policy: 'remount-on-visit' },
];

/** A view's mount policy (see MountPolicy). */
export function mountPolicy(id: ViewId): MountPolicy {
  const entry = REGISTRY.find((v) => v.id === id);
  // The registry is total over ViewId; the fallback only satisfies TS.
  return entry?.policy ?? 'remount-on-visit';
}

/**
 * Which live count a rail entry carries for this context, or null for none.
 * The Pane entry shows its tracked-Run count; the Attention entry shows the
 * cross-project needs-you count (issue 124). Both vanish at zero — a badge is
 * a call to look, never decoration.
 */
function badgeFor(id: ViewId, ctx: ShellContext): number | null {
  if (id === 'pane') return ctx.runCount > 0 ? ctx.runCount : null;
  if (id === 'inbox') return ctx.attentionNeedsYou > 0 ? ctx.attentionNeedsYou : null;
  return null;
}

/**
 * The rail entries the shell shows for this context, in order. The Plan entry
 * exists only while a planning session does (issue 83 — the rail never
 * advertises a dead end); the Pane and Attention entries carry live badges
 * (see `badgeFor`).
 */
export function shellTabs(ctx: ShellContext): ShellTab[] {
  return REGISTRY.filter((v) => v.id !== 'planning' || ctx.hasPlanning).map((v) => ({
    id: v.id,
    label: v.label,
    badge: badgeFor(v.id, ctx),
    ...(v.id === 'launcher' ? { title: 'Home — the Launcher' } : {}),
  }));
}

/**
 * Whether a view's host should exist in the tree right now. Keep-mounted
 * hosts are mounted whenever their live state exists — INDEPENDENT of the
 * active view, which is exactly the keep-mounted invariant — and
 * remount-on-visit hosts only while active:
 *
 *   map      → always (its backlog watch keeps Run status and the drain plan
 *              current even while another view shows)
 *   pane     → whenever a Run or talk session is tracked (their PTY sessions
 *              must survive navigation); with nothing live, the empty-shell
 *              Pane mounts per-visit like any remount view
 *   planning → while the planning session exists, whatever view is active
 *   launcher → only while visited
 *   inbox    → only while visited (mounting IS viewing — issue 80)
 */
export function isSlotMounted(id: ViewId, active: ViewId, ctx: ShellContext): boolean {
  switch (id) {
    case 'map':
      return true;
    case 'pane':
      return ctx.runCount > 0 || ctx.hasTalk ? true : active === 'pane';
    case 'planning':
      return ctx.hasPlanning;
    case 'launcher':
    case 'inbox':
      return active === id;
  }
}

/**
 * The shell-level events that move the active view. Everything the root
 * component used to hand-code as scattered setView calls, named:
 *
 *   navigate          — a tab click (or Home affordance): go there
 *   project-opened    — an explicit open landed: leave the Launcher for the
 *                       Map; a no-op from any other view (issue 81)
 *   window-reattached — bootstrap re-attached this Window's Project: the Map
 *   attention-opened  — an Inbox/attention click-through: the Map, where the
 *                       referenced issue is surfaced (issue 80)
 *   run-started       — a Run or talk session began: the Pane
 *   planning-started  — a planning session began: the Planning view
 *   planning-closed   — the session ended/cleared: a Window stranded ON the
 *                       Planning view falls back to the Map (issue 83)
 */
export type ShellEvent =
  | { kind: 'navigate'; to: ViewId }
  | { kind: 'project-opened' }
  | { kind: 'window-reattached' }
  | { kind: 'attention-opened' }
  | { kind: 'run-started' }
  | { kind: 'planning-started' }
  | { kind: 'planning-closed' };

/**
 * Where the active view moves when a shell event happens. Pure and total:
 * the current view goes in, the next view comes out; the caller applies it.
 */
export function viewAfterEvent(current: ViewId, event: ShellEvent, ctx: ShellContext): ViewId {
  switch (event.kind) {
    case 'navigate':
      // Planning is only a real destination while its session exists — the
      // tab isn't rendered otherwise, and the view would show nothing.
      return event.to === 'planning' && !ctx.hasPlanning ? current : event.to;
    case 'project-opened':
      return current === 'launcher' ? 'map' : current;
    case 'window-reattached':
      return 'map';
    case 'attention-opened':
      return 'map';
    case 'run-started':
      return 'pane';
    case 'planning-started':
      return 'planning';
    case 'planning-closed':
      return current === 'planning' ? 'map' : current;
  }
}
