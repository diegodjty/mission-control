/**
 * Integration check for the Merge Adapter (issue 08). This exercises the REAL
 * `afk-merge.sh` against a throwaway scratch git repo with REAL parallel
 * `afk/NN-slug` branches — created through Mission Control's own worktree
 * adapter so the layout under test is exactly the one issue 07 produces
 * (`.afk-worktrees/<slug>`). It proves the three things the acceptance criteria
 * hinge on and that are verifiable headlessly: a clean merge integrates every
 * branch into `main` and cleans up its worktree; a conflict is surfaced and
 * nothing is silently resolved or cleaned up.
 *
 * Never touches the real project or the real backlog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { mergeRuns, ensureMergeConf, defaultMergeScriptPath, abortMerge } from './run-merge';
import {
  createWorktree,
  worktreePathFor,
  isMidMerge,
  reconcileMergedWorktrees,
} from './git-worktree-adapter';
import { branchFor } from '../shared/isolation-policy';

const exec = promisify(execFile);
const SCRIPT = defaultMergeScriptPath();

let scratch: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Real "finished parallel Run": a worktree on afk/<slug> with a committed change. */
async function finishedRun(slug: string, file: string, content: string): Promise<string> {
  const wt = await createWorktree(repo, slug, branchFor(slug));
  await writeFile(join(wt, file), content);
  await git(wt, 'add', '.');
  await git(wt, 'commit', '-m', `work for ${slug}`);
  return wt;
}

/**
 * A finished parallel Run whose issue file is committed `done` on its branch
 * (issue 15) — the shape the merged-worktree sweep (issue 50) keys on. The `done`
 * commit plus merged status is what marks a worktree/branch as reclaimable.
 */
async function finishedRunWithIssue(slug: string): Promise<string> {
  const wt = await createWorktree(repo, slug, branchFor(slug));
  await mkdir(join(wt, 'issues'), { recursive: true });
  await writeFile(
    join(wt, 'issues', `${slug}.md`),
    `---\nstatus: done\ndepends_on: []\n---\n# ${slug}\n`,
  );
  await writeFile(join(wt, `${slug}.txt`), `work for ${slug}\n`);
  await git(wt, 'add', '.');
  await git(wt, 'commit', '-m', `work for ${slug}`);
  return wt;
}

