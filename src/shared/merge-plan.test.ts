import { describe, it, expect } from 'vitest';
import { mergeReadiness, afkMergeConfContent, type MergeRun } from './merge-plan';

const run = (
  issueId: number,
  status: MergeRun['status'],
  isolated: boolean,
): MergeRun => ({ issueId, slug: `${String(issueId).padStart(2, '0')}-x`, status, isolated });

describe('mergeReadiness', () => {
  it('offers no Merge when nothing ran in a worktree (all solo/on main)', () => {
    const plan = mergeReadiness([run(3, 'finished', false), run(4, 'finished', false)]);
    expect(plan.ready).toBe(false);
    expect(plan.mergeable).toEqual([]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('offers no Merge while an isolated Run is still running', () => {
    const plan = mergeReadiness([run(3, 'finished', true), run(4, 'running', true)]);
    expect(plan.ready).toBe(false);
    // The finished branch is a candidate, but the batch is not done yet.
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([4]);
  });

  it('offers the Merge once every isolated Run has finished, listing the branches', () => {
    const plan = mergeReadiness([run(4, 'finished', true), run(3, 'finished', true)]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable).toEqual([
      { issueId: 3, slug: '03-x' },
      { issueId: 4, slug: '04-x' },
    ]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('merges only finished isolated Runs — a blocked sibling is excluded, not blocking', () => {
    const plan = mergeReadiness([run(3, 'finished', true), run(4, 'blocked', true)]);
    // No Run is still running, so the batch is done → ready, but only 03 merges.
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([3]);
    expect(plan.pendingRunning).toEqual([]);
  });

  it('ignores a solo Run that already has its work on main', () => {
    const plan = mergeReadiness([run(3, 'finished', false), run(4, 'finished', true)]);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((m) => m.issueId)).toEqual([4]);
  });

  it('is not ready when there are no Runs at all', () => {
    expect(mergeReadiness([]).ready).toBe(false);
  });
});

describe('afkMergeConfContent', () => {
  it('emits a single-repo REPOS entry pointing at the project root', () => {
    expect(afkMergeConfContent()).toContain('REPOS=( "app|." )');
  });

  it('honours a custom label', () => {
    expect(afkMergeConfContent('web')).toContain('REPOS=( "web|." )');
  });

  it('defines no CHOKEPOINTS so conflicts always stop for the human', () => {
    expect(afkMergeConfContent()).not.toContain('CHOKEPOINTS');
  });
});
