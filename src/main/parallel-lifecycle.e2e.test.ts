/**
 * End-to-end parallel-lifecycle integration test (issue 32).
 *
 * The pure modules are well covered in isolation, but every shipped bug from the
 * hardening review lived at the INTEGRATION / COMPOSITION layer — where the real
 * Git/Worktree Adapter, the real Merge Adapter, the real `afk-merge.sh`, and the
 * pure derivations meet. This file drives that whole seam against a throwaway
 * scratch git repo (never the real project, never the real backlog), asserting
 * that Mission Control's REPORTED state matches ground truth at every hop:
 *
 *   1. `git init -b main` scratch repo with three `wip` issues + an initial commit.
 *   2. `applyIsolation(repo,[3,4,5])` → `.afk-parallel` written AND locally ignored
 *      (tree stays clean), three worktrees on `afk/*`.
 *   3. Finish 03 & 04 through `readIsolatedIssueStatus` (which drives the real
 *      auto-commit); leave 05 `wip`/uncommitted (a blocked Run still in flight).
 *   4. `deriveWorktreeRunStates` → 03/04 finished-unmerged, 05 running;
 *      `mergeReadinessOnDisk.ready === false` while 05 lingers; discard 05's
 *      worktree → `ready === true`, `mergeable === [03,04]` (findings 22/corr-1,5).
 *   5. `mergeRuns([03,04,99-ghost])` via the REAL `afk-merge.sh` → `merged` excludes
 *      the ghost, both files land on `main`, 03/04 worktrees+branches are gone, the
 *      reported count matches reality (findings 23/corr-2,9).
 *   6. Partial-conflict variant: 03/04 edit the same file → the first is committed
 *      on `main`, the report never claims both, `conflicted === true`/`midMerge`,
 *      and an in-app `abortMerge` restores a clean `main` (finding 24/corr-3).
 *   7. Solo-dirties-main variant: a finished solo Run is auto-committed by MC so
 *      `main` is clean and a later parallel Merge preflight passes (finding 25/corr-4).
 *
 * Plus the composition-layer unit gaps the reviews listed (banner/detail-button
 * suppression composed with worktree sets, duplicate-run refusal, project-switch
 * reset + id-scoping, non-`main` default branch, double-merge race guard, stale
 * worktree-status clear, auto-commit-failure surfaced) — encoded against the pure
 * modules that fixes 20–31 introduced, and (for commit-failure) against real git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyIsolation,
  createWorktree,
  discardWorktree,
  listWorktreeSlugs,
  scanAfkBranches,
  readIsolatedIssueStatus,
  commitFinishedMain,
  worktreePathFor,
  isMidMerge,
} from './git-worktree-adapter';
import { mergeRuns, abortMerge, defaultMergeScriptPath } from './run-merge';
import { branchFor } from '../shared/isolation-policy';
import {
  deriveWorktreeRunStates,
  mergeReadinessOnDisk,
  classifyBranch,
  dropMergedBranches,
  type AfkBranchFacts,
} from '../shared/worktree-scan';
import { summarizeRunGuidance } from '../shared/run-guidance';
import { runnableNow, eligibleForRun } from '../shared/run-eligibility';
import { isProjectSwitch, scanForProject, type ScopedScan } from '../shared/project-switch';
import { resolveDefaultBranch, DEFAULT_BRANCH_FALLBACK } from '../shared/default-branch';
import type { BacklogIssue } from '../shared/backlog-model';

const exec = promisify(execFile);
const SCRIPT = defaultMergeScriptPath();

let scratch: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** A wip/done issue file body, matching what the Backlog Model parses. */
function issueFile(id: number, title: string, status: 'wip' | 'done'): string {
  return `---\nstatus: ${status}\ndepends_on: []\n---\n\n# ${id} — ${title}\n\nbody\n`;
}

async function branchExists(slug: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', branchFor(slug));
    return true;
  } catch {
    return false;
  }
}

/**
 * Finish an isolated Run the way the app does: the agent edits a work file and
 * flips its issue to `done` in the worktree working tree, then Mission Control
 * OBSERVES it via `readIsolatedIssueStatus` — which drives the real auto-commit
 * onto the `afk/<slug>` branch. Returns the observation (status + commitError).
 */
async function finishInWorktree(
  slug: string,
  id: number,
  title: string,
  file: string,
  content: string,
) {
  const wt = worktreePathFor(repo, slug);
  await writeFile(join(wt, file), content);
  await writeFile(join(wt, 'issues', `${slug}.md`), issueFile(id, title, 'done'));
  return readIsolatedIssueStatus(repo, slug);
}

