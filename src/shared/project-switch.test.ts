import { describe, expect, it } from 'vitest';
import { isProjectSwitch, scanForProject, type ScopedScan } from './project-switch';
import type { AfkBranchFacts } from './worktree-scan';

/** A minimal finished-unmerged branch fact for issue `id` in `slug`. */
function finishedBranch(id: number, slug: string): AfkBranchFacts {
  return {
    issueId: id,
    slug,
    hasWorktree: false,
    committedStatus: 'done',
    worktreeStatus: null,
    mergedIntoMain: false,
  };
}

describe('isProjectSwitch', () => {
  it('is a switch when opening the first Project (null → A)', () => {
    expect(isProjectSwitch(null, '/repo/a')).toBe(true);
  });

  it('is a switch when moving between two different Projects (A → B)', () => {
    expect(isProjectSwitch('/repo/a', '/repo/b')).toBe(true);
  });

  it('is NOT a switch when re-selecting the same Project (A → A)', () => {
    expect(isProjectSwitch('/repo/a', '/repo/a')).toBe(false);
  });

  it('is NOT a switch when the active repo becomes null (A → null)', () => {
    // Closing to the empty state shouldn't be treated as a Project switch to
    // reset against; there's no new Project to scope to.
    expect(isProjectSwitch('/repo/a', null)).toBe(false);
  });

  it('is NOT a switch when both are null', () => {
    expect(isProjectSwitch(null, null)).toBe(false);
  });
});

describe('scanForProject', () => {
  const scanA: ScopedScan = {
    projectPath: '/repo/a',
    branches: [finishedBranch(5, '05-thing')],
    midMerge: false,
  };

  it('surfaces a scan whose Project is the active one', () => {
    const view = scanForProject(scanA, '/repo/a');
    expect(view.branches).toEqual(scanA.branches);
    expect(view.midMerge).toBe(false);
  });

  it('carries the mid-merge flag through when the Project matches', () => {
    const midMergeScan: ScopedScan = { ...scanA, midMerge: true };
    expect(scanForProject(midMergeScan, '/repo/a').midMerge).toBe(true);
  });

  it('hides the previous Project scan the instant a different Project is active', () => {
    // Project B just became active; the stored scan still belongs to A. This is
    // the "no indicator until the new Project's fresh scan lands" case — and the
    // guard against A's `05` bleeding onto B's `05`.
    const view = scanForProject(scanA, '/repo/b');
    expect(view.branches).toEqual([]);
    expect(view.midMerge).toBe(false);
  });

  it('shows nothing while there is no scan yet (null)', () => {
    expect(scanForProject(null, '/repo/a')).toEqual({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    });
  });

  it('shows nothing when no Project is active (null active path)', () => {
    expect(scanForProject(scanA, null)).toEqual({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    });
  });

  it('carries merge previews + floor note through when the Project matches (issue 104)', () => {
    const withPreviews: ScopedScan = {
      ...scanA,
      previews: [{ issueId: 5, slug: '05-thing', verdict: { kind: 'clean' } }],
      previewNote: null,
    };
    const view = scanForProject(withPreviews, '/repo/a');
    expect(view.previews).toEqual([{ issueId: 5, slug: '05-thing', verdict: { kind: 'clean' } }]);
    expect(view.previewNote).toBeNull();
  });

  it('hides another Project scan\'s previews (no cross-Project badge, issue 104)', () => {
    const withPreviews: ScopedScan = {
      ...scanA,
      previews: [{ issueId: 5, slug: '05-thing', verdict: { kind: 'clean' } }],
      previewNote: null,
    };
    expect(scanForProject(withPreviews, '/repo/b').previews).toEqual([]);
  });

  it('defaults previews to [] and note to null for a scan taken before previews existed', () => {
    const view = scanForProject(scanA, '/repo/a');
    expect(view.previews).toEqual([]);
    expect(view.previewNote).toBeNull();
    expect(view.staleBuildNote).toBeNull();
  });

  it('carries the stale-build banner through when the Project matches (issue 173)', () => {
    const stale: ScopedScan = { ...scanA, staleBuildNote: 'old build, 9 commits behind' };
    expect(scanForProject(stale, '/repo/a').staleBuildNote).toBe('old build, 9 commits behind');
  });

  it('hides another Project scan\'s stale-build banner (issue 173)', () => {
    const stale: ScopedScan = { ...scanA, staleBuildNote: 'old build, 9 commits behind' };
    expect(scanForProject(stale, '/repo/b').staleBuildNote).toBeNull();
  });

  it('does not leak a stale scan kept after a transient error post-switch', () => {
    // The scan effect "keeps the last scan" on a transient git error. After a
    // switch to B, that stale scan is still tagged A, so the scoped view is
    // empty rather than B being shown A's branches.
    const staleAfterSwitch = scanForProject(scanA, '/repo/b');
    expect(staleAfterSwitch.branches).toEqual([]);
  });

  it('does not mutate the input scan', () => {
    const before = JSON.parse(JSON.stringify(scanA));
    scanForProject(scanA, '/repo/a');
    expect(scanA).toEqual(before);
  });
});
