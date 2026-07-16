import { describe, it, expect } from 'vitest';
import {
  mergeProviders,
  fuzzyScore,
  rankCommands,
  openPalette,
  setQuery,
  moveActive,
  setActive,
  activeCommand,
  type Command,
  type CommandProvider,
} from './command-registry';

/** A tiny command factory so the tests read as data, not boilerplate. */
function cmd(id: string, kind: Command['kind'], title: string, extra: Partial<Command> = {}): Command {
  return { id, kind, title, ...extra };
}

describe('mergeProviders', () => {
  it('flattens providers in order, preserving within-provider order', () => {
    const projects: CommandProvider = {
      id: 'projects',
      commands: [cmd('project:a', 'project', 'alpha'), cmd('project:b', 'project', 'beta')],
    };
    const views: CommandProvider = {
      id: 'views',
      commands: [cmd('view:map', 'view', 'Map'), cmd('view:pane', 'view', 'Pane')],
    };
    const merged = mergeProviders([projects, views]);
    expect(merged.map((c) => c.id)).toEqual(['project:a', 'project:b', 'view:map', 'view:pane']);
  });

  it('dedupes by command id — the FIRST provider to claim an id wins', () => {
    const first: CommandProvider = {
      id: 'first',
      commands: [cmd('view:map', 'view', 'Map (first)')],
    };
    const second: CommandProvider = {
      id: 'second',
      commands: [cmd('view:map', 'view', 'Map (second)'), cmd('view:pane', 'view', 'Pane')],
    };
    const merged = mergeProviders([first, second]);
    expect(merged.map((c) => c.id)).toEqual(['view:map', 'view:pane']);
    expect(merged.find((c) => c.id === 'view:map')?.title).toBe('Map (first)');
  });

  it('is empty for no providers and skips empty providers', () => {
    expect(mergeProviders([])).toEqual([]);
    expect(mergeProviders([{ id: 'empty', commands: [] }])).toEqual([]);
  });
});

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('Map', 'xyz')).toBeNull();
    expect(fuzzyScore('Map', 'mp x')).toBeNull(); // the trailing x has no home
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('Mission Control', 'MISSION')).not.toBeNull();
    expect(fuzzyScore('Mission Control', 'mission')).toEqual(fuzzyScore('MISSION CONTROL', 'Mission'));
  });

  it('scores a prefix higher than a mid-string match of the same query', () => {
    const prefix = fuzzyScore('map', 'map')!;
    const mid = fuzzyScore('sitemap', 'map')!;
    expect(prefix).toBeGreaterThan(mid);
  });

  it('rewards word-boundary matches over scattered ones', () => {
    const boundary = fuzzyScore('command palette', 'cp')!; // c(ommand) p(alette)
    const scattered = fuzzyScore('capture', 'cp')!; // c…p inside one word
    expect(boundary).toBeGreaterThan(scattered);
  });

  it('treats spaces in the query as soft gaps', () => {
    expect(fuzzyScore('New project', 'new proj')).not.toBeNull();
    expect(fuzzyScore('New project', 'newproject')).not.toBeNull();
  });

  it('matches a blank query with a neutral zero', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
    expect(fuzzyScore('anything', '   ')).toBe(0);
  });
});

describe('rankCommands', () => {
  const commands: Command[] = [
    cmd('project:mc', 'project', 'mission-control', { keywords: 'mission-control backlog' }),
    cmd('project:vapi', 'project', 'vapi-ai-receptionist', { keywords: 'vapi draining' }),
    cmd('view:home', 'view', 'Home', { hint: 'Go to Home' }),
    cmd('view:map', 'view', 'Map', { hint: 'Go to Map' }),
    cmd('view:pane', 'view', 'Pane', { hint: 'Go to Pane' }),
    cmd('action:new', 'action', 'New project'),
    cmd('action:theme', 'action', 'Toggle theme'),
    cmd('issue:124', 'issue', 'New shell: rail + header', { keywords: '124 shell-rail-header' }),
  ];

  it('on a blank query returns the suggestion set — no issues — ordered projects, views, actions', () => {
    const ranked = rankCommands(commands, '');
    const kinds = ranked.map((r) => r.command.kind);
    expect(kinds).not.toContain('issue');
    // kind priority: every project before every view before every action
    const firstView = kinds.indexOf('view');
    const firstAction = kinds.indexOf('action');
    expect(kinds.lastIndexOf('project')).toBeLessThan(firstView);
    expect(kinds.lastIndexOf('view')).toBeLessThan(firstAction);
  });

  it('surfaces issues once the user types', () => {
    const ranked = rankCommands(commands, 'shell');
    expect(ranked.some((r) => r.command.id === 'issue:124')).toBe(true);
  });

  it('ranks an exact-prefix title match at the top', () => {
    const ranked = rankCommands(commands, 'map');
    expect(ranked[0]?.command.id).toBe('view:map');
  });

  it('matches a project by its keywords, not just its title', () => {
    const ranked = rankCommands(commands, 'draining');
    expect(ranked[0]?.command.id).toBe('project:vapi');
  });

  it('drops non-matching commands entirely', () => {
    const ranked = rankCommands(commands, 'zzzq');
    expect(ranked).toEqual([]);
  });

  it('is deterministic — same input, same order', () => {
    expect(rankCommands(commands, 'ne')).toEqual(rankCommands(commands, 'ne'));
  });
});

describe('selection state machine', () => {
  const commands: Command[] = [
    cmd('view:home', 'view', 'Home'),
    cmd('view:map', 'view', 'Map'),
    cmd('view:pane', 'view', 'Pane'),
    cmd('action:theme', 'action', 'Toggle theme'),
  ];

  it('opens on an empty query with the top row active', () => {
    const state = openPalette(commands);
    expect(state.query).toBe('');
    expect(state.activeIndex).toBe(0);
    expect(state.ranked.length).toBeGreaterThan(0);
    expect(activeCommand(state)?.kind).toBe('view');
  });

  it('moves the highlight down and up, wrapping at both ends', () => {
    let state = openPalette(commands);
    const n = state.ranked.length;
    state = moveActive(state, 1);
    expect(state.activeIndex).toBe(1);
    // wrap past the last row → back to the first
    for (let i = 1; i < n; i++) state = moveActive(state, 1);
    expect(state.activeIndex).toBe(0);
    // Up from the first → the last
    state = moveActive(state, -1);
    expect(state.activeIndex).toBe(n - 1);
  });

  it('resets the highlight to the top when the query changes', () => {
    let state = openPalette(commands);
    state = moveActive(state, 2);
    expect(state.activeIndex).toBe(2);
    state = setQuery(commands, 'map');
    expect(state.activeIndex).toBe(0);
    expect(activeCommand(state)?.id).toBe('view:map');
  });

  it('setActive clamps to the result range and hover picks that row', () => {
    let state = openPalette(commands);
    state = setActive(state, 99);
    expect(state.activeIndex).toBe(state.ranked.length - 1);
    state = setActive(state, -5);
    expect(state.activeIndex).toBe(0);
  });

  it('activeCommand is null when nothing matches, and move is a no-op', () => {
    let state = openPalette(commands);
    state = setQuery(commands, 'zzzq');
    expect(state.ranked).toEqual([]);
    expect(activeCommand(state)).toBeNull();
    state = moveActive(state, 1);
    expect(state.activeIndex).toBe(0);
  });
});