beforeEach(async () => {
  // `.noindex` parent: Spotlight/fseventsd churn on tmp-dir file storms is what
  // makes these real-git tests load-proportionally slow under a parallel suite
  // (issue 67); a .noindex ancestor excludes them from indexing.
  const noindex = join(tmpdir(), 'mc-tests.noindex');
  await mkdir(noindex, { recursive: true });
  scratch = await mkdtemp(join(noindex, 'mc-e2e-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# scratch repo\n');
  await writeFile(join(repo, 'issues', '03-a.md'), issueFile(3, 'A', 'wip'));
  await writeFile(join(repo, 'issues', '04-b.md'), issueFile(4, 'B', 'wip'));
  await writeFile(join(repo, 'issues', '05-c.md'), issueFile(5, 'C', 'wip'));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: three wip issues');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('parallel lifecycle — real git + real afk-merge.sh, report vs. truth', () => {
  it('the merge script exists where the skill installs it', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('isolate → finish-two-block-one → status/discard → merge-with-a-ghost (steps 1–5)', async () => {
    // --- Step 2: isolate three concurrent Runs ---------------------------------
    const iso = await applyIsolation(repo, [
      { issueId: 3, slug: '03-a' },
      { issueId: 4, slug: '04-b' },
      { issueId: 5, slug: '05-c' },
    ]);
    expect(iso.parallel).toBe(true);

    // The parallel marker is written AND locally ignored, so the tree stays clean
    // (an un-ignored marker would trip afk-merge.sh's clean-repo preflight).
    expect(existsSync(join(repo, 'issues', '.afk-parallel'))).toBe(true);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('issues/.afk-parallel');

    // Three worktrees on afk/*, matching ground truth from git's own registry.
    expect((await listWorktreeSlugs(repo)).sort()).toEqual(['03-a', '04-b', '05-c']);
    const wtList = await git(repo, 'worktree', 'list', '--porcelain');
    for (const slug of ['03-a', '04-b', '05-c']) {
      expect(wtList).toContain(branchFor(slug));
      expect(existsSync(worktreePathFor(repo, slug))).toBe(true);
    }

    // --- Step 3: finish 03 & 04 (drives the real commit); leave 05 blocked ------
    const obs3 = await finishInWorktree('03-a', 3, 'A', 'a.txt', 'from run 3\n');
    const obs4 = await finishInWorktree('04-b', 4, 'B', 'b.txt', 'from run 4\n');
    expect(obs3.status).toBe('done');
    expect(obs3.commitError).toBeNull();
    expect(obs4.status).toBe('done');
    expect(obs4.commitError).toBeNull();
    // 05 is left uncommitted and still wip in its worktree — a Run in flight.

    // --- Step 4: derived state matches on-disk truth ----------------------------
    const live = [5]; // only 05's session is still live
    const facts = await scanAfkBranches(repo);
    const states = deriveWorktreeRunStates(facts, live);
    expect(states).toEqual([
      { issueId: 3, slug: '03-a', kind: 'finished-unmerged' },
      { issueId: 4, slug: '04-b', kind: 'finished-unmerged' },
      { issueId: 5, slug: '05-c', kind: 'running' },
    ]);

    // Merge is NOT offered while 05 is still running, even though 03/04 are ready.
    const before = mergeReadinessOnDisk(facts, live);
    expect(before.ready).toBe(false);
    expect(before.pendingRunning).toEqual([5]);
    expect(before.mergeable.map((c) => c.slug)).toEqual(['03-a', '04-b']);

    // Discard the blocked Run's worktree+branch (the "throw it away" recovery).
    await discardWorktree(repo, '05-c');
    expect(existsSync(worktreePathFor(repo, '05-c'))).toBe(false);
    expect(await branchExists('05-c')).toBe(false);

    // Now Merge is ready and targets exactly 03/04 — report matches disk.
    const factsAfter = await scanAfkBranches(repo);
    const after = mergeReadinessOnDisk(factsAfter, []);
    expect(after.ready).toBe(true);
    expect(after.pendingRunning).toEqual([]);
    expect(after.mergeable.map((c) => c.slug)).toEqual(['03-a', '04-b']);

    // --- Step 5: merge with a ghost slug via the REAL afk-merge.sh --------------
    const result = await mergeRuns(repo, ['03-a', '04-b', '99-ghost'], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    // The ghost is excluded from merged; the count is honest.
    expect(result.merged.sort()).toEqual(['03-a', '04-b']);
    expect(result.merged).not.toContain('99-ghost');
    expect(result.message).toContain('Merged 2 branches into main');
    expect(result.message).toContain('99-ghost: no branch');

    // Ground truth on main: both files integrated, worktrees+branches gone, no ghost.
    await git(repo, 'checkout', 'main');
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain('a.txt');
    expect(tracked).toContain('b.txt');
    expect(await branchExists('03-a')).toBe(false);
    expect(await branchExists('04-b')).toBe(false);
    expect(await branchExists('99-ghost')).toBe(false);
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(false);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(false);
  });

  it('partial-conflict variant: main left mid-merge, in-app abort restores clean main (step 6)', async () => {
    // Two concurrent Runs that edit the SAME tracked file differently.
    await applyIsolation(repo, [
      { issueId: 3, slug: '03-a' },
      { issueId: 4, slug: '04-b' },
    ]);
    const o3 = await finishInWorktree('03-a', 3, 'A', 'README.md', '# scratch repo\nchange from run 3\n');
    const o4 = await finishInWorktree('04-b', 4, 'B', 'README.md', '# scratch repo\nDIFFERENT change from run 4\n');
    expect(o3.status).toBe('done');
    expect(o4.status).toBe('done');

    // The script merges 03-a cleanly + COMMITS it to main, then 04-b conflicts and
    // stops the run — main is left mid-merge with 03-a already integrated.
    const result = await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.midMerge).toBe(true);
    // The report never claims BOTH merged: only 03-a is on main.
    expect(result.merged).toEqual(['03-a']);
    expect(result.conflictingFiles).toContain('README.md');

    // Ground truth: main really is mid-merge; 03-a is an ancestor of HEAD, 04-b is not.
    expect(await isMidMerge(repo)).toBe(true);
    await expect(git(repo, 'merge-base', '--is-ancestor', branchFor('03-a'), 'HEAD')).resolves.toBeDefined();
    await expect(git(repo, 'merge-base', '--is-ancestor', branchFor('04-b'), 'HEAD')).rejects.toBeTruthy();

    // The in-app Abort returns main to a clean state (03-a's clean merge is kept).
    const aborted = await abortMerge(repo);
    expect(aborted.ok).toBe(true);
    expect(await isMidMerge(repo)).toBe(false);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    await expect(git(repo, 'merge-base', '--is-ancestor', branchFor('03-a'), 'HEAD')).resolves.toBeDefined();
    await expect(git(repo, 'merge-base', '--is-ancestor', branchFor('04-b'), 'HEAD')).rejects.toBeTruthy();
  });

  it('solo-dirties-main variant: MC commits the solo Run so a later parallel merge preflight passes (step 7)', async () => {
    // A solo Run works directly on main: its agent flips the issue to done and
    // leaves the created file + the flip UNCOMMITTED — main is dirty.
    await writeFile(join(repo, 'solo.txt'), 'solo run work\n');
    await writeFile(join(repo, 'issues', '03-a.md'), issueFile(3, 'A', 'done'));
    expect((await git(repo, 'status', '--porcelain')).trim()).not.toBe('');

    // MC commits the finished solo Run's work on main (issue 25).
    const outcome = await commitFinishedMain(repo, '03-a');
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBeNull();
    // main is clean again — the exact precondition a parallel merge preflight needs.
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    expect(await git(repo, 'ls-files')).toContain('solo.txt');

    // A later parallel Run finishes; because main is clean, the real merge preflight
    // passes and integrates it (it would have died on "uncommitted changes" before).
    const wt = await createWorktree(repo, '04-b', branchFor('04-b'));
    await writeFile(join(wt, 'b.txt'), 'from run 4\n');
    await writeFile(join(wt, 'issues', '04-b.md'), issueFile(4, 'B', 'done'));
    const obs = await readIsolatedIssueStatus(repo, '04-b');
    expect(obs.status).toBe('done');

    const merge = await mergeRuns(repo, ['04-b'], { scriptPath: SCRIPT });
    expect(merge.ok).toBe(true);
    expect(merge.conflicted).toBe(false);
    expect(merge.merged).toEqual(['04-b']);
    expect(merge.message).not.toMatch(/uncommitted changes/i);
  });

  // 60s timeout: passes in ~1s isolated, but this test's ~50 sequential git
  // spawns are extremely load-sensitive — per-spawn cost balloons under the
  // full suite's parallel real-git workers (5x with ONE concurrent file, >15x
  // suite-wide). The logic is proven by the isolated run; issue 67 owns the
  // real fix (worker cap / low-parallelism config for real-git suites).
  it('auto-commit-failure is surfaced (not swallowed) and reads as commit-failed (finding 22/corr-5)', { timeout: 60_000 }, async () => {
    // A finished isolated Run whose auto-commit FAILS. We force a real git commit
    // failure with a non-zero pre-commit hook (shared across worktrees via the
    // common git dir), so this exercises the real adapter, not a mock.
    const wt = await createWorktree(repo, '03-a', branchFor('03-a'));
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);

    // The agent finishes: work file + done flip in the worktree working tree.
    await writeFile(join(wt, 'a.txt'), 'from run 3\n');
    await writeFile(join(wt, 'issues', '03-a.md'), issueFile(3, 'A', 'done'));

    const obs = await readIsolatedIssueStatus(repo, '03-a');
    // The commit failure is REPORTED, not swallowed as a silent false...
    expect(obs.commitError).toBeTruthy();
    // ...and the branch tip never reached done (the work stays uncommitted).
    expect(obs.status).toBe('wip');

    // The scan classifies this branch as commit-failed: finished in the worktree,
    // but not committed — distinct from a Run still running.
    const facts = await scanAfkBranches(repo);
    const branch03 = facts.find((f) => f.slug === '03-a')!;
    expect(branch03.worktreeStatus).toBe('done');
    expect(branch03.committedStatus).toBe('wip');
    expect(classifyBranch(branch03, [3])).toBe('commit-failed');

    // A commit-failed branch is neither mergeable nor a "running" gate — it does
    // not block a Merge of finished siblings, but nothing gets merged from it.
    const plan = mergeReadinessOnDisk(facts, [3]);
    expect(plan.mergeable).toEqual([]);
    expect(plan.pendingRunning).toEqual([]);
    expect(plan.ready).toBe(false);
  });
});

/** A complete BacklogIssue for the pure composition-layer tests. */
function mkIssue(id: number, status: 'open' | 'wip' | 'done', dependsOn: number[] = []): BacklogIssue {
  return {
    id,
    slug: `${String(id).padStart(2, '0')}-x`,
    fileName: `${String(id).padStart(2, '0')}-x.md`,
    title: `Issue ${id}`,
    status,
    dependsOn,
    parent: null,
    source: null,
    hitl: false,
    repoKey: null,
    model: null,
    effort: null,
    inBatch: false,
    standalone: true,
    body: '',
  };
}

/** A finished-unmerged (done, not on main) branch fact. */
function finishedBranch(id: number): AfkBranchFacts {
  return {
    issueId: id,
    slug: `${String(id).padStart(2, '0')}-x`,
    hasWorktree: false,
    committedStatus: 'done',
    worktreeStatus: null,
    mergedIntoMain: false,
  };
}

describe('composition-layer gaps (pure) — the seams the hardening review flagged', () => {
  it('banner and detail-panel Run button suppress the SAME in-flight issues (finding 21)', () => {
    // 03 has a live isolated Run; 04 is finished-unmerged; 06 is genuinely runnable.
    // All three are dependency-eligible (open, no unmet deps) — the ONLY reason
    // 03/04 aren't runnable is the on-disk worktree set.
    const issues = [mkIssue(3, 'open'), mkIssue(4, 'open'), mkIssue(6, 'open')];
    const inFlight = { worktreeRunningIds: [3], finishedUnmergedIds: [4] };

    // The banner (summarizeRunGuidance) lists only 06 as runnable.
    const guidance = summarizeRunGuidance(issues, inFlight);
    expect(guidance.kind).toBe('eligible');
    if (guidance.kind === 'eligible') {
      expect(guidance.runnable.map((r) => r.id)).toEqual([6]);
    }

    // The detail-panel Run button (runnableNow) agrees issue-by-issue — 03/04 are
    // suppressed even though their dependency-eligibility is true.
    for (const id of [3, 4]) {
      const issue = issues.find((i) => i.id === id)!;
      expect(eligibleForRun(issue, issues)).toBe(true); // dep-eligible...
      expect(runnableNow(issue, issues, inFlight)).toBe(false); // ...but suppressed
    }
    expect(runnableNow(issues.find((i) => i.id === 6)!, issues, inFlight)).toBe(true);
  });

  it('refuses a duplicate Run on an issue that already has one in flight (finding 21)', () => {
    const issues = [mkIssue(3, 'open')];
    // Its dependencies are met, so a naive check would allow a second Run...
    expect(eligibleForRun(issues[0], issues)).toBe(true);
    // ...but every in-flight kind (running / finished-unmerged / stranded /
    // commit-failed) blocks a second Run, because it would clobber the existing
    // worktree/branch.
    for (const key of ['worktreeRunningIds', 'finishedUnmergedIds', 'strandedIds', 'commitFailedIds'] as const) {
      expect(runnableNow(issues[0], issues, { [key]: [3] })).toBe(false);
    }
  });

  it('a project switch resets state and never bleeds one project id-keyed scan onto another (finding 26)', () => {
    // Opening the first project, and moving between two projects, are switches;
    // re-selecting the same one is not (so live Runs are never wiped spuriously).
    expect(isProjectSwitch(null, '/repo/a')).toBe(true);
    expect(isProjectSwitch('/repo/a', '/repo/b')).toBe(true);
    expect(isProjectSwitch('/repo/a', '/repo/a')).toBe(false);

    // Project A's scan marks A's issue 05 finished-unmerged and offers a Merge.
    const scanA: ScopedScan = { projectPath: '/repo/a', branches: [finishedBranch(5)], midMerge: false };
    const viewA = scanForProject(scanA, '/repo/a');
    expect(mergeReadinessOnDisk(viewA.branches, []).ready).toBe(true);

    // The instant B is active, A's scan contributes NOTHING — B's own id 05 is not
    // marked finished, no bogus Merge is offered against a branch B doesn't have.
    const viewUnderB = scanForProject(scanA, '/repo/b');
    expect(viewUnderB.branches).toEqual([]);
    expect(mergeReadinessOnDisk(viewUnderB.branches, []).ready).toBe(false);
    // B's issue 05 stays plainly runnable — no cross-project suppression.
    const bIssues = [mkIssue(5, 'open')];
    expect(runnableNow(bIssues[0], bIssues, {})).toBe(true);
  });

  it('resolves a non-`main` default branch instead of hardcoding main (finding 27)', () => {
    // The pure resolver threads a detected master/trunk through the whole merge
    // path (the real master merge is exercised in run-merge.test.ts).
    expect(resolveDefaultBranch('master\n')).toBe('master');
    expect(resolveDefaultBranch('trunk')).toBe('trunk');
    // A detached HEAD / failed command falls back safely rather than an empty
    // branch name that would break every merge-base check.
    expect(resolveDefaultBranch(null)).toBe(DEFAULT_BRANCH_FALLBACK);
    expect(resolveDefaultBranch('   ')).toBe('main');
  });

  it('guards the double-merge race: dropping merged slugs recomputes readiness immediately (finding 29)', () => {
    // Before the next ~1.5s poll, the last scan still lists the just-merged
    // branches, and the Merge button re-enables — a second click would target
    // branches that no longer exist. Dropping the merged slugs synchronously with
    // the success makes readiness recompute to not-ready at once.
    const facts = [finishedBranch(3), finishedBranch(4)];
    expect(mergeReadinessOnDisk(facts, []).ready).toBe(true);

    const afterMerge = dropMergedBranches(facts, ['03-x', '04-x']);
    expect(afterMerge).toEqual([]);
    const replan = mergeReadinessOnDisk(afterMerge, []);
    expect(replan.ready).toBe(false);
    expect(replan.mergeable).toEqual([]);
  });

  it('clears stale worktree-derived status when the scan stops reporting a branch (finding 21)', () => {
    // A worktree status derived from the scan must not persist once its branch
    // leaves the scan — whether because the branch was merged/removed, or because
    // the scan now belongs to a different project. Both routes collapse to an
    // empty derived set rather than a lingering "finished/running" indicator.
    const facts = [finishedBranch(3)];
    expect(deriveWorktreeRunStates(facts, []).map((s) => s.slug)).toEqual(['03-x']);

    // Route 1 — the branch is gone from disk (post-merge/discard): no indicator.
    expect(deriveWorktreeRunStates(dropMergedBranches(facts, ['03-x']), [])).toEqual([]);

    // Route 2 — the scan belongs to the previous project after a switch: the
    // scoped view is empty, so nothing stale is derived for the new project.
    const scan: ScopedScan = { projectPath: '/repo/a', branches: facts, midMerge: false };
    const scoped = scanForProject(scan, '/repo/b');
    expect(deriveWorktreeRunStates(scoped.branches, [])).toEqual([]);
  });
});
