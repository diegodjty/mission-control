/**
 * Integration check for isolated-Run completion detection (issue 13). It spans
 * the REAL seam the batch-QA walkthrough found broken: a scratch git repo, a
 * worktree on an `afk/NN-slug` branch, a `done` flip that lands ONLY on that
 * branch/worktree, and the assertion that Mission Control observes the Run
 * finished (and therefore mergeable) even though the main checkout still shows
 * the issue as `wip`.
 *
 * Drives real git against a throwaway temp repo — never the real project, never
 * the real backlog. This is the assembled-seam test the per-issue unit tests
 * (06/07/08) can't cover: the defect only appears once worktrees + main-backlog
 * observation + merge readiness are wired together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, readIsolatedIssueStatus } from './git-worktree-adapter';
import { readBacklog } from './backlog-reader';
import { branchFor } from '../shared/isolation-policy';
import { deriveRunStatus, observedIssueStatus } from '../shared/run-state';
import { mergeReadiness, type MergeRun } from '../shared/merge-plan';

const exec = promisify(execFile);

let scratch: string;
let repo: string;

const SLUG = '04-tracer-bullet';
const ISSUE_PATH = `issues/${SLUG}.md`;

function issueFile(status: 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# 04 — Tracer bullet\n\nbody\n`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-completion-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  // The issue starts `wip` on main — this is what the main-checkout watcher sees.
  await writeFile(join(repo, ISSUE_PATH), issueFile('wip'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: issue 04 wip');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('readIsolatedIssueStatus — completion observed from the worktree/branch', () => {
  it('reads the uncommitted working-tree flip in the worktree (main still wip)', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));

    // The agent does its work and flips the issue to `done` in the worktree —
    // just saved, not necessarily committed. The main checkout is untouched.
    await writeFile(join(wt, ISSUE_PATH), issueFile('done'));

    // Main-checkout backlog still shows wip — the exact blind spot of issue 13.
    const mainBacklog = await readBacklog(repo);
    expect(mainBacklog.issues.find((i) => i.id === 4)?.status).toBe('wip');

    // But observing the worktree/branch sees the flip.
    expect(await readIsolatedIssueStatus(repo, SLUG)).toBe('done');
  });

  it('falls back to the committed branch copy when the worktree dir is gone', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    await writeFile(join(wt, ISSUE_PATH), issueFile('done'));
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', 'flip issue 04 to done');
    // Remove the worktree dir (keeps the afk/ branch) — the branch still holds done.
    await git(repo, 'worktree', 'remove', wt);

    expect(await readIsolatedIssueStatus(repo, SLUG)).toBe('done');
  });

  it('returns null when nothing about the slug is observable', async () => {
    expect(await readIsolatedIssueStatus(repo, 'no-such-99-slug')).toBeNull();
  });

  it('the observed done makes the Run finished and thus mergeable (full seam)', async () => {
    const wt = await createWorktree(repo, SLUG, branchFor(SLUG));
    await writeFile(join(wt, ISSUE_PATH), issueFile('done'));

    // 1. Observe from the worktree, choosing the isolated source (pure selector).
    const worktreeStatus = await readIsolatedIssueStatus(repo, SLUG);
    const issueStatus = observedIssueStatus({
      isolated: true,
      mainStatus: 'wip', // main-checkout watcher never saw the flip
      worktreeStatus,
    });

    // 2. The Run is derived finished even while its session lingers.
    const runStatus = deriveRunStatus({
      sessionAlive: true,
      stoppedByUser: false,
      issueStatus,
    });
    expect(runStatus).toBe('finished');

    // 3. A finished isolated Run makes the Merge affordance appear.
    const runs: MergeRun[] = [
      { issueId: 4, slug: SLUG, status: runStatus, isolated: true },
    ];
    const plan = mergeReadiness(runs);
    expect(plan.ready).toBe(true);
    expect(plan.mergeable.map((c) => c.slug)).toContain(SLUG);
  });
});
