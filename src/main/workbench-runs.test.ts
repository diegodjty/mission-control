/**
 * Integration checks for issue 72's adapter seams — Runs on the Workbench —
 * against real git repos and the real Receipt watcher on a real filesystem
 * (the full assembled drain over a workbench fixture is issue 75's e2e):
 *
 *  1. The Receipt capture edge watches ONE workbench root: a Receipt written
 *     to `~/Workbench/<project>/completions/` ingests from a single watch on
 *     the project root — no per-worktree roots.
 *  2. A workbench SOLO Run's finished work commits in its CODE repo with the
 *     status read from the WORKBENCH (statusOverride) — and the stray-Receipt
 *     adoption is bypassed (`adoptStrays: false`).
 *  3. Same-repo concurrency for a workbench Project isolates as today: the
 *     scan overlay (`workbenchIssuesRoot`) reads the agent-finished signal
 *     from the workbench, `commitFinishedWorktree` commits with the override,
 *     and the branch then reads committed-done (mergeable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptWatcher } from './receipt-watcher';
import {
  applyIsolation,
  commitFinishedMain,
  commitFinishedWorktree,
  readIssueStatusAt,
  scanAfkBranches,
  worktreePathFor,
} from './git-worktree-adapter';
import { needsWorktreeCommit } from '../shared/worktree-scan';
import type { RunLogRecord } from '../shared/ipc-contract';

const exec = promisify(execFile);

let scratch: string;
let workbenchProject: string;
let repo: string;

const SLUG = '05-two-repo-work';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q');
  await git(path, 'config', 'user.email', 'mc@test.local');
  await git(path, 'config', 'user.name', 'MC Test');
  await writeFile(join(path, 'README.md'), 'seed\n');
  await git(path, 'add', '-A');
  await git(path, 'commit', '-q', '-m', 'seed');
}

async function writeWorkbenchIssue(status: 'open' | 'wip' | 'done'): Promise<void> {
  await writeFile(
    join(workbenchProject, 'issues', `${SLUG}.md`),
    `---\nstatus: ${status}\ndepends_on: []\n---\n\n# 05 — Two-repo work\n`,
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-wb-runs-'));
  workbenchProject = join(scratch, 'Workbench', 'proj');
  await mkdir(join(workbenchProject, 'issues'), { recursive: true });
  await writeWorkbenchIssue('wip');
  repo = join(scratch, 'code-repo');
  await initRepo(repo);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('Receipt capture from the workbench completions root (issue 72)', () => {
  it('ingests a Receipt from ONE watch on the project root — no worktree roots', async () => {
    const watcher = new ReceiptWatcher({ debounceMs: 20, stabilityMs: 20 });
    const records: RunLogRecord[] = [];
    try {
      // ONE root: the workbench project dir (completions/ lives beneath it).
      watcher.watch('w', [workbenchProject], new Map(), (r) => records.push(r));

      await mkdir(join(workbenchProject, 'completions'), { recursive: true });
      await writeFile(
        join(workbenchProject, 'completions', `${SLUG}.md`),
        `---\nissue: 5\nslug: two-repo-work\noutcome: completed\nfinished: 2026-07-04T00:00:00Z\n---\n## Completed issue 05 — two-repo-work\n\n**What changed** — a thing.\n`,
      );

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const tick = (): void => {
          if (records.length > 0) return resolve();
          if (Date.now() > deadline) return reject(new Error('Receipt never ingested'));
          setTimeout(tick, 25);
        };
        tick();
      });

      expect(records).toHaveLength(1);
      expect(records[0].issueId).toBe(5);
      expect(records[0].outcome).toBe('completed');
      expect(records[0].id).toBe(`receipt:${SLUG}:2026-07-04T00:00:00Z`);
    } finally {
      watcher.closeAll();
    }
  });
});

describe('workbench solo Run: commit in the code repo, status from the workbench', () => {
  it('commits finished work using the workbench status override; adoption bypassed', async () => {
    // The Worker did code work in the code repo (uncommitted) and flipped the
    // issue done IN THE WORKBENCH; the code repo has no issues/ at all.
    await writeFile(join(repo, 'feature.ts'), 'export const x = 1;\n');
    await writeWorkbenchIssue('done');

    // A stray Receipt-shaped file in the CODE repo is unknown state for a
    // workbench Project — the bypass must NOT adopt it.
    await mkdir(join(repo, 'issues', 'completions'), { recursive: true });
    await writeFile(join(repo, 'issues', 'completions', '99-stray.md'), 'stray\n');

    const status = await readIssueStatusAt(join(workbenchProject, 'issues'), SLUG);
    expect(status).toBe('done');

    const outcome = await commitFinishedMain(repo, SLUG, {
      statusOverride: status,
      adoptStrays: false,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.committed).toBe(true);
    expect(outcome.adopted ?? []).toEqual([]);

    const log = await git(repo, 'log', '--format=%s');
    expect(log).toContain('afk: complete issue 05 — two-repo-work');
    expect(log).not.toContain('adopt stray');

    // Without the override (legacy read), the same state commits nothing —
    // the code repo has no issues/<slug>.md, so status reads null.
    const withoutOverride = await commitFinishedMain(repo, SLUG);
    expect(withoutOverride.committed).toBe(false);
  });
});

describe('workbench same-repo concurrency: scan overlay + worktree commit', () => {
  it('reads agent-finished from the workbench, commits, then reads committed-done', async () => {
    // Two concurrent issues in ONE repo isolate exactly as today.
    const placements = await applyIsolation(repo, [
      { issueId: 5, slug: SLUG },
      { issueId: 6, slug: '06-sibling' },
    ]);
    expect(placements.parallel).toBe(true);

    // The agent worked in its worktree (uncommitted) and flipped the issue
    // done in the WORKBENCH — the worktree holds no issue file to flip.
    const wt = worktreePathFor(repo, SLUG);
    await writeFile(join(wt, 'feature.ts'), 'export const y = 2;\n');
    await writeWorkbenchIssue('done');

    const issuesRoot = join(workbenchProject, 'issues');
    let scan = await scanAfkBranches(repo, { workbenchIssuesRoot: issuesRoot });
    const before = scan.find((b) => b.slug === SLUG);
    expect(before?.worktreeStatus).toBe('done'); // agent finished (workbench says so)
    expect(before?.committedStatus).toBeNull(); // work not committed yet
    expect(before && needsWorktreeCommit(before)).toBe(true);

    // The sibling's issue is still wip in the workbench — no commit signal.
    const sibling = scan.find((b) => b.slug === '06-sibling');
    expect(sibling?.worktreeStatus).toBeNull();
    expect(sibling && needsWorktreeCommit(sibling)).toBe(false);

    const commit = await commitFinishedWorktree(repo, SLUG, {
      statusOverride: await readIssueStatusAt(issuesRoot, SLUG),
    });
    expect(commit.error).toBeNull();
    expect(commit.committed).toBe(true);

    // Committed now: the overlay reads committed-done (mergeable) — clean
    // worktree + workbench done.
    scan = await scanAfkBranches(repo, { workbenchIssuesRoot: issuesRoot });
    const after = scan.find((b) => b.slug === SLUG);
    expect(after?.committedStatus).toBe('done');
    expect(after && needsWorktreeCommit(after)).toBe(false);

    // Without the override, the legacy read finds no done flip in the
    // worktree, so nothing would ever commit — the override is load-bearing.
    const noOverride = await commitFinishedWorktree(repo, '06-sibling');
    expect(noOverride.committed).toBe(false);
  });
});
