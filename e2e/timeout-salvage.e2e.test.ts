/**
 * E2E timeout-salvage (issue 170) — a `run_timeout` kill (issue 141) must not
 * silently strand a worktree. This drives the REAL modules (real git worktree,
 * a real `npm` verify spawn, the real drain planner) against a scripted
 * "Worker died mid-timeout" fixture (`e2e/fake-worker.ts`'s `die-mid-exit`
 * misbehavior — flips its issue `done`, writes its deliverable, but commits
 * nothing and writes no Receipt: exactly the shape of the live 2026-07-19
 * incident this issue is direct feedback on).
 *
 * Two scenarios, matching the issue's acceptance criteria:
 *   - green:  the stranded worktree's work verifies clean → Complete from
 *             worktree commits it, and a DEPENDENT issue becomes startable —
 *             the chain continues, nothing stayed silently stuck.
 *   - broken: the stranded worktree's work fails verify → Discard & requeue
 *             throws it away and reopens the issue for the drain to retry —
 *             surfaced, not a silent stall.
 *
 * No LLM anywhere. `npm run type-check`/`npm run test` are real spawns against
 * a synthetic `package.json` (the sandbox repo has no real toolchain of its
 * own) whose scripts are engineered to exit 0 (green) or 1 (broken) — proving
 * `verifyWorktree` genuinely gates on command exit codes, not a guess.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, issueFileContent, sandboxIssue, seedSandbox, type Sandbox } from './sandbox';
import { runFakeWorker } from './fake-worker';
import { branchFor } from '../src/shared/isolation-policy';
import {
  createWorktree,
  worktreePathFor,
  commitFinishedWorktree,
  discardWorktree,
  readCommittedIssueStatus,
  readIssueStatusAt,
} from '../src/main/git-worktree-adapter';
import { verifyWorktree } from '../src/main/worktree-verify';
import { planDrain } from '../src/shared/run-coordinator';
import { readBacklogAt } from '../src/main/backlog-reader';

const scratches: string[] = [];

afterEach(async () => {
  for (const s of scratches.splice(0)) await rm(s, { recursive: true, force: true });
});

async function seed(): Promise<Sandbox> {
  const sandbox = await seedSandbox();
  scratches.push(sandbox.scratch);
  return sandbox;
}

/** A synthetic `package.json` whose `type-check`/`test` scripts exit 0 or 1 — the
 *  sandbox repo has no real toolchain, so this is what `verifyWorktree` gates on. */
async function writeVerifyFixture(worktreePath: string, passing: boolean): Promise<void> {
  const exitCode = passing ? '0' : '1';
  await writeFile(
    join(worktreePath, 'package.json'),
    JSON.stringify(
      {
        name: 'salvage-fixture',
        scripts: { 'type-check': `exit 0`, test: `exit ${exitCode}` },
      },
      null,
      2,
    ),
  );
}

/** Strand a worktree exactly like the live incident: finished work, `done`
 *  flipped in the worktree's OWN issue file, nothing committed, no Receipt. */
async function strandFinishedWorktree(sandbox: Sandbox, issueId: number): Promise<string> {
  const issue = sandboxIssue(issueId);
  const branch = branchFor(issue.slug);
  // The claim (open → wip) lands on the SHARED claim surface first, same as a
  // real parallel-mode Run — the worktree is cut from that already-claimed
  // tip. Its own copy stays `wip` in main for the whole Run: nothing ever
  // commits main's copy back, so a killed-with-no-Receipt Run leaves it a
  // `wip` issue main's planner can't attribute to any tracked active Run —
  // exactly the live incident's invisible-strand shape.
  await writeFile(join(sandbox.issuesDir, `${issue.slug}.md`), issueFileContent(issue, 'wip'));
  await git(sandbox.repo, 'add', '-A');
  await git(sandbox.repo, 'commit', '-m', `afk: claim issue ${issue.id} — ${issue.slug}`);
  await createWorktree(sandbox.repo, issue.slug, branch);
  const worktree = worktreePathFor(sandbox.repo, issue.slug);
  const trace = await runFakeWorker({
    repo: sandbox.repo,
    worktree,
    issue,
    exit: 'completed',
    misbehavior: 'die-mid-exit',
  });
  expect(trace.committed).toBe(false);
  expect(trace.receiptPath).toBeNull();
  return worktree;
}

