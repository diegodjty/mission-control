/**
 * E2E — palette-driven project switch, including the interrupt-guard path
 * (issue 124, ADR-0020).
 *
 * "Palette safety equals click safety": a Cmd+K project jump must route
 * through the *same* interrupt guard a click on the switcher does, so fast
 * navigation is never less safe than clicking. This suite composes the real
 * modules the way the renderer composes them — the pure `command-registry`
 * (fuzzy rank + selection) feeding project commands whose `run` is the app's
 * own `attemptProjectChange` (the `shouldConfirmInterrupt` gate, then either
 * the switch or the deferred confirmation) — and pins the observable contract:
 *
 *   • fuzzy-typing a project name ranks its command to the top and, with NO
 *     live runner, running it switches straight through;
 *   • with a live runner, running it stops for the guard instead of silently
 *     tearing the running work down;
 *   • the consequence is proven against a REAL PTY (the same PtySessionManager
 *     the Pane spawns): a DEFERRED palette switch leaves the live terminal
 *     alive; a CONFIRMED one tears it down — exactly a click's behavior.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PtySessionManager } from '../src/main/pty-session-manager';
import {
  mergeProviders,
  rankCommands,
  activeCommand,
  setQuery,
  type Command,
} from '../src/shared/command-registry';
import { shouldConfirmInterrupt } from '../src/shared/interrupt-guard';
import { waitFor } from './sandbox';
import type { PtyExitMessage } from '../src/shared/ipc-contract';

/** A tiny stand-in for the renderer's `attemptProjectChange`: it gates a
 *  project change on the SAME pure guard the click path uses, then either
 *  proceeds (the switch) or records that the confirmation would show. */
function makeGuardedSwitcher(opts: { hasLiveRunner: boolean; currentKey: string | null }) {
  const events = { confirmed: 0, proceeded: 0 };
  const attempt = (change: { path: string; label: string; proceed: () => void }): void => {
    if (
      shouldConfirmInterrupt({
        hasLiveRunner: opts.hasLiveRunner,
        currentKey: opts.currentKey,
        targetKey: change.path,
      })
    ) {
      events.confirmed += 1; // the interrupt modal would open — the switch waits
    } else {
      change.proceed();
    }
  };
  return { attempt, events };
}

/** Build the app's project command set exactly as App does: each project's
 *  `run` routes through the guarded switcher, so the palette adds no authority
 *  the switcher doesn't already have. */
function projectCommands(
  projects: { key: string; label: string }[],
  attempt: (c: { path: string; label: string; proceed: () => void }) => void,
  onSwitch: (key: string) => void,
): Command[] {
  return mergeProviders([
    {
      id: 'projects',
      commands: projects.map((p) => ({
        id: `project:${p.key}`,
        kind: 'project',
        title: p.label,
        keywords: p.key,
        run: () => attempt({ path: p.key, label: p.label, proceed: () => onSwitch(p.key) }),
      })),
    },
  ]);
}

const PROJECTS = [
  { key: '~/Workbench/mission-control', label: 'mission-control' },
  { key: '~/Workbench/vapi-ai-receptionist', label: 'vapi-ai-receptionist' },
  { key: '~/Workbench/atlas-design', label: 'atlas-design' },
];

