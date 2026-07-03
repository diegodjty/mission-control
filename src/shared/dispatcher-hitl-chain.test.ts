/**
 * Issue 53 — a parked HITL issue must RELIABLY, PROMINENTLY notify the user.
 *
 * This exercises the whole pure chain the Dispatcher runs when a drain reaches a
 * parked HITL Run, end to end, with no React/Electron in the way:
 *
 *   capture (parseCompletionBlock)
 *     → survives the noise floor (isRealCapture)
 *     → needs-verification + HITL issue → hitl-waiting (lifecycleKindForOutcome)
 *     → a proactive notification naming the issue + relaying its steps
 *        (reactToLifecycleEvent)
 *     → routed to the CHAT channel, not the ambient log
 *        (channelForAction(actionForLifecycle('hitl-waiting')))
 *
 * The App-level wiring (App.tsx) composes exactly these functions, so proving the
 * chain here is what guards the "the hitl-waiting event never fires" regression
 * (issue-51 verification) that this issue exists to kill. It also covers the two
 * things that made it unreliable in practice: a HITL block whose captured tail
 * carries EARLIER "Completed issue" scroll (the parser must still classify it
 * needs-verification), and the HITL flag arriving via EITHER frontmatter
 * `hitl: true` OR a `(HITL)` heading (the backlog derives both).
 */
import { describe, it, expect } from 'vitest';
import { parseCompletionBlock } from './completion-parser';
import { isRealCapture } from './dispatcher-noise-floor';
import {
  actionForLifecycle,
  lifecycleKindForOutcome,
  reactToLifecycleEvent,
  type LifecycleEvent,
} from './dispatcher-lifecycle';
import { channelForAction } from './dispatcher-channel';
import { buildBacklog, type RawFile } from './backlog-model';

const CONFIG = '## Active PRD\n\n`docs/PRD.md` — the PRD.\n';

// A parked HITL Worker's captured output as it really looks in a cap-2 drain: the
// tail-truncated session buffer carries an EARLIER completed-sibling line before
// the Run's own final "Ready for manual verification" block.
const PARKED_HITL_CAPTURE =
  '## Completed issue 03 — run-issue-in-pane\n\n' +
  '**What changed** — an earlier sibling in the same drain that really finished.\n\n' +
  'Ready for manual verification — issue 05 (live-map-updates)\n\n' +
  'This touches the live Map, so a human must confirm it on a real project.\n\n' +
  '**Try it yourself** — 1. Start a drain. 2. Watch the Map update as Runs flip. ' +
  '3. Confirm the parked issue shows as awaiting sign-off.';

/** Derive `isHitl` for issue 05 exactly as App.tsx does — from the backlog. */
function isHitlIssue(files: RawFile[], id: number): boolean {
  return buildBacklog(files, CONFIG).issues.find((i) => i.id === id)?.hitl ?? false;
}

/** Run the pure chain end to end for a captured HITL block + an isHitl flag. */
function chain(capture: string, isHitl: boolean): {
  outcome: string;
  real: boolean;
  notifications: { text: string; channel: 'chat' | 'log' }[];
} {
  const record = parseCompletionBlock(capture);
  const real = isRealCapture(record);
  const kind = lifecycleKindForOutcome(record.outcome, isHitl);
  const notifications: { text: string; channel: 'chat' | 'log' }[] = [];
  if (real && kind !== null && kind !== 'finished') {
    const event: LifecycleEvent = {
      kind,
      runId: 'sess-hitl-05',
      issueId: record.issueId,
      slug: 'live-map-updates',
      title: 'live-map-updates',
      detail: record.detail,
    };
    const reaction = reactToLifecycleEvent(event);
    if (reaction.notification !== null) {
      notifications.push({
        text: reaction.notification,
        channel: channelForAction(actionForLifecycle(kind)),
      });
    }
  }
  return { outcome: record.outcome, real, notifications };
}

describe('issue 53 — parked HITL Run reliably notifies the user (pure chain)', () => {
  it('captures the parked HITL block as needs-verification despite earlier completed scroll', () => {
    const record = parseCompletionBlock(PARKED_HITL_CAPTURE);
    expect(record.outcome).toBe('needs-verification');
    // The Run's OWN issue id (05), recovered from its final block, not the 03 scroll.
    expect(record.issueId).toBe(5);
    // The manual-verification steps survive as the captured detail (issue 42).
    expect(record.detail).toContain('Watch the Map update');
  });

  it('yields EXACTLY ONE prominent chat notification naming the issue + its steps', () => {
    const hitlFrontmatter = [
      { name: '05-live-map-updates.md', content: '---\nstatus: wip\ndepends_on: []\nhitl: true\n---\n\n# 05 — live-map-updates' } as RawFile,
    ];
    const result = chain(PARKED_HITL_CAPTURE, isHitlIssue(hitlFrontmatter, 5));

    // Survives the noise floor (issue 47) — a needs-verification capture is real.
    expect(result.real).toBe(true);
    expect(result.outcome).toBe('needs-verification');

    // Exactly one notification, and it goes to the CHAT (blocking) channel — NOT
    // swallowed by the ambient log (issue 48).
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].channel).toBe('chat');

    // It names the issue and relays the captured verification steps.
    const { text } = result.notifications[0];
    expect(text).toContain('issue 05');
    expect(text).toContain('Watch the Map update');
  });

  it('works whether HITL comes from frontmatter `hitl: true` OR a `(HITL)` heading', () => {
    const viaHeading = [
      { name: '05-live-map-updates.md', content: '---\nstatus: wip\ndepends_on: []\n---\n\n# 05 — live-map-updates (HITL)' } as RawFile,
    ];
    const result = chain(PARKED_HITL_CAPTURE, isHitlIssue(viaHeading, 5));
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].channel).toBe('chat');
    expect(result.notifications[0].text).toContain('issue 05');
  });

  it('a non-HITL issue with the SAME capture goes to the LOG, not the chat (routing hinges on the flag)', () => {
    const notHitl = [
      { name: '05-live-map-updates.md', content: '---\nstatus: wip\ndepends_on: []\n---\n\n# 05 — live-map-updates' } as RawFile,
    ];
    const result = chain(PARKED_HITL_CAPTURE, isHitlIssue(notHitl, 5));
    // Still surfaced (a needs-verification stall is not silently dropped)...
    expect(result.notifications).toHaveLength(1);
    // ...but as a routine ambient-log note, not a blocking chat prompt.
    expect(result.notifications[0].channel).toBe('log');
  });
});
