import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  isSlotMounted,
  mountPolicy,
  shellTabs,
  viewAfterEvent,
  type ShellContext,
  type ViewId,
} from './shell-model';

const idle: ShellContext = { hasPlanning: false, runCount: 0, hasTalk: false };
const withRun: ShellContext = { hasPlanning: false, runCount: 1, hasTalk: false };
const withPlanning: ShellContext = { hasPlanning: true, runCount: 0, hasTalk: false };

describe('DEFAULT_VIEW', () => {
  it('is the Launcher — every empty Window is the front door (issue 81, ADR-0016)', () => {
    expect(DEFAULT_VIEW).toBe('launcher');
  });
});

describe('mountPolicy', () => {
  it('keeps Map, Pane, and Planning mounted across navigation', () => {
    // These hosts hold live state (backlog watch, PTY sessions, doc watch)
    // that unmounting would tear down — hidden, never removed.
    expect(mountPolicy('map')).toBe('keep-mounted');
    expect(mountPolicy('pane')).toBe('keep-mounted');
    expect(mountPolicy('planning')).toBe('keep-mounted');
  });

  it('remounts the Launcher and the Inbox on each visit', () => {
    // Mounting the Inbox IS "viewing" it (issue 80) — it advances the
    // briefing's last-seen stamp — so it must be born fresh per visit.
    expect(mountPolicy('launcher')).toBe('remount-on-visit');
    expect(mountPolicy('inbox')).toBe('remount-on-visit');
  });
});

describe('shellTabs', () => {
  it('lists Home, Map, Pane, Inbox in order when no planning session exists', () => {
    expect(shellTabs(idle).map((t) => t.id)).toEqual(['launcher', 'map', 'pane', 'inbox']);
  });

  it('labels the tabs as the header shows them', () => {
    const labels = new globalThis.Map(shellTabs(idle).map((t) => [t.id, t.label]));
    expect(labels.get('launcher')).toBe('Home');
    expect(labels.get('map')).toBe('Map');
    expect(labels.get('pane')).toBe('Pane');
    expect(labels.get('inbox')).toBe('Inbox');
  });

  it('shows the Plan tab only while a planning session exists (issue 83)', () => {
    expect(shellTabs(idle).some((t) => t.id === 'planning')).toBe(false);
    const tabs = shellTabs(withPlanning).map((t) => t.id);
    expect(tabs).toEqual(['launcher', 'map', 'pane', 'planning', 'inbox']);
  });

  it('badges the Pane tab with the live Run count, absent at zero', () => {
    expect(shellTabs(idle).find((t) => t.id === 'pane')?.badge).toBeNull();
    expect(shellTabs({ ...idle, runCount: 3 }).find((t) => t.id === 'pane')?.badge).toBe(3);
  });

  it('never badges the Inbox — a place you look, not a pusher (ADR-0012)', () => {
    const ctx: ShellContext = { hasPlanning: true, runCount: 5, hasTalk: true };
    expect(shellTabs(ctx).find((t) => t.id === 'inbox')?.badge).toBeNull();
  });
});