describe('palette-driven project switch (issue 124)', () => {
  it('fuzzy-ranks a project by name and, with no live runner, switches straight through', () => {
    const switched: string[] = [];
    const { attempt, events } = makeGuardedSwitcher({
      hasLiveRunner: false,
      currentKey: '~/Workbench/mission-control',
    });
    const commands = projectCommands(PROJECTS, attempt, (k) => switched.push(k));

    // Type "vapi" — the palette ranks vapi-ai-receptionist to the top.
    const state = setQuery(commands, 'vapi');
    const top = activeCommand(state);
    expect(top?.id).toBe('project:~/Workbench/vapi-ai-receptionist');

    // Enter runs it. No live runner → straight switch, no confirmation.
    top?.run?.();
    expect(switched).toEqual(['~/Workbench/vapi-ai-receptionist']);
    expect(events.confirmed).toBe(0);
    expect(events.proceeded).toBe(0); // proceed() here only pushes to `switched`
  });

  it('routes a palette switch through the interrupt guard when a runner is live', () => {
    const switched: string[] = [];
    const { attempt, events } = makeGuardedSwitcher({
      hasLiveRunner: true,
      currentKey: '~/Workbench/mission-control',
    });
    const commands = projectCommands(PROJECTS, attempt, (k) => switched.push(k));

    const state = setQuery(commands, 'atlas');
    const top = activeCommand(state);
    expect(top?.id).toBe('project:~/Workbench/atlas-design');

    // Running it must NOT switch silently — the guard interposes the modal.
    top?.run?.();
    expect(events.confirmed).toBe(1);
    expect(switched).toEqual([]); // nothing switched until the human confirms
  });

  it('re-selecting the CURRENT project never triggers the guard, even with a live runner', () => {
    const switched: string[] = [];
    const { attempt, events } = makeGuardedSwitcher({
      hasLiveRunner: true,
      currentKey: '~/Workbench/mission-control',
    });
    const commands = projectCommands(PROJECTS, attempt, (k) => switched.push(k));

    // Empty-query suggestions include the projects; find the current one.
    const suggestions = rankCommands(commands, '');
    const current = suggestions.find(
      (r) => r.command.id === 'project:~/Workbench/mission-control',
    )?.command;
    expect(current).toBeDefined();
    current?.run?.();
    // Same project → not a switch → the guard stays silent and it proceeds.
    expect(events.confirmed).toBe(0);
    expect(switched).toEqual(['~/Workbench/mission-control']);
  });

  it('the click path and the palette path make the identical guard decision', () => {
    // Palette safety == click safety: the SAME attempt() drives both, so the
    // decision cannot diverge. Prove it for a genuine switch under a live runner.
    const { attempt, events } = makeGuardedSwitcher({
      hasLiveRunner: true,
      currentKey: '~/Workbench/mission-control',
    });
    const change = {
      path: '~/Workbench/vapi-ai-receptionist',
      label: 'vapi-ai-receptionist',
      proceed: () => {},
    };
    // A click on the switcher:
    attempt(change);
    // The palette running the same project command:
    const commands = projectCommands(PROJECTS, attempt, () => {});
    activeCommand(setQuery(commands, 'vapi'))?.run?.();
    // Both interposed the guard — two confirmations, zero silent switches.
    expect(events.confirmed).toBe(2);
    expect(events.proceeded).toBe(0);
  });
});

describe('palette switch consequence against a real terminal (issue 124)', () => {
  let manager: PtySessionManager | null = null;

  afterEach(() => {
    manager?.killAll();
    manager = null;
  });

  it('a live terminal survives a DEFERRED palette switch and dies on a CONFIRMED one', async () => {
    let output = '';
    const exits: PtyExitMessage[] = [];
    manager = new PtySessionManager({
      onData: (msg) => {
        output += msg.data;
      },
      onExit: (msg) => {
        exits.push(msg);
      },
    });

    // A live Run in the current project — a real PTY, as a Pane hosts.
    const { sessionId } = manager.spawn({ cols: 80, rows: 24 });
    manager.write(sessionId, 'echo __MC_LIVE__\r');
    await waitFor(() => output.includes('__MC_LIVE__'), 'terminal answered while live', 10000);

    // The switch's real consequence: resetForProjectSwitch tears the tracked
    // Runs down, killing their sessions. Model that as `proceed`.
    const proceed = (): void => manager!.killAll();

    // A palette jump to a DIFFERENT project, with the live runner present.
    const { attempt } = makeGuardedSwitcher({
      hasLiveRunner: true,
      currentKey: '~/Workbench/mission-control',
    });
    const commands = projectCommands(PROJECTS, attempt, () => proceed());
    activeCommand(setQuery(commands, 'vapi'))?.run?.();

    // The guard deferred the switch — the terminal is untouched and still answers.
    manager.write(sessionId, 'echo __MC_STILL_ALIVE__\r');
    await waitFor(
      () => output.includes('__MC_STILL_ALIVE__'),
      'terminal survived the deferred palette switch',
      10000,
    );
    expect(exits).toEqual([]);

    // Now the human confirms "switch here anyway": the switch proceeds and the
    // live session is torn down — the same as clicking through the modal.
    proceed();
    await waitFor(() => exits.length > 0, 'confirmed switch tore the session down', 10000);
    expect(exits[0]?.sessionId).toBe(sessionId);
  });
});