async function branchExists(slug: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', branchFor(slug));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mc-merge-'));
  repo = join(scratch, 'repo');
  await mkdir(join(repo, 'issues'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'MC Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# scratch repo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('mergeRuns — the real afk-merge.sh against real parallel branches', () => {
  it('the merge script exists where the skill installs it', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('integrates every finished branch into main and cleans up the worktrees', async () => {
    const wt3 = await finishedRun('03-a', 'a.txt', 'from run 3\n');
    const wt4 = await finishedRun('04-b', 'b.txt', 'from run 4\n');
    expect(existsSync(wt3)).toBe(true);
    expect(existsSync(wt4)).toBe(true);

    const result = await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });

    // Reported clean, both slugs merged.
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged.sort()).toEqual(['03-a', '04-b']);

    // Both branches' files are now on main.
    await git(repo, 'checkout', 'main');
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain('a.txt');
    expect(tracked).toContain('b.txt');

    // Worktrees are gone from disk and from git's registry...
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(false);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(false);
    const list = await git(repo, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain('afk/03-a');
    expect(list).not.toContain('afk/04-b');

    // ...and the merged branches are deleted.
    expect(await branchExists('03-a')).toBe(false);
    expect(await branchExists('04-b')).toBe(false);
  });

  it('reports the partial truth on a conflict: A merged, B conflicted, main mid-merge (issue 24)', async () => {
    // The script merges 03-a cleanly and COMMITS it to main, then 04-b — which
    // edits the same file differently — conflicts and stops the run, leaving main
    // mid-merge with 03-a already integrated.
    await finishedRun('03-a', 'README.md', '# scratch repo\nchange from run 3\n');
    await finishedRun('04-b', 'README.md', '# scratch repo\nDIFFERENT change from run 4\n');

    const result = await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(true);
    // Not the old, wrong "nothing merged": 03-a really is on main; 04-b conflicted.
    expect(result.merged).toEqual(['03-a']);
    expect(result.midMerge).toBe(true);
    expect(result.conflictingFiles).toContain('README.md');
    expect(result.message).toMatch(/03-a/);
    expect(result.message).toMatch(/mid-merge/i);
    // The conflicting file is named in the surfaced output.
    expect(result.output).toContain('README.md');

    // The reported state matches main's ACTUAL state: main is genuinely mid-merge,
    // and 03-a's commit is an ancestor of main (integrated) while 04-b is not.
    expect(await isMidMerge(repo)).toBe(true);
    await expect(
      git(repo, 'merge-base', '--is-ancestor', branchFor('03-a'), 'HEAD'),
    ).resolves.toBeDefined();
    await expect(
      git(repo, 'merge-base', '--is-ancestor', branchFor('04-b'), 'HEAD'),
    ).rejects.toBeTruthy();

    // Nothing was auto-resolved or cleaned up: the conflicting branch survives,
    // and at least one worktree is left in place for the human to sort out.
    expect(await branchExists('04-b')).toBe(true);
    expect(existsSync(worktreePathFor(repo, '04-b'))).toBe(true);
  });

  it('abortMerge returns main to a clean state, keeping the pre-conflict merge (issue 24)', async () => {
    await finishedRun('03-a', 'README.md', '# scratch repo\nchange from run 3\n');
    await finishedRun('04-b', 'README.md', '# scratch repo\nDIFFERENT change from run 4\n');
    await mergeRuns(repo, ['03-a', '04-b'], { scriptPath: SCRIPT });
    expect(await isMidMerge(repo)).toBe(true);

    const aborted = await abortMerge(repo);
    expect(aborted.ok).toBe(true);

    // main is clean again — no in-progress merge, no dirty working tree.
    expect(await isMidMerge(repo)).toBe(false);
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    // 03-a's clean merge is kept (it's still an ancestor of main); 04-b is not.
    await expect(
      git(repo, 'merge-base', '--is-ancestor', branchFor('03-a'), 'HEAD'),
    ).resolves.toBeDefined();
    await expect(
      git(repo, 'merge-base', '--is-ancestor', branchFor('04-b'), 'HEAD'),
    ).rejects.toBeTruthy();
  });

  it('abortMerge is a harmless no-op when main is not mid-merge (issue 24)', async () => {
    const res = await abortMerge(repo);
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
  });

  it('unblocks a repo that already has an un-ignored .afk-parallel marker (issue 18)', async () => {
    // A real project has committed issue files, so issues/ is tracked and the
    // marker shows as its own untracked entry (not a collapsed `?? issues/`).
    await writeFile(join(repo, 'issues', '00-placeholder.md'), '# placeholder\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'backlog');

    // Simulate a repo that hit the bug before this fix: the parallel-mode marker
    // was written but never git-ignored, so it dirties the tree.
    await writeFile(join(repo, 'issues', '.afk-parallel'), 'parallel\n');
    const before = (await git(repo, 'status', '--porcelain')).trim();
    expect(before).toContain('issues/.afk-parallel'); // dirty: would block merge

    // The merge preflight ignores the marker (and afk-merge.conf) — no manual git.
    await ensureMergeConf(repo);
    const after = (await git(repo, 'status', '--porcelain')).trim();
    expect(after).toBe(''); // tree clean again

    // Added to .git/info/exclude exactly once (idempotent).
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === 'issues/.afk-parallel').length).toBe(1);

    // A second call double-appends nothing.
    await ensureMergeConf(repo);
    const exclude2 = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude2.split('\n').filter((l) => l.trim() === 'issues/.afk-parallel').length).toBe(1);
  });

  it('merges cleanly even when the .afk-parallel marker is present in the repo', async () => {
    // The marker's presence must not block the real merge.
    await writeFile(join(repo, 'issues', '.afk-parallel'), 'parallel\n');
    await finishedRun('03-a', 'a.txt', 'from run 3\n');

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual(['03-a']);
  });

  it('excludes a non-existent slug from merged and reports the true count (issue 23)', async () => {
    // One real finished Run and one slug whose afk/ branch never existed. The
    // script exits 0 and SKIPS the missing branch — it must not be reported as
    // merged, and only the real branch's worktree/branch get cleaned up.
    await finishedRun('03-a', 'a.txt', 'from run 3\n');

    const result = await mergeRuns(repo, ['03-a', '99-ghost'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual(['03-a']); // 99-ghost excluded
    expect(result.message).toContain('Merged 1 branch into main');
    expect(result.message).toContain('99-ghost: no branch');

    // Only the real branch was integrated + cleaned up; the ghost slug leaves
    // no phantom branch behind.
    await git(repo, 'checkout', 'main');
    expect((await git(repo, 'ls-files'))).toContain('a.txt');
    expect(await branchExists('03-a')).toBe(false);
    expect(await branchExists('99-ghost')).toBe(false);
  });

  it('reports 0 merged (not a fresh merge) when a branch is already in main (issue 23)', async () => {
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    // First merge integrates it.
    await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT, cleanup: false });
    // A second stale-scan Merge of the same slug: already on main, nothing new.
    const again = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT, cleanup: false });

    expect(again.ok).toBe(true);
    expect(again.merged).toEqual([]);
    expect(again.message).toContain('Merged 0 branches into main');
    expect(again.message).toContain('03-a: already in main');
  });

  it('names a dirty-tree preflight refusal as its real cause, not a conflict (issue 23)', async () => {
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    // Dirty the main checkout with a TRACKED, uncommitted change so afk-merge.sh's
    // clean-repo preflight refuses before merging anything.
    await writeFile(join(repo, 'README.md'), '# scratch repo\nuncommitted edit\n');

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false); // NOT a conflict
    expect(result.merged).toEqual([]);
    expect(result.message).toMatch(/uncommitted changes/i);
    expect(result.message).not.toMatch(/conflict/i);
    // The message names the branch AND the offending path(s) (issue 59), so the
    // user can act on it instead of guessing what is dirty.
    expect(result.message).toContain('uncommitted changes on main: README.md');
    // The branch and worktree are untouched — nothing was merged or cleaned up.
    expect(await branchExists('03-a')).toBe(true);
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(true);
  });

  it('integrates a finished branch on a non-`main` (master) repo, naming the real branch (issue 27)', async () => {
    // A self-contained scratch repo initialised on `master`, not `main` — the
    // exact shape where the old hardcoded `main` made the whole merge path
    // unusable. Exercises the REAL afk-merge.sh end to end.
    const s2 = await mkdtemp(join(tmpdir(), 'mc-merge-master-'));
    const r2 = join(s2, 'repo');
    try {
      await mkdir(join(r2, 'issues'), { recursive: true });
      await git(r2, 'init', '-b', 'master');
      await git(r2, 'config', 'user.email', 'test@example.com');
      await git(r2, 'config', 'user.name', 'MC Test');
      await git(r2, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(r2, 'README.md'), '# scratch repo\n');
      await git(r2, 'add', '.');
      await git(r2, 'commit', '-m', 'initial on master');

      // A finished parallel Run on afk/03-a in this master repo.
      const wt = await createWorktree(r2, '03-a', branchFor('03-a'));
      await writeFile(join(wt, 'a.txt'), 'from run 3\n');
      await git(wt, 'add', '.');
      await git(wt, 'commit', '-m', 'work for 03-a');

      const result = await mergeRuns(r2, ['03-a'], { scriptPath: SCRIPT });

      expect(result.ok).toBe(true);
      expect(result.conflicted).toBe(false);
      expect(result.merged).toEqual(['03-a']);
      // The message names the DETECTED branch (master), not a hardcoded main.
      expect(result.message).toContain('into master');
      expect(result.message).not.toContain('into main');

      // The work really is on master; the merged branch was cleaned up.
      await git(r2, 'checkout', 'master');
      expect(await git(r2, 'ls-files')).toContain('a.txt');
      await expect(
        git(r2, 'rev-parse', '--verify', '--quiet', branchFor('03-a')),
      ).rejects.toBeTruthy(); // branch deleted on clean merge
      expect(existsSync(worktreePathFor(r2, '03-a'))).toBe(false);
    } finally {
      await rm(s2, { recursive: true, force: true });
    }
  });

  it('is a no-op with an empty slug list', async () => {
    const result = await mergeRuns(repo, [], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual([]);
  });

  it('reports a clear failure when the merge tool is missing', async () => {
    const result = await mergeRuns(repo, ['03-a'], {
      scriptPath: join(scratch, 'does-not-exist.sh'),
    });
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });
});