describe('timeout salvage (issue 170) — a killed Run\'s worktree is recoverable, never silently stranded', () => {
  it('green: verify passes → Complete from worktree commits it, and its dependent becomes startable', async () => {
    const sandbox = await seed();
    // Issue 2 is the "timed out but finished" Run; issue 3 depends on it.
    const worktree = await strandFinishedWorktree(sandbox, 2);
    await writeVerifyFixture(worktree, true);

    const verify = await verifyWorktree(worktree);
    expect(verify.passed).toBe(true);

    // Before salvage: the drain planner (fed the pending timeout-salvage id,
    // exactly as main's onExit-derived clause would) names it distinctly and
    // issue 3 cannot yet start (its dependency isn't `done`).
    const before = await readBacklogAt(sandbox.issuesDir);
    // Isolate to just the pair under test — the full sandbox backlog has other
    // eligible issues, which would keep the drain live (never reaching the
    // "no eligible" stop this clause is appended to).
    const prePlan = planDrain({
      issues: before.issues.filter((i) => i.id === 2 || i.id === 3),
      maxConcurrent: 2,
      activeRuns: [],
      timeoutSalvageIssueIds: [2],
    });
    expect(prePlan.drain.message).toMatch(/1 timed out awaiting salvage \(issue 2\)/i);
    expect(prePlan.startable).not.toContain(3);

    const outcome = await commitFinishedWorktree(sandbox.repo, sandboxIssue(2).slug);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();
    expect(await readCommittedIssueStatus(sandbox.repo, sandboxIssue(2).slug)).toBe('done');

    // Salvage flips the MAIN checkout's issue file too (main's IPC handler
    // does this before committing, for a legacy Project) — model that here.
    await writeFile(
      join(sandbox.issuesDir, `${sandboxIssue(2).slug}.md`),
      (await readFile(join(sandbox.issuesDir, `${sandboxIssue(2).slug}.md`), 'utf8')).replace(
        /^status:\s*\S+/m,
        'status: done',
      ),
    );

    // After salvage: the chain continues — issue 3 is now startable, and the
    // drain no longer needs to name issue 2 as a stranded timeout.
    const after = await readBacklogAt(sandbox.issuesDir);
    const postPlan = planDrain({
      issues: after.issues.filter((i) => i.id === 2 || i.id === 3),
      maxConcurrent: 2,
      activeRuns: [],
    });
    expect(postPlan.startable).toContain(3);
    expect(postPlan.drain.message).not.toMatch(/timed out awaiting salvage/i);
  });

  it('broken: verify fails → Discard & requeue reopens the issue, no silent stall', async () => {
    const sandbox = await seed();
    const worktree = await strandFinishedWorktree(sandbox, 4);
    await writeVerifyFixture(worktree, false);

    const verify = await verifyWorktree(worktree);
    expect(verify.passed).toBe(false);
    expect(verify.output).toContain('test');

    await discardWorktree(sandbox.repo, sandboxIssue(4).slug);

    // The worktree + its afk/ branch are gone — nothing left to strand.
    const branches = await git(sandbox.repo, 'branch', '--list', branchFor(sandboxIssue(4).slug));
    expect(branches.trim()).toBe('');

    // The worktree's own `done` flip never reached main (nothing was
    // committed) — main's copy still reads the CLAIM's `wip`. Reopen it, same
    // as the real Discard-and-requeue action does: the killed Run produced no
    // committable work, so the drain must retry it, not skip it forever.
    expect(await readIssueStatusAt(sandbox.issuesDir, sandboxIssue(4).slug)).toBe('wip');
    await writeFile(
      join(sandbox.issuesDir, `${sandboxIssue(4).slug}.md`),
      issueFileContent(sandboxIssue(4), 'open'),
    );
    expect(await readIssueStatusAt(sandbox.issuesDir, sandboxIssue(4).slug)).toBe('open');

    const backlog = await readBacklogAt(sandbox.issuesDir);
    const plan = planDrain({ issues: backlog.issues, maxConcurrent: 2, activeRuns: [] });
    expect(plan.startable).toContain(4);
  });
});
