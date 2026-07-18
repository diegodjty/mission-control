import { describe, expect, it } from 'vitest';
import {
  checkpointCommitAction,
  decideDispatcherStep,
} from './dispatcher-bridge';
import { planDrain, type DrainInput } from './run-coordinator';
import type { BacklogIssue } from './backlog-model';

function issue(id: number, status: BacklogIssue['status'], dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `i${id}`,
    fileName: `${String(id).padStart(2, '0')}-i${id}.md`,
    title: `${id} — issue ${id}`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

// A 2-issue drain, cap 1: exactly the tracer-bullet scenario.
function twoIssueDrain(): DrainInput {
  return {
    issues: [issue(1, 'open'), issue(2, 'open')],
    maxConcurrent: 1,
    activeRuns: [],
  };
}

describe('dispatcher ↔ coordinator bridge (ADR-0008: scheduling delegated)', () => {
  it('forwards the Run Coordinator plan UNCHANGED (no LLM queue math)', () => {
    const input: DrainInput = {
      issues: [issue(1, 'open'), issue(2, 'open'), issue(3, 'open', [1])],
      maxConcurrent: 2,
      activeRuns: [],
    };
    const decision = decideDispatcherStep(input);
    // The bridge's plan is byte-for-byte the Coordinator's — it re-implements
    // nothing. If this ever diverged, the LLM would be doing scheduling.
    expect(decision.plan).toEqual(planDrain(input));
  });

  it('for a 2-issue drain under cap 1, starts the first and queues the second', () => {
    const decision = decideDispatcherStep(twoIssueDrain());
    expect(decision.plan.startable).toEqual([1]);
    expect(decision.plan.queued).toEqual([2]);
    expect(decision.plan.drain.stop).toBe(false);
  });

  it('emits a start-next (silent) action when the Coordinator has startable work', () => {
    const decision = decideDispatcherStep(twoIssueDrain());
    const startNext = decision.actions.find((a) => a.action === 'start-next');
    expect(startNext).toBeDefined();
    // ADR-0011: starting the next Run is a silent mechanic (never a gate).
    expect(startNext?.authority).toBe('silent');
    // synthesize is always available and always silent.
    const synth = decision.actions.find((a) => a.action === 'synthesize');
    expect(synth?.authority).toBe('silent');
  });

  it('issues no start-next once the drain stops, but can still synthesize', () => {
    // Both issues done, nothing running ⇒ Coordinator says stop (no-eligible).
    const decision = decideDispatcherStep({
      issues: [issue(1, 'done'), issue(2, 'done')],
      maxConcurrent: 1,
      activeRuns: [],
    });
    expect(decision.plan.drain.stop).toBe(true);
    expect(decision.actions.some((a) => a.action === 'start-next')).toBe(false);
    expect(decision.actions.some((a) => a.action === 'synthesize')).toBe(true);
  });

  it('the inter-issue checkpoint commit is a passive note (ADR-0011)', () => {
    const checkpoint = checkpointCommitAction();
    expect(checkpoint.action).toBe('commit-checkpoint');
    // A committed checkpoint is non-blocking — a passive note, not a gate.
    expect(checkpoint.authority).toBe('passive');
  });
});