describe('reconcileMergedWorktrees — sweeps leftover merged residue, spares unmerged (issue 50)', () => {
  it('removes a merged worktree + branch (residue) and leaves a finished-unmerged one', async () => {
    // A finished Run whose work reached `main` by a DIFFERENT route than the
    // per-Run merge cleanup (here: a direct merge) — the exact leftover-residue
    // case (`02-run-me` / `05-manual-check`) the dogfood drain produced.
    const mergedWt = await finishedRunWithIssue('02-run-me');
    await git(repo, 'merge', '--no-ff', '-m', 'merge 02', branchFor('02-run-me'));
    // A finished-but-unmerged Run: committed `done`, never merged — still mergeable.
    const unmergedWt = await finishedRunWithIssue('05-manual-check');
    expect(existsSync(mergedWt)).toBe(true);
    expect(existsSync(unmergedWt)).toBe(true);

    const result = await reconcileMergedWorktrees(repo);

    expect(result.reclaimed).toEqual(['02-run-me']);
    expect(result.leftBehind).toEqual([]);
    // The merged residue is gone from disk AND from git's branch list.
    expect(existsSync(worktreePathFor(repo, '02-run-me'))).toBe(false);
    expect(await branchExists('02-run-me')).toBe(false);
    // The not-yet-merged Run survives untouched.
    expect(existsSync(worktreePathFor(repo, '05-manual-check'))).toBe(true);
    expect(await branchExists('05-manual-check')).toBe(true);
  });

  it('does NOT reclaim a fresh worktree whose empty branch is trivially an ancestor of main', async () => {
    // A worktree created but with no committed `done` yet — its branch tip is
    // `main` (an ancestor of itself), so a naive "is-ancestor" check would flag it
    // merged. The `committedStatus === 'done'` guard must keep it in place.
    const freshWt = await createWorktree(repo, '07-fresh', branchFor('07-fresh'));
    expect(existsSync(freshWt)).toBe(true);

    const result = await reconcileMergedWorktrees(repo);

    expect(result.reclaimed).toEqual([]);
    expect(existsSync(worktreePathFor(repo, '07-fresh'))).toBe(true);
    expect(await branchExists('07-fresh')).toBe(true);
  });

  it('a full mergeRuns leaves no merged residue behind, even a worktree it did not merge itself', async () => {
    // Pre-existing residue merged before this merge even runs.
    await finishedRunWithIssue('02-run-me');
    await git(repo, 'merge', '--no-ff', '-m', 'merge 02', branchFor('02-run-me'));
    // The Run THIS merge integrates.
    await finishedRunWithIssue('03-a');
    // A finished-unmerged Run that must survive the whole operation.
    await finishedRunWithIssue('05-manual-check');

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual(['03-a']);

    // Both the just-merged Run and the pre-existing residue are cleaned up —
    // a fully-merged drain leaves no `.afk-worktrees` residue.
    expect(existsSync(worktreePathFor(repo, '03-a'))).toBe(false);
    expect(await branchExists('03-a')).toBe(false);
    expect(existsSync(worktreePathFor(repo, '02-run-me'))).toBe(false);
    expect(await branchExists('02-run-me')).toBe(false);
    // The unmerged Run survives.
    expect(existsSync(worktreePathFor(repo, '05-manual-check'))).toBe(true);
    expect(await branchExists('05-manual-check')).toBe(true);
  });
});

