/**
 * E2E "Initialize git" (issue 158, ADR-0017) — the human's one-click fix for
 * a repo-less project's workspace root that was scaffolded but never
 * `git init`'d, the state issue 157's engine serializes (never collides) on.
 * Real modules over a real scratch filesystem: `isGitRepoDir`/`initGitRepo`
 * (the real-world non-git probe + the real git init/commit edge) and
 * `registerAppearedRepo` (the same self-heal registration path issue 95's
 * Inbox confirm uses) — the two pieces `main/index.ts`'s `git:init` IPC
 * handler orchestrates. No Electron, no LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepoDir } from '../src/main/git-worktree-adapter';
import { initGitRepo } from '../src/main/git-init';
import { registerAppearedRepo } from '../src/main/register-repo';
import { resolveProjectIdentity } from '../src/main/project-resolver';
import { git } from './sandbox';

interface Fixture {
  scratch: string;
  /** The scratch "home" — `resolveProjectIdentity` looks for `<home>/Workbench`. */
  home: string;
  workbenchRoot: string;
  projectRoot: string;
  /** The repo-less project's declared workspace root — a plain dir, no `.git`. */
  workspaceRoot: string;
}

let fx: Fixture;

/** A repo-less project (ADR-0017): CONFIG declares a workspace root, no `repos:` entries. */
async function seedRepolessWorkbench(scratch: string): Promise<Fixture> {
  // `home` only holds the Workbench (resolveProjectIdentity looks for
  // `<home>/Workbench`); the workspace root lives OUTSIDE it, as it does for
  // a real project, so its written CONFIG/registry paths stay absolute
  // rather than tilde-contracting against this fixture's fake home.
  const home = join(scratch, 'home');
  const workbenchRoot = join(home, 'Workbench');
  const projectRoot = join(workbenchRoot, 'demo');
  const workspaceRoot = join(scratch, 'code', 'demo');
  await mkdir(join(projectRoot, 'issues'), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true }); // scaffolded, never `git init`'d

  const configContent = [
    '---',
    `workspace_root: ${workspaceRoot}`,
    'repos:',
    '---',
    '',
    '# demo — project CONFIG',
    '',
  ].join('\n');
  await writeFile(join(projectRoot, 'CONFIG.md'), configContent);

  await git(workbenchRoot, 'init', '-b', 'main');
  await git(workbenchRoot, 'config', 'user.email', 'e2e@example.com');
  await git(workbenchRoot, 'config', 'user.name', 'MC Git Init E2E');
  await git(workbenchRoot, 'config', 'commit.gpgsign', 'false');
  await git(workbenchRoot, 'add', '.');
  await git(workbenchRoot, 'commit', '-m', 'initial: seeded repo-less demo');

  return { scratch, home, workbenchRoot, projectRoot, workspaceRoot };
}

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mc-git-init-e2e-'));
  fx = await seedRepolessWorkbench(scratch);
});

afterEach(async () => {
  await rm(fx.scratch, { recursive: true, force: true });
});

describe('e2e "Initialize git" — a non-git workspace root becomes isolatable', () => {
  it('is unisolatable before, and isolatable after, one Initialize-git pass', async () => {
    // Before: a genuinely repo-less, non-git project.
    const before = await resolveProjectIdentity(fx.projectRoot, { homeDir: fx.home });
    expect(before.repoPaths).toEqual([]);
    expect(before.defaultRepoPath).toBe(fx.workspaceRoot);
    expect(isGitRepoDir(fx.workspaceRoot)).toBe(false);

    // The IPC handler's two steps: git init + commit, then the same self-heal
    // registration path issue 95's Inbox confirm uses.
    const init = await initGitRepo(fx.workspaceRoot);
    expect(init).toEqual({ ok: true, error: null });
    expect(isGitRepoDir(fx.workspaceRoot)).toBe(true);
    const log = await git(fx.workspaceRoot, 'log', '--oneline');
    expect(log.trim().split('\n')).toHaveLength(1); // one initial commit

    const outcome = await registerAppearedRepo({
      workbenchRoot: fx.workbenchRoot,
      homeDir: fx.home,
      project: 'demo',
      repoPath: fx.workspaceRoot,
      key: 'demo',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.errors).toEqual([]);
    expect(outcome.key).toBe('demo');

    // CONFIG now declares the repo AND promotes it to default_repo (issue 95's
    // repo-less-promotion rule) — committed as one boring workbench commit.
    const config = await readFile(join(fx.projectRoot, 'CONFIG.md'), 'utf8');
    expect(config).toContain(`demo: ${fx.workspaceRoot}`);
    expect(config).toContain('default_repo: demo');
    const registry = await readFile(join(fx.workbenchRoot, 'registry.md'), 'utf8');
    expect(registry).toContain(`repo: ${fx.workspaceRoot}`);
    expect(registry).toContain('project: demo');
    const status = await git(fx.workbenchRoot, 'status', '--porcelain');
    expect(status.trim()).toBe(''); // the registration commit left a clean tree

    // After: the project resolves with a real member repo — isolatable.
    const after = await resolveProjectIdentity(fx.projectRoot, { homeDir: fx.home });
    expect(after.repoPaths).toEqual([fx.workspaceRoot]);
    expect(after.defaultRepoPath).toBe(fx.workspaceRoot);
  });

  it('refuses (never guesses) when the workspace root is already a git repo', async () => {
    await initGitRepo(fx.workspaceRoot);
    // A second Initialize-git attempt against an already-git root: the IPC
    // handler's own `isGitRepoDir` guard would refuse before ever calling
    // `initGitRepo` again; this proves the probe it guards on stays true.
    expect(isGitRepoDir(fx.workspaceRoot)).toBe(true);
  });
});
