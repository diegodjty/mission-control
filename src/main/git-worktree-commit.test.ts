/**
 * Integration check for auto-committing finished worktree Runs (issue 15). It
 * spans the REAL seam the batch-QA walkthrough found broken end-to-end: a
 * parallel Run finishes inside its worktree on an `afk/NN-slug` branch but the
 * spawned agent (single-issue mode) never commits, so the branch stays empty
 * and Merge has nothing to integrate. Here we simulate the finished-but-
 * uncommitted worktree, assert Mission Control auto-commits it onto the branch,
 * that "finished" is observed from the COMMITTED branch state, and that a
 * subsequent real Merge lands the created file + the `done` flip on `main`.
 *
 * Drives real git (and the real `afk-merge.sh`) against a throwaway temp repo —
 * never the real project, never the real backlog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktree,
  commitFinishedWorktree,
  readCommittedIssueStatus,
  readIsolatedIssueStatus,
} from './git-worktree-adapter';
import { mergeRuns, defaultMergeScriptPath } from './run-merge';
import { readBacklog } from './backlog-reader';
import { branchFor } from '../shared/isolation-policy';
import { deriveRunStatus, observedIssueStatus } from '../shared/run-state';
import { mergeReadiness, type MergeRun } from '../shared/merge-plan';

const exec = promisify(execFile);
const SCRIPT = defaultMergeScriptPath();

let scratch: string;
let repo: string;

const SLUG = '04-tracer-bullet';
const ISSUE_PATH = `issues/${SLUG}.md`;
const FEATURE_PATH = 'src/feature.ts';

function issueFile(status: 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# 04 — Tracer bullet\n\nbody\n`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function commitCount(slug: string): Promise<number> {
  const out = await git(repo, 'rev-list', '--count', branchFor(slug));
  return Number(out.trim());
}

/**
 * Simulate the spawned agent in its worktree: create a new file and flip the
 * issue to `done`, both left UNCOMMITTED (single-issue mode never commits).
 */
async function simulateAgent(wt: string, status: 'wip' | 'done'): Promise<void> {
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, FEATURE_PATH), 'export const feature = true;\n');
  await writeFile(join(wt, ISSUE_PATH), issueFile(status));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-commit-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  // The issue starts `wip` on main — what the main-checkout watcher sees.
  await writeFile(join(repo, ISSUE_PATH), issueFile('wip'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: issue 04 wip');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('commitFinishedWorktree — auto-commit on the done transition', () => {
  it('commits the created file + done flip onto the afk branch when finished', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    // Before the agent finishes, the branch only holds the initial commit and
    // its committed issue is still wip.
    expect(await commitCount(SLUG)).toBe(1);
    expect(await readCommittedIssueStatus(repo, SLUG)).toBe('wip');

    await simulateAgent(wt, 'done');
    // The work is present in the working tree but not yet on the branch.
    expect(await readCommittedIssueStatus(repo, SLUG)).toBe('wip');

    const outcome = await commitFinishedWorktree(repo, SLUG);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();

    // The branch now carries a new commit with both the file and the done flip.
    expect(await commitCount(SLUG)).toBe(2);
    const tracked = await git(wt, 'ls-files');
    expect(tracked).toContain(FEATURE_PATH);
    expect(await readCommittedIssueStatus(repo, SLUG)).toBe('done');
    const message = await git(repo, 'log', '-1', '--format=%s', branchFor(SLUG));
    expect(message.trim()).toBe('afk: complete issue 04 — tracer-bullet');
  });

  it('is idempotent — a Run already committed is not committed again', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    await simulateAgent(wt, 'done');
    expect((await commitFinishedWorktree(repo, SLUG)).committed).toBe(true);
    expect(await commitCount(SLUG)).toBe(2);

    // A second observation finds nothing to commit.
    expect((await commitFinishedWorktree(repo, SLUG)).committed).toBe(false);
    expect(await commitCount(SLUG)).toBe(2);
  });

  it('does NOT commit a still-wip (blocked/stopped) Run — nothing to merge', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    // The agent created a file but never reached done (blocked/stopped).
    await simulateAgent(wt, 'wip');
    expect((await commitFinishedWorktree(repo, SLUG)).committed).toBe(false);
    expect(await commitCount(SLUG)).toBe(1);
    expect(await readCommittedIssueStatus(repo, SLUG)).toBe('wip');
  });
});

describe('finished reflects the committed branch state (issue 15)', () => {
  it('observes finished only once the work is committed, then Merge integrates it', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    await simulateAgent(wt, 'done');

    // readIsolatedIssueStatus auto-commits, then reports from the committed
    // branch — so the observed status is the mergeable, committed one.
    const observation = await readIsolatedIssueStatus(repo, SLUG);
    const worktreeStatus = observation.status;
    expect(worktreeStatus).toBe('done');
    // A clean auto-commit surfaces no error (issue 22).
    expect(observation.commitError).toBeNull();
    // The commit really happened (detection and Merge now agree).
    expect(await commitCount(SLUG)).toBe(2);

    // The pure selector + deriveRunStatus turn that into a finished Run, even
    // while main still shows wip and the session lingers.
    const mainBacklog = await readBacklog(repo);
    expect(mainBacklog.issues.find((i) => i.id === 4)?.status).toBe('wip');
    const issueStatus = observedIssueStatus({
      isolated: true,
      mainStatus: 'wip',
      worktreeStatus,
    });
    const runStatus = deriveRunStatus({
      sessionAlive: true,
      stoppedByUser: false,
      issueStatus,
    });
    expect(runStatus).toBe('finished');

    // A finished isolated Run is mergeable.
    const runsInput: MergeRun[] = [
      { issueId: 4, slug: SLUG, status: runStatus, isolated: true },
    ];
    expect(mergeReadiness(runsInput).ready).toBe(true);

    // The real Merge lands the file AND the done flip on main.
    const result = await mergeRuns(repo, [SLUG], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual([SLUG]);

    await git(repo, 'checkout', 'main');
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain(FEATURE_PATH);
    const merged = await readBacklog(repo);
    expect(merged.issues.find((i) => i.id === 4)?.status).toBe('done');
  });
});