describe('adopt stray Receipts before the merge preflight (issue 62, ADR-0013)', () => {
  const STRAY = 'issues/completions/05-manual-check.md';

  /** A Worker misplacing its Receipt: written UNTRACKED into the MAIN checkout. */
  async function writeStrayReceipt(path = STRAY, body = 'parked for HITL\n'): Promise<void> {
    await mkdir(join(repo, 'issues/completions'), { recursive: true });
    await writeFile(
      join(repo, path),
      `---\nissue: 5\nslug: 05-manual-check\noutcome: needs-verification\n---\n${body}`,
    );
  }

  async function adoptCommits(): Promise<string[]> {
    const log = await git(repo, 'log', '--format=%s', 'main');
    return log.split('\n').filter((s) => s.startsWith('chore: adopt stray Receipt(s)'));
  }

  it('a stray UNTRACKED Receipt on main is adopted (one chore commit) and the merge proceeds cleanly', async () => {
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    await writeStrayReceipt();

    // The exact wall the second walkthrough hit: without adoption this merge is
    // refused by the clean-tree preflight and every Run piles up unmerged.
    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(true);
    expect(result.merged).toEqual(['03-a']);
    expect(result.adopted).toEqual([STRAY]);

    // Exactly ONE dedicated adoption commit, naming the file.
    const adopts = await adoptCommits();
    expect(adopts).toEqual([`chore: adopt stray Receipt(s) — ${STRAY}`]);

    // The Receipt is tracked, the branch's work landed, and main is clean.
    const tracked = await git(repo, 'ls-files');
    expect(tracked).toContain(STRAY);
    expect(tracked).toContain('a.txt');
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
  });

  it('a stray MODIFIED Receipt is adopted the same way', async () => {
    // The Receipt is already tracked (e.g. an earlier adoption), then a Worker
    // re-writes it in place — a MODIFIED, not untracked, stray.
    await writeStrayReceipt(STRAY, 'first version\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'receipt v1');
    await writeStrayReceipt(STRAY, 'second version — re-run overwrote it\n');

    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(true);
    expect(result.adopted).toEqual([STRAY]);
    expect(await adoptCommits()).toEqual([`chore: adopt stray Receipt(s) — ${STRAY}`]);
    const committed = await git(repo, 'show', `main:${STRAY}`);
    expect(committed).toContain('second version');
    expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
  });

  it('a dirty NON-Receipt path still halts with the truthful issue-59 message and is NOT auto-committed', async () => {
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs/PRD.md'), '# unknown dirt\n');

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    // Unknown state halts — a preflight refusal, not a conflict, nothing merged.
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.message).toContain('uncommitted changes on main');
    expect(result.message).toContain('docs/PRD.md');

    // The unknown file was never committed, and no adoption commit exists.
    expect(await git(repo, 'ls-files')).not.toContain('docs/PRD.md');
    expect(await adoptCommits()).toEqual([]);
  });

  it('mixed dirt: the Receipt is adopted, the merge still halts naming ONLY the unknown path', async () => {
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    await writeStrayReceipt();
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs/PRD.md'), '# unknown dirt\n');

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    // The KNOWN artifact was repaired…
    expect(result.adopted).toEqual([STRAY]);
    expect(await adoptCommits()).toEqual([`chore: adopt stray Receipt(s) — ${STRAY}`]);
    expect(await git(repo, 'ls-files')).toContain(STRAY);

    // …but the unknown dirt still halts, truthfully named — and not committed.
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.message).toContain('docs/PRD.md');
    expect(result.message).not.toContain(STRAY);
    expect(await git(repo, 'ls-files')).not.toContain('docs/PRD.md');
  });
});