describe('isSlotMounted', () => {
  const allViews: ViewId[] = ['launcher', 'map', 'pane', 'inbox', 'planning'];

  it('keeps the Map host mounted whatever view is active (live backlog watch)', () => {
    for (const view of allViews) {
      expect(isSlotMounted('map', view, idle)).toBe(true);
    }
  });

  it('keeps the Pane host mounted across every view while a Run is tracked', () => {
    // THE keep-mounted invariant: unmounting a Pane kills its PTY session, so
    // a live Run's terminal must survive any navigation round-trip.
    for (const view of allViews) {
      expect(isSlotMounted('pane', view, withRun)).toBe(true);
    }
  });

  it('keeps the Pane host mounted for a Just-talk session too (issue 81)', () => {
    const ctx: ShellContext = { ...idle, hasTalk: true };
    for (const view of allViews) {
      expect(isSlotMounted('pane', view, ctx)).toBe(true);
    }
  });

  it('mounts the empty-shell Pane only while visiting (nothing live to preserve)', () => {
    expect(isSlotMounted('pane', 'pane', idle)).toBe(true);
    expect(isSlotMounted('pane', 'map', idle)).toBe(false);
    expect(isSlotMounted('pane', 'launcher', idle)).toBe(false);
  });

  it('keeps the Planning host mounted while its session exists, on any view', () => {
    // The planning session and its file watch survive tab switches; the host
    // unmounts only when the session itself ends (issue 83).
    for (const view of allViews) {
      expect(isSlotMounted('planning', view, withPlanning)).toBe(true);
    }
    expect(isSlotMounted('planning', 'planning', idle)).toBe(false);
  });

  it('mounts the Launcher and the Inbox only while visited (remount-on-visit)', () => {
    expect(isSlotMounted('launcher', 'launcher', idle)).toBe(true);
    expect(isSlotMounted('launcher', 'map', idle)).toBe(false);
    expect(isSlotMounted('inbox', 'inbox', idle)).toBe(true);
    expect(isSlotMounted('inbox', 'pane', withRun)).toBe(false);
  });

  it('survives a full view round-trip with a live Run (the tracer invariant)', () => {
    // pane → map → launcher → inbox → pane: at every stop the Pane host must
    // still be mounted, or the round-trip would have killed the terminal.
    const trip: ViewId[] = ['pane', 'map', 'launcher', 'inbox', 'pane'];
    for (const stop of trip) {
      expect(isSlotMounted('pane', stop, withRun)).toBe(true);
    }
  });
});

describe('viewAfterEvent', () => {
  it('navigate goes where the tab click points', () => {
    expect(viewAfterEvent('launcher', { kind: 'navigate', to: 'map' }, idle)).toBe('map');
    expect(viewAfterEvent('map', { kind: 'navigate', to: 'inbox' }, idle)).toBe('inbox');
  });

  it('navigate to Planning is refused while no planning session exists', () => {
    // The Plan tab only renders with a session, but the model still pins the
    // rule: there is nothing to show, so the view must not strand there.
    expect(viewAfterEvent('map', { kind: 'navigate', to: 'planning' }, idle)).toBe('map');
    expect(viewAfterEvent('map', { kind: 'navigate', to: 'planning' }, withPlanning)).toBe(
      'planning',
    );
  });

  it('an explicit project open lands the Launcher on the Map, a no-op elsewhere', () => {
    // Issue 81: opening a Project moves off the front door; opens made from
    // the Map (or anywhere else) stay put.
    expect(viewAfterEvent('launcher', { kind: 'project-opened' }, idle)).toBe('map');
    expect(viewAfterEvent('map', { kind: 'project-opened' }, idle)).toBe('map');
    expect(viewAfterEvent('pane', { kind: 'project-opened' }, withRun)).toBe('pane');
  });

  it('re-attaching a Window to its Project lands on the Map', () => {
    expect(viewAfterEvent('launcher', { kind: 'window-reattached' }, idle)).toBe('map');
  });

  it('an attention/Inbox click-through lands on the Map (issue 80)', () => {
    expect(viewAfterEvent('inbox', { kind: 'attention-opened' }, idle)).toBe('map');
  });

  it('starting a Run or a talk session lands on the Pane', () => {
    expect(viewAfterEvent('map', { kind: 'run-started' }, withRun)).toBe('pane');
    expect(viewAfterEvent('launcher', { kind: 'run-started' }, withRun)).toBe('pane');
  });

  it('starting a planning session lands on the Planning view', () => {
    expect(viewAfterEvent('launcher', { kind: 'planning-started' }, withPlanning)).toBe(
      'planning',
    );
  });

  it('a closed planning session moves a stranded Planning view to the Map', () => {
    // The view would otherwise render nothing (issue 83 / project switch).
    expect(viewAfterEvent('planning', { kind: 'planning-closed' }, idle)).toBe('map');
    expect(viewAfterEvent('pane', { kind: 'planning-closed' }, withRun)).toBe('pane');
    expect(viewAfterEvent('map', { kind: 'planning-closed' }, idle)).toBe('map');
  });
});
