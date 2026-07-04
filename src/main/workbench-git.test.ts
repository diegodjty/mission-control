/**
 * Integration check for the Workbench auto-commit edge (issue 72, ADR-0015):
 * real git against a throwaway temp "workbench" repo. Asserts the acceptance
 * criteria's git model — one commit per Run event, idempotent on
 * re-observation, `<project>: issue NN <event>` messages, scoped to the
 * project directory, and never a push (no remote is even configured; a push
 * attempt would throw, and the adapter has no push path at all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkbenchProject } from './workbench-git';
import { workbenchCommitMessage } from '../shared/workbench-run-events';

const exec = promisify(execFile);

let workbench: string;
let projectRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function commitCount(): Promise<number> {
  const out = await git(workbench, 'rev-list', '--count', 'HEAD');
  return Number(out.trim());
}

beforeEach(async () => {
  workbench = await mkdtemp(join(tmpdir(), 'mc-workbench-'));
  await git(workbench, 'init', '-q');
  await git(workbench, 'config', 'user.email', 'mc@test.local');
  await git(workbench, 'config', 'user.name', 'MC Test');
  projectRoot = join(workbench, 'billing');
  await mkdir(join(projectRoot, 'issues'), { recursive: true });
  await writeFile(join(projectRoot, 'issues', '05-x.md'), '---\nstatus: open\n---\n# 05\n');
  await git(workbench, 'add', '-A');
  await git(workbench, 'commit', '-q', '-m', 'seed');
});

afterEach(async () => {
  await rm(workbench, { recursive: true, force: true });
});

describe('commitWorkbenchProject (issue 72)', () => {
  it('commits a claim flip once, with the `<project>: issue NN <event>` message', async () => {
    await writeFile(join(projectRoot, 'issues', '05-x.md'), '---\nstatus: wip\n---\n# 05\n');

    const message = workbenchCommitMessage('billing', { issueId: 5, event: 'claim' });
    const first = await commitWorkbenchProject(projectRoot, message);
    expect(first).toEqual({ committed: true, error: null });
    expect(await commitCount()).toBe(2);
    const subject = (await git(workbench, 'log', '-1', '--format=%s')).trim();
    expect(subject).toBe('billing: issue 05 claim');

    // Idempotent on re-observation: the same event again commits NOTHING.
    const again = await commitWorkbenchProject(projectRoot, message);
    expect(again).toEqual({ committed: false, error: null });
    expect(await commitCount()).toBe(2);
  });

  it('sweeps the done flip AND the Receipt into one `done` commit', async () => {
    await writeFile(join(projectRoot, 'issues', '05-x.md'), '---\nstatus: done\n---\n# 05\n');
    await mkdir(join(projectRoot, 'completions'), { recursive: true });
    await writeFile(
      join(projectRoot, 'completions', '05-x.md'),
      '---\nissue: 5\noutcome: completed\n---\n## Completed issue 05\n',
    );

    const outcome = await commitWorkbenchProject(
      projectRoot,
      workbenchCommitMessage('billing', { issueId: 5, event: 'done' }),
    );
    expect(outcome.committed).toBe(true);
    const shown = await git(workbench, 'show', '--stat', '--format=%s', 'HEAD');
    expect(shown).toContain('billing: issue 05 done');
    expect(shown).toContain('billing/issues/05-x.md');
    expect(shown).toContain('billing/completions/05-x.md');
  });

  it('scopes the commit to the project dir — a sibling project’s dirt stays put', async () => {
    const other = join(workbench, 'other-project');
    await mkdir(join(other, 'issues'), { recursive: true });
    await writeFile(join(other, 'issues', '01-y.md'), '---\nstatus: wip\n---\n# 01\n');
    await writeFile(join(projectRoot, 'issues', '05-x.md'), '---\nstatus: wip\n---\n# 05\n');

    const outcome = await commitWorkbenchProject(
      projectRoot,
      workbenchCommitMessage('billing', { issueId: 5, event: 'claim' }),
    );
    expect(outcome.committed).toBe(true);
    const shown = await git(workbench, 'show', '--stat', '--format=%s', 'HEAD');
    expect(shown).toContain('billing/issues/05-x.md');
    expect(shown).not.toContain('other-project');
    // The sibling's file is still uncommitted, untouched.
    const status = await git(workbench, 'status', '--porcelain');
    expect(status).toContain('other-project/');
  });

  it('reports (never throws) when the project dir is not inside a git repo', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'mc-no-git-'));
    try {
      const outcome = await commitWorkbenchProject(loose, 'x: issue 01 claim');
      expect(outcome.committed).toBe(false);
      expect(outcome.error).not.toBeNull();
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });
});