describe('ignored-artifact merge preflight (issue 98) — refuses a branch carrying node_modules', () => {
  /**
   * A finished Run whose branch CARRIES the old self-referential `node_modules`
   * symlink — the exact object that corrupted `main` during the 94/95/96 drain
   * (mode 120000, target the main repo's real install). Committed with raw git
   * (not Mission Control's guarded commit path) so it reproduces a branch created
   * BEFORE this fix.
   */
  async function runCarryingNodeModules(slug: string, file = 'work.txt'): Promise<string> {
    const wt = await createWorktree(repo, slug, branchFor(slug));
    await writeFile(join(wt, file), `work for ${slug}\n`);
    // createWorktree now provisions the worktree with a REAL node_modules when the
    // main checkout has one (issue 136); this helper deliberately reconstructs the
    // OLD broken shape instead — a self-referential symlink committed by raw git,
    // as a branch created BEFORE these fixes carried — so clear any provisioned
    // copy first, then plant the symlink the issue-98 guard must still refuse.
    await rm(join(wt, 'node_modules'), { recursive: true, force: true });
    await symlink(join(repo, 'node_modules'), join(wt, 'node_modules'));
    await git(wt, 'add', '-A');
    await git(wt, 'commit', '-m', `work for ${slug} (+ stray node_modules symlink)`);
    return wt;
  }

  it('refuses a single branch that would introduce a tracked node_modules path, truthfully', async () => {
    const wt = await runCarryingNodeModules('94-x');

    const result = await mergeRuns(repo, ['94-x'], { scriptPath: SCRIPT });

    // A preflight refusal — NOT a conflict, nothing merged.
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual([]);
    // The message names the branch, the offending path, and the real cause.
    expect(result.message).toMatch(/Merge preflight failed/);
    expect(result.message).toContain('afk/94-x');
    expect(result.message).toContain('node_modules');
    expect(result.message).toContain('issue 98');
    expect(result.message).not.toMatch(/conflict/i);

    // The branch/worktree are untouched, and node_modules never reached main.
    expect(await branchExists('94-x')).toBe(true);
    expect(existsSync(wt)).toBe(true);
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain('node_modules');
  });

  it('a clean branch still merges when a sibling branch carries the artifact — both named, nothing merged', async () => {
    // 03-a is clean; 96-y carries the symlink. The whole merge is refused (the
    // preflight is all-or-nothing so no partial corruption slips through), and
    // the message names only the offending branch.
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    await runCarryingNodeModules('96-y');

    const result = await mergeRuns(repo, ['03-a', '96-y'], { scriptPath: SCRIPT });

    expect(result.ok).toBe(false);
    expect(result.merged).toEqual([]);
    expect(result.message).toContain('afk/96-y');
    expect(result.message).not.toContain('afk/03-a');
    // Nothing was integrated — the clean branch is untouched too.
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain('a.txt');
    expect(await branchExists('03-a')).toBe(true);
  });

  it('a full mergeRuns over branches carrying the old symlink does NOT corrupt the real install (regression)', async () => {
    // Set up the target repo's REAL node_modules install with a marker whose
    // readability is the proof the install survived — the exact thing the
    // 94/95/96 merge destroyed with a `too many levels of symbolic links` loop.
    await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'installed.marker'), 'real install\n');

    // Two branches each carrying the self-referential symlink (the 94/95/96 shape).
    await runCarryingNodeModules('94-x');
    await runCarryingNodeModules('96-y', 'other.txt');

    const result = await mergeRuns(repo, ['94-x', '96-y'], { scriptPath: SCRIPT });

    // The merge is refused before afk-merge.sh ever runs, so main stays clean.
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(await isMidMerge(repo)).toBe(false);

    // The real install is intact: node_modules is still a real directory (not a
    // clobbered self-referential symlink) and its marker is still readable.
    const nm = await lstat(join(repo, 'node_modules'));
    expect(nm.isDirectory()).toBe(true);
    expect(nm.isSymbolicLink()).toBe(false);
    const marker = await readFile(join(repo, 'node_modules', 'installed.marker'), 'utf8');
    expect(marker).toBe('real install\n');

    // main never tracked node_modules, and both branches survive for the human.
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain('node_modules');
    expect(await branchExists('94-x')).toBe(true);
    expect(await branchExists('96-y')).toBe(true);
  });
});

