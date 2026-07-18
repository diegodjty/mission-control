import { describe, it, expect } from 'vitest';
import { planDrain } from './run-coordinator';
import {
  repoForIssue,
  unknownRepoKeyNote,
  plannedRepoHoldNote,
  type RunTargetProject,
} from './run-targeting';
import type { BacklogIssue, IssueStatus } from './backlog-model';

/**
 * Issue 96 (ADR-0017) — the drain HOLDS a `planned`-targeted issue (declared
 * repo not yet created) rather than erroring it, while its siblings proceed; a
 * genuinely unknown `repo:` key is still flagged distinctly. These assert the
 * exact composition App.tsx wires — resolve every issue's `repo:` through
 * `repoForIssue`, drop the unresolvable ones from the plan (with the right
 * note), and hand the rest to `planDrain` — without a component-test harness.
 */

function mk(id: number, status: IssueStatus, dependsOn: number[], repoKey: string | null): BacklogIssue {
  return {
    id,
    slug: `slug-${id}`,
    fileName: `${String(id).padStart(2, '0')}-slug.md`,
    title: `${id} — issue`,
    status,
    dependsOn,
    parent: 'docs/PRD.md',
    source: null,
    hitl: false,
    repoKey,
    model: null,
    effort: null,
    inBatch: true,
    standalone: false,
    body: '',
  };
}

/** The drain's pre-plan filter, mirrored from App.tsx's drain effect. */
function filterPlannable(issues: BacklogIssue[], target: RunTargetProject): {
  plannable: BacklogIssue[];
  notes: string[];
} {
  const notes: string[] = [];
  const plannable = issues.filter((issue) => {
    const resolution = repoForIssue(target, issue.repoKey);
    if (resolution.ok) return true;
    notes.push(
      resolution.reason === 'planned'
        ? plannedRepoHoldNote(issue.id, resolution.repoKey)
        : unknownRepoKeyNote(issue.id, resolution.unknownKey, Object.keys(target.repos)),
    );
    return false;
  });
  return { plannable, notes };
}

describe('drain holds planned-targeted issues, flags unknown ones (issue 96)', () => {
  // 01 creates `api` (no repo: key → the workspace root); 02 targets `api` and
  // depends on 01; 03 is an unrelated sibling; 04 names a bogus key (typo).
  const issues = [
    mk(1, 'open', [], null),
    mk(2, 'open', [1], 'api'),
    mk(3, 'open', [], null),
    mk(4, 'open', [], 'bogus'),
  ];

  // `api` is DECLARED but not yet on disk → planned. `bogus` is not declared.
  const target: RunTargetProject = {
    repos: { api: '/ws/api' },
    defaultRepoPath: '/ws',
    plannedRepoKeys: ['api'],
  };

  it('holds the planned issue (not errored) and flags the unknown one distinctly', () => {
    const { plannable, notes } = filterPlannable(issues, target);

    // The planned issue (02) and the unknown one (04) are both dropped from the
    // plan; 01 and 03 remain plannable.
    expect(plannable.map((i) => i.id).sort()).toEqual([1, 3]);

    // Exactly two notes — a HOLD for the plan, an ERROR for the typo — worded
    // distinctly so a plan never reads as a mistake.
    expect(notes).toHaveLength(2);
    const holdNote = notes.find((n) => n.includes('planned'));
    const errorNote = notes.find((n) => n.includes('unknown repo key'));
    expect(holdNote).toBe(plannedRepoHoldNote(2, 'api'));
    expect(holdNote).toContain('held');
    expect(holdNote).not.toContain('unknown');
    expect(errorNote).toBe(unknownRepoKeyNote(4, 'bogus', ['api']));
  });

  it('siblings drain normally — the held issue does not stall the plan', () => {
    const { plannable } = filterPlannable(issues, target);
    const plan = planDrain({ issues: plannable, maxConcurrent: 5, activeRuns: [] });
    // 01 and 03 have no unmet deps → startable now. 02 is held, so it is not in
    // the plan at all; 04 is excluded as an error. The drain does not stop.
    expect(plan.drain.stop).toBe(false);
    expect(plan.startable.sort()).toEqual([1, 3]);
    expect(plan.startable).not.toContain(2);
    expect(plan.startable).not.toContain(4);
  });

  it('once the planned repo exists (and 01 is done), the held issue resolves and runs', () => {
    // 01 has created `api`, so it drops out of plannedRepoKeys (issue 95 would
    // have registered it); its directory now exists.
    const real: RunTargetProject = { ...target, plannedRepoKeys: [] };
    const advanced = [
      mk(1, 'done', [], null),
      mk(2, 'open', [1], 'api'),
      mk(3, 'done', [], null),
      mk(4, 'open', [], 'bogus'),
    ];

    const { plannable, notes } = filterPlannable(advanced, real);
    // 02 now resolves cleanly — no hold note for it anymore. 04 still errors.
    expect(plannable.map((i) => i.id)).toContain(2);
    expect(notes).toEqual([unknownRepoKeyNote(4, 'bogus', ['api'])]);

    const plan = planDrain({ issues: plannable, maxConcurrent: 5, activeRuns: [] });
    // With its dependency done and its repo real, 02 is now startable.
    expect(plan.startable).toContain(2);
    // And it resolves to the real repo path — no guess.
    expect(repoForIssue(real, 'api')).toEqual({ ok: true, repoPath: '/ws/api' });
  });
});
