import { describe, it, expect } from 'vitest';
import {
  deriveRunStatus,
  isTerminal,
  observedIssueStatus,
  runningIssueIds,
  shouldCommitWorktree,
  shouldCommitMain,
  decideSoloCommitStep,
  type RunStatus,
  type SoloCommitFacts,
} from './run-state';

describe('deriveRunStatus', () => {
  it('is running while the session is alive and the issue is not done', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: 'wip' }),
    ).toBe('running');
  });

  it('is finished once the issue flips to done, even if the session still lingers', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: 'done' }),
    ).toBe('finished');
  });

  it('is blocked when the session ends before the issue reaches done', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: 'wip' }),
    ).toBe('blocked');
  });

  it('is stopped when the user stopped it and the issue is not done', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: true, issueStatus: 'wip' }),
    ).toBe('stopped');
  });

  it('prefers finished over stopped when done was reached', () => {
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: true, issueStatus: 'done' }),
    ).toBe('finished');
  });

  it('treats an unobserved (null) issue status as not-done', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: null }),
    ).toBe('running');
    expect(
      deriveRunStatus({ sessionAlive: false, stoppedByUser: false, issueStatus: null }),
    ).toBe('blocked');
  });
});

describe('deriveRunStatus — the Receipt outcome joins the facts (issue 65)', () => {
  it('a needs-verification Receipt parks the Run while the session still lives', () => {
    // The walkthrough-58 third-attempt stall: a real claude Pane never exits —
    // it sits at its prompt after the park. The declared Receipt alone must
    // end the Run (terminal `parked`), freeing its slot; the Pane stays open.
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: 'needs-verification',
      }),
    ).toBe('parked');
  });

  it('a needs-verification Receipt also parks a Run whose session already ended', () => {
    // Same declared fact, dead session: still a park (success awaiting the
    // human), never a generic blocked.
    expect(
      deriveRunStatus({
        sessionAlive: false,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: 'needs-verification',
      }),
    ).toBe('parked');
  });

  it('a blocked Receipt with a live session ends the Run blocked', () => {
    // A blocked Worker also lingers at its prompt — the declared Receipt ends
    // the Run so today's conservative drain halt applies.
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: 'blocked',
      }),
    ).toBe('blocked');
  });

  it('no Receipt + live session + no done flip stays running (an active Worker is untouched)', () => {
    expect(
      deriveRunStatus({ sessionAlive: true, stoppedByUser: false, issueStatus: 'wip' }),
    ).toBe('running');
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: null,
      }),
    ).toBe('running');
  });

  it('only DECLARED park/blocked outcomes count — completed/unknown never end a live Run', () => {
    // A `completed` Receipt is judged by the done flip (state wins, ADR-0013);
    // an `unknown` outcome is not a declaration at all.
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: 'completed',
      }),
    ).toBe('running');
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'wip',
        receiptOutcome: 'unknown',
      }),
    ).toBe('running');
  });

  it('the done flip beats a needs-verification Receipt (the human verified and flipped)', () => {
    expect(
      deriveRunStatus({
        sessionAlive: true,
        stoppedByUser: false,
        issueStatus: 'done',
        receiptOutcome: 'needs-verification',
      }),
    ).toBe('finished');
  });

  it('a user stop beats the Receipt outcome', () => {
    expect(
      deriveRunStatus({
        sessionAlive: false,
        stoppedByUser: true,
        issueStatus: 'wip',
        receiptOutcome: 'needs-verification',
      }),
    ).toBe('stopped');
  });

  it('parked is terminal (the slot frees; polling stops)', () => {
    expect(isTerminal('parked')).toBe(true);
  });

  it('runningIssueIds excludes a parked Run (its issue no longer reads running)', () => {
    const runs = [
      { id: 5, status: 'parked' as RunStatus },
      { id: 6, status: 'running' as RunStatus },
    ];
    expect(runningIssueIds(runs, (r) => r.status, (r) => r.id)).toEqual([6]);
  });
});