describe('merge targets the checked-out branch, never a forced main (issue 113 — Part A)', () => {
  it('integrates a finished branch into a FEATURE-branch checkout and passes preflight', async () => {
    // The repo's main checkout sits on a feature branch while `main` still
    // exists locally — the exact shape where pre-113 afk-merge.sh PREFERRED
    // `main` and refused with a "wrong branch" preflight. MC now passes the
    // detected current branch via `--into`, so it integrates into the feature
    // branch and never forces `main`.
    await git(repo, 'checkout', '-b', 'feature/login');
    const wt = await finishedRun('03-a', 'a.txt', 'from run 3\n');
    expect(existsSync(wt)).toBe(true);

    const result = await mergeRuns(repo, ['03-a'], { scriptPath: SCRIPT });

    // No "wrong branch" refusal: the merge succeeds on the feature branch.
    expect(result.ok).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.merged).toEqual(['03-a']);
    // The message names the DETECTED feature branch, not a hardcoded main.
    expect(result.message).toContain('into feature/login');
    expect(result.message).not.toContain('into main');

    // The work landed on the feature branch; `main` is untouched.
    await git(repo, 'checkout', 'feature/login');
    expect(await git(repo, 'ls-files')).toContain('a.txt');
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain('a.txt');
  });
});

