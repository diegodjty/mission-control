import { describe, it, expect } from 'vitest';
import { summarizeRunGuidance, describeRunGuidance } from './run-guidance';
import type { BacklogIssue, IssueStatus } from './backlog-model';

/** Minimal issue factory — only the fields the guidance logic reads. */
function mk(id: number, status: IssueStatus, dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue ${id}`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    runTimeoutMinutes: null,
    touches: [],
    inBatch: true,
    standalone: false,
    body: '',
  };
}

describe('summarizeRunGuidance', () => {
  it('reports the empty backlog as `empty`', () => {
    expect(summarizeRunGuidance([])).toEqual({ kind: 'empty' });
  });

  it('lists every currently-runnable issue, ascending by id', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]); // eligible
    const three = mk(3, 'open'); // eligible, no deps
    const four = mk(4, 'open', [3]); // blocked (3 not done)
    const guidance = summarizeRunGuidance([two, four, three, one]);
    expect(guidance).toEqual({
      kind: 'eligible',
      runnable: [
        { id: 2, title: '2 — issue 2', fileName: '02-slug.md' },
        { id: 3, title: '3 — issue 3', fileName: '03-slug.md' },
      ],
    });
  });

  it('never lists a wip or done issue as runnable', () => {
    const one = mk(1, 'wip');
    const two = mk(2, 'done');
    const three = mk(3, 'open', [2]); // eligible (dep done)
    const guidance = summarizeRunGuidance([one, two, three]);
    expect(guidance.kind).toBe('eligible');
    if (guidance.kind === 'eligible') {
      expect(guidance.runnable.map((r) => r.id)).toEqual([3]);
    }
  });

  it('when nothing is eligible, names the open issues and their unmet blockers', () => {
    // 03 is wip; 06 and 09 both depend on it → both blocked, none eligible.
    const three = mk(3, 'wip');
    const six = mk(6, 'open', [3]);
    const nine = mk(9, 'open', [3]);
    const guidance = summarizeRunGuidance([three, six, nine]);
    expect(guidance).toEqual({
      kind: 'blocked',
      blocked: [
        { id: 6, title: '6 — issue 6', unmet: [{ id: 3, title: '3 — issue 3', status: 'wip' }] },
        { id: 9, title: '9 — issue 9', unmet: [{ id: 3, title: '3 — issue 3', status: 'wip' }] },
      ],
    });
  });

  it('reports `settled` when every issue is done and/or wip', () => {
    const guidance = summarizeRunGuidance([mk(1, 'done'), mk(2, 'wip'), mk(3, 'done')]);
    expect(guidance).toEqual({ kind: 'settled', doneCount: 2, wipCount: 1 });
  });
});

describe('describeRunGuidance', () => {
  it('phrases the eligible set with count and ids', () => {
    const guidance = summarizeRunGuidance([mk(4, 'open'), mk(5, 'open')]);
    expect(describeRunGuidance(guidance)).toBe('You can Run 2 issues right now: 04, 05.');
  });

  it('uses the singular for a lone runnable issue', () => {
    const guidance = summarizeRunGuidance([mk(4, 'open')]);
    expect(describeRunGuidance(guidance)).toBe('You can Run 1 issue right now: 04.');
  });

  it('groups blocked issues sharing a blocker (the reported anti-pattern state)', () => {
    const three = mk(3, 'wip');
    const six = mk(6, 'open', [3]);
    const nine = mk(9, 'open', [3]);
    const guidance = summarizeRunGuidance([three, six, nine]);
    expect(describeRunGuidance(guidance)).toBe(
      'No eligible issues to Run — 06, 09 waiting on 03 (wip).',
    );
  });

  it('names a missing dependency explicitly', () => {
    const guidance = summarizeRunGuidance([mk(6, 'open', [99])]);
    expect(describeRunGuidance(guidance)).toBe(
      'No eligible issues to Run — 06 waiting on 99 (missing).',
    );
  });

  it('states everything is done/wip when settled', () => {
    const guidance = summarizeRunGuidance([mk(1, 'done'), mk(2, 'wip')]);
    expect(describeRunGuidance(guidance)).toBe(
      'No eligible issues to Run — every issue is done or wip (1 done, 1 wip).',
    );
  });

  it('handles the empty backlog', () => {
    expect(describeRunGuidance(summarizeRunGuidance([]))).toBe('No issues in this backlog.');
  });
});

describe('summarizeRunGuidance with on-disk worktree scan (issue 21)', () => {
  it('does not list an issue running in a worktree as runnable, though main reads open', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]); // eligible on main
    const three = mk(3, 'open', [1]); // eligible on main
    // Issue 2 has a live Run in its worktree — must drop out of the runnable set.
    const guidance = summarizeRunGuidance([one, two, three], { worktreeRunningIds: [2] });
    expect(guidance.kind).toBe('eligible');
    if (guidance.kind === 'eligible') {
      expect(guidance.runnable.map((r) => r.id)).toEqual([3]);
    }
  });

  it('does not list a finished-but-unmerged issue as runnable', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    const guidance = summarizeRunGuidance([one, two], { finishedUnmergedIds: [2] });
    // 2 is the only eligible-on-main issue but it's finished-unmerged → nothing
    // runnable, and it must NOT be reported as blocked either (it's being worked).
    expect(guidance).toEqual({ kind: 'settled', doneCount: 1, wipCount: 0 });
  });

  it('omits an in-flight open issue from the blocked listing (not runnable, not blocked)', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]); // running in a worktree
    const three = mk(3, 'open', [99]); // genuinely blocked (missing dep)
    const guidance = summarizeRunGuidance([one, two, three], { worktreeRunningIds: [2] });
    expect(guidance).toEqual({
      kind: 'blocked',
      blocked: [
        { id: 3, title: '3 — issue 3', unmet: [{ id: 99, status: 'missing', title: null }] },
      ],
    });
  });

  it('is unaffected by the scan when the in-flight id names an issue with no dependents', () => {
    const one = mk(1, 'done');
    const two = mk(2, 'open'); // eligible, no dependencies at all
    // 1's finished-unmerged state can't hold back an issue that doesn't depend
    // on it.
    const guidance = summarizeRunGuidance([one, two], { finishedUnmergedIds: [1] });
    expect(guidance.kind).toBe('eligible');
    if (guidance.kind === 'eligible') {
      expect(guidance.runnable.map((r) => r.id)).toEqual([2]);
    }
  });

  it('holds a dependent waiting-on-merge rather than reporting it blocked (issue 147, ADR-0021)', () => {
    // 1 is done but still finished-unmerged; 2's only dependency is 1. 2 is
    // neither runnable (the lane hasn't landed 1 yet) nor "blocked" in the
    // actionable sense — the Map already carries its own waiting-on-merge state.
    const one = mk(1, 'done');
    const two = mk(2, 'open', [1]);
    const guidance = summarizeRunGuidance([one, two], { finishedUnmergedIds: [1] });
    expect(guidance).toEqual({ kind: 'settled', doneCount: 1, wipCount: 0 });
  });
});