describe('observedIssueStatus (issue 13 — which source to trust)', () => {
  it('an isolated Run reads its status from the worktree, ignoring main', () => {
    // The worktree flipped to done on the afk/ branch; main still says wip.
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'wip', worktreeStatus: 'done' }),
    ).toBe('done');
  });

  it('an isolated Run is not-done while its worktree still says wip', () => {
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'done', worktreeStatus: 'wip' }),
    ).toBe('wip');
  });

  it('an isolated Run whose worktree is not yet observed is null (not-done)', () => {
    expect(
      observedIssueStatus({ isolated: true, mainStatus: 'wip', worktreeStatus: null }),
    ).toBeNull();
  });

  it('a solo Run reads its status from the main backlog, ignoring any worktree value', () => {
    expect(
      observedIssueStatus({ isolated: false, mainStatus: 'done', worktreeStatus: null }),
    ).toBe('done');
    expect(
      observedIssueStatus({ isolated: false, mainStatus: 'wip', worktreeStatus: 'done' }),
    ).toBe('wip');
  });

  it('feeds deriveRunStatus so an isolated done-on-branch Run shows finished', () => {
    const isolatedFacts = {
      sessionAlive: true,
      stoppedByUser: false,
      issueStatus: observedIssueStatus({
        isolated: true,
        mainStatus: 'wip', // main-checkout watcher never saw the flip
        worktreeStatus: 'done', // but the worktree/branch did
      }),
    };
    expect(deriveRunStatus(isolatedFacts)).toBe('finished');
  });
});

describe('shouldCommitWorktree (issue 15 — when to auto-commit)', () => {
  it('commits an isolated Run once its worktree reaches done', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: 'done' })).toBe(true);
  });

  it('does not commit an isolated Run still wip (not finished yet)', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: 'wip' })).toBe(false);
  });

  it('does not commit an isolated Run whose worktree is not yet observed', () => {
    expect(shouldCommitWorktree({ isolated: true, worktreeStatus: null })).toBe(false);
  });

  it('never auto-commits a solo Run — it works on main and is left for review', () => {
    expect(shouldCommitWorktree({ isolated: false, worktreeStatus: 'done' })).toBe(false);
  });
});

describe('shouldCommitMain (issue 25 — when to commit a solo Run on main)', () => {
  it('commits a solo Run once its issue reaches done on main', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: 'done' })).toBe(true);
  });

  it('does not commit a solo Run still wip (blocked/stopped — left for the user)', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: 'wip' })).toBe(false);
  });

  it('does not commit a solo Run whose status is not yet observed', () => {
    expect(shouldCommitMain({ isolated: false, mainStatus: null })).toBe(false);
  });

  it('never commits an isolated Run here — it commits on its own afk branch', () => {
    expect(shouldCommitMain({ isolated: true, mainStatus: 'done' })).toBe(false);
  });
});