describe('protected-branch guard on the merge path (issue 113 — Part B)', () => {
  it('WITHHOLDS a merge onto a protected branch (main) until confirmed, landing nothing', async () => {
    const wt = await finishedRun('03-a', 'a.txt', 'from run 3\n');

    // The repo is on `main` (protected). Guard enabled, NOT confirmed → withheld.
    const withheld = await mergeRuns(repo, ['03-a'], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: false },
    });
    expect(withheld.ok).toBe(false);
    expect(withheld.conflicted).toBe(false);
    expect(withheld.merged).toEqual([]);
    expect(withheld.protectedBranch).toBe('main');
    expect(withheld.message).toMatch(/protected branch 'main'/);

    // NOTHING landed: the branch + worktree survive and `main` has no new work.
    expect(await branchExists('03-a')).toBe(true);
    expect(existsSync(wt)).toBe(true);
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).not.toContain('a.txt');

    // Confirmed → the very same merge proceeds and lands on main.
    const confirmed = await mergeRuns(repo, ['03-a'], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: true },
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.merged).toEqual(['03-a']);
    expect(confirmed.protectedBranch ?? null).toBeNull();
    await git(repo, 'checkout', 'main');
    expect(await git(repo, 'ls-files')).toContain('a.txt');
  });

  it('does NOT withhold a merge onto a non-protected feature branch (auto-proceeds unchanged)', async () => {
    await git(repo, 'checkout', '-b', 'feature/checkout');
    await finishedRun('03-a', 'a.txt', 'from run 3\n');

    // Guard enabled + unconfirmed, but the target is a feature branch → proceeds.
    const result = await mergeRuns(repo, ['03-a'], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: false },
    });
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual(['03-a']);
    expect(result.protectedBranch ?? null).toBeNull();
  });

  it('leaves the protected branch clean — no stray-Receipt adoption commit lands during a withhold', async () => {
    // A stray Receipt on main would normally be ADOPTED (committed) before the
    // preflight. The protected-branch withhold happens FIRST, so not even the
    // adoption commit touches main while the human hasn't confirmed.
    await finishedRun('03-a', 'a.txt', 'from run 3\n');
    await mkdir(join(repo, 'issues', 'completions'), { recursive: true });
    await writeFile(
      join(repo, 'issues', 'completions', '05-stray.md'),
      '---\nissue: 5\noutcome: needs-verification\n---\nstray\n',
    );
    const commitsBefore = (await git(repo, 'rev-list', '--count', 'main')).trim();

    const withheld = await mergeRuns(repo, ['03-a'], {
      scriptPath: SCRIPT,
      protectedBranchGuard: { confirmed: false },
    });
    expect(withheld.protectedBranch).toBe('main');
    expect(withheld.adopted).toEqual([]);
    // No adoption commit landed on main while withheld.
    expect((await git(repo, 'rev-list', '--count', 'main')).trim()).toBe(commitsBefore);
    expect(await git(repo, 'log', '--format=%s', 'main')).not.toContain('adopt stray Receipt');
  });
});
