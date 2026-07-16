/**
 * E2E shell keep-mounted invariant (issue 123, ADR-0020) — a live Run's
 * terminal survives a view round-trip.
 *
 * The seam under test is the one the AppShell extraction re-plumbed: the
 * renderer hosts every tracked Run's Pane in a keep-mounted slot, and a
 * Pane's unmount is what kills its PTY session (Pane.tsx cleanup calls
 * killPty). So the invariant "navigation never kills work in flight" holds
 * exactly when `shell-model`'s hosting decision keeps the Pane host mounted
 * through any view sequence while a Run is tracked.
 *
 * This suite drives that decision against a REAL PTY (the real
 * PtySessionManager spawning the real shell — the same adapter a Pane's
 * spawn reaches over IPC, no LLM anywhere): the model says "still mounted"
 * at every stop of the round-trip, so no kill is ever issued, and the
 * terminal proves it is genuinely alive by answering AFTER the trip. The
 * contrast case pins the consequence half (an unmount kill really tears the
 * session down), so the pair fails loudly if either side of the contract
 * drifts. The visual half — display toggling and xterm re-fit in the live
 * Electron shell — is declared manual-only below, never silently skipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PtySessionManager } from '../src/main/pty-session-manager';
import {
  isSlotMounted,
  viewAfterEvent,
  type ShellContext,
  type ViewId,
} from '../src/shared/shell-model';
import { waitFor } from './sandbox';
import type { PtyExitMessage } from '../src/shared/ipc-contract';

describe('shell keep-mounted invariant (issue 123)', () => {
  let manager: PtySessionManager | null = null;

  afterEach(() => {
    manager?.killAll();
    manager = null;
  });

  it('a live Run terminal survives a full view round-trip (no kill decision, PTY answers after)', async () => {
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

    // One tracked Run → its Pane hosts a real PTY session. A plain shell
    // stands in for the Run's `claude` process (scripted/no-LLM rule); the
    // spawn/kill seam is identical.
    const { sessionId } = manager.spawn({ cols: 80, rows: 24 });
    const ctx: ShellContext = { hasPlanning: false, runCount: 1, hasTalk: false, attentionNeedsYou: 0 };

    // Prove the terminal is live before the trip.
    manager.write(sessionId, 'echo __MC_BEFORE_TRIP__\r');
    await waitFor(
      () => output.includes('__MC_BEFORE_TRIP__'),
      'shell answered before the round-trip',
      10000,
    );

    // The round-trip, moved by the same pure transitions the renderer
    // applies: pane → map → launcher → inbox → pane. Mirror the AppShell
    // contract at every stop — a session is killed IFF its host unmounts —
    // so a single false from isSlotMounted would kill the session here.
    let view: ViewId = viewAfterEvent('map', { kind: 'run-started' }, ctx);
    expect(view).toBe('pane');
    const trip: ViewId[] = ['map', 'launcher', 'inbox', 'pane'];
    for (const to of trip) {
      view = viewAfterEvent(view, { kind: 'navigate', to }, ctx);
      expect(view).toBe(to);
      if (!isSlotMounted('pane', view, ctx)) {
        manager.kill(sessionId); // the AppShell contract: unmount = kill
      }
      expect(isSlotMounted('pane', view, ctx)).toBe(true);
    }

    // The terminal is STILL alive after the trip: it answers, and no exit
    // was ever observed.
    manager.write(sessionId, 'echo __MC_AFTER_TRIP__\r');
    await waitFor(
      () => output.includes('__MC_AFTER_TRIP__'),
      'shell answered after the round-trip',
      10000,
    );
    expect(exits).toEqual([]);
  });

  it('contrast: an unmount kill genuinely tears the session down', async () => {
    const exits: PtyExitMessage[] = [];
    manager = new PtySessionManager({
      onData: () => {},
      onExit: (msg) => {
        exits.push(msg);
      },
    });
    const { sessionId } = manager.spawn({ cols: 80, rows: 24 });

    // With NOTHING live (no Run, no talk), the pane host is remount-on-visit:
    // navigating away unmounts it, and the unmount kills the session. This is
    // exactly why the keep-mounted policy above is load-bearing.
    const ctx: ShellContext = { hasPlanning: false, runCount: 0, hasTalk: false, attentionNeedsYou: 0 };
    expect(isSlotMounted('pane', 'pane', ctx)).toBe(true);
    expect(isSlotMounted('pane', 'map', ctx)).toBe(false);
    manager.kill(sessionId); // the AppShell contract: unmount = kill

    await waitFor(() => exits.length > 0, 'killed session reported its exit', 10000);
    expect(exits[0]?.sessionId).toBe(sessionId);
  });
});

describe('manual-only — needs the live Electron shell (declared, not silently skipped)', () => {
  it.skip('manual-only: the hidden Pane grid re-fits its xterm terminals when shown again — reason: ResizeObserver + xterm in the real renderer; the mount decision feeding it is asserted above', () => {});
  it.skip('manual-only: the tracer interrupt dialog renders correctly in BOTH themes (toggle while open) — reason: Radix portal + CSS tokens in the real renderer; the dialog logic is behavior-tested via interrupt-guard unit tests', () => {});
});