describe('decideSoloCommitStep (issue 59 — the solo finished-commit waits for the Receipt)', () => {
  const facts = (
    overrides: Partial<SoloCommitFacts> = {},
  ): SoloCommitFacts => ({
    runStatus: 'finished',
    isolated: false,
    phase: 'unstarted',
    receiptPresent: false,
    graceElapsed: false,
    ...overrides,
  });

  it('does nothing while the Run is not finished', () => {
    for (const runStatus of ['running', 'stopped', 'blocked'] as const) {
      expect(decideSoloCommitStep(facts({ runStatus }))).toEqual({ act: 'none' });
    }
  });

  it('never handles an isolated Run — it commits on its own afk branch', () => {
    expect(decideSoloCommitStep(facts({ isolated: true, receiptPresent: true }))).toEqual({
      act: 'none',
    });
  });

  it('commits at once when the Receipt is already present (ONE commit: work + flip + Receipt)', () => {
    expect(decideSoloCommitStep(facts({ receiptPresent: true }))).toEqual({
      act: 'commit',
      nextPhase: 'committed',
    });
  });

  it('waits (schedules the grace window) when the done flip is seen but no Receipt yet', () => {
    expect(decideSoloCommitStep(facts())).toEqual({ act: 'schedule-grace' });
  });

  it('keeps waiting inside the grace window — no commit, no re-schedule', () => {
    expect(decideSoloCommitStep(facts({ phase: 'waiting' }))).toEqual({ act: 'none' });
  });

  it('commits the moment the Receipt lands during the wait', () => {
    expect(decideSoloCommitStep(facts({ phase: 'waiting', receiptPresent: true }))).toEqual({
      act: 'commit',
      nextPhase: 'committed',
    });
  });

  it('commits WITHOUT the Receipt once the grace window elapses (no stall — the missing-receipt note is the signal)', () => {
    expect(decideSoloCommitStep(facts({ phase: 'waiting', graceElapsed: true }))).toEqual({
      act: 'commit',
      nextPhase: 'committed-sans-receipt',
    });
  });

  it('a Receipt present at grace expiry wins over the sans-receipt path', () => {
    expect(
      decideSoloCommitStep(
        facts({ phase: 'waiting', graceElapsed: true, receiptPresent: true }),
      ),
    ).toEqual({ act: 'commit', nextPhase: 'committed' });
  });

  it('commits a LATE Receipt as a straggler on the next observation (idempotent follow-up)', () => {
    expect(
      decideSoloCommitStep(
        facts({ phase: 'committed-sans-receipt', receiptPresent: true, graceElapsed: true }),
      ),
    ).toEqual({ act: 'commit', nextPhase: 'committed' });
  });

  it('stays quiet after a sans-receipt commit until a Receipt actually appears', () => {
    expect(
      decideSoloCommitStep(facts({ phase: 'committed-sans-receipt', graceElapsed: true })),
    ).toEqual({ act: 'none' });
  });

  it('never double-commits — a fully committed Run is terminal', () => {
    expect(
      decideSoloCommitStep(
        facts({ phase: 'committed', receiptPresent: true, graceElapsed: true }),
      ),
    ).toEqual({ act: 'none' });
  });
});

describe('runningIssueIds (issue 33 — the Map "running" / "Run in progress" set is status-filtered)', () => {
  interface FakeRun {
    issueId: number;
    status: RunStatus;
  }
  const statusOf = (r: FakeRun): RunStatus => r.status;
  const idOf = (r: FakeRun): number => r.issueId;

  it('excludes a finished tracked Run whose Pane is still on screen', () => {
    // This is the issue-33 bug: a solo Run reached `done` (finished) but its
    // Pane/tile has not been dismissed yet, so it is still a tracked Run.
    const runs: FakeRun[] = [
      { issueId: 2, status: 'finished' },
      { issueId: 5, status: 'running' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([5]);
  });

  it('excludes stopped and blocked Runs too — only `running` is live', () => {
    const runs: FakeRun[] = [
      { issueId: 1, status: 'stopped' },
      { issueId: 2, status: 'blocked' },
      { issueId: 3, status: 'finished' },
      { issueId: 4, status: 'running' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([4]);
  });

  it('is empty when every tracked Run has reached a terminal status', () => {
    const runs: FakeRun[] = [
      { issueId: 7, status: 'finished' },
      { issueId: 8, status: 'stopped' },
    ];
    expect(runningIssueIds(runs, statusOf, idOf)).toEqual([]);
  });

  it('does NOT return every tracked Run id (the pre-fix bug used runs.map(...) unfiltered)', () => {
    const runs: FakeRun[] = [
      { issueId: 2, status: 'finished' },
      { issueId: 5, status: 'running' },
    ];
    // The old `runs.map((r) => r.target.issueId)` returned [2, 5], marking the
    // finished issue 2 as still running. The filtered set must not.
    expect(runningIssueIds(runs, statusOf, idOf)).not.toContain(2);
  });
});

describe('isTerminal', () => {
  it('is false only while running', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('stopped')).toBe(true);
  });
});
