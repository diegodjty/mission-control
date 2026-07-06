/**
 * E2E — Remove project against a temp workbench (issue 92).
 *
 * The Launcher's Remove project, exercised at module level exactly as the
 * `ProjectRemove` handler in `src/main/index.ts` composes it: read the REAL
 * temp workbench's `registry.md`, drop the project's entries through the pure
 * `removeRegistryProject`, write the rewrite back, and land ONE boring
 * workbench commit scoped to `registry.md` through the REAL commit path
 * (`workbench-git`).
 *
 * Covered, per the issue's non-destructive removal semantics:
 *   - Every entry of the (multi-repo) project goes; another project's entry
 *     and the registry prose survive.
 *   - Removal is what stops discovery: `resolveProject` by cwd no longer
 *     resolves the removed project's repos.
 *   - The workbench project directory (issues, CONFIG, memory) is untouched —
 *     only the registry changes, in exactly one commit, tree left clean.
 *   - An unknown project is a no-op refusal: nothing written, nothing
 *     committed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseRegistry,
  removeRegistryProject,
  resolveProject,
} from '../src/shared/workbench-model';
import { commitWorkbenchPaths } from '../src/main/workbench-git';
import { git, seedWorkbenchSandbox, type WorkbenchSandbox } from './sandbox';

let sandbox: WorkbenchSandbox;
/** A surviving second project's entry, appended to the seeded registry. */
let otherRepo: string;

beforeEach(async () => {
  sandbox = await seedWorkbenchSandbox();
  otherRepo = join(sandbox.scratch, 'repo-other');
  const registryPath = join(sandbox.workbenchRoot, 'registry.md');
  await writeFile(
    registryPath,
    `${sandbox.registryContent}- repo: ${otherRepo}\n  project: other\n  status: active\n`,
    'utf8',
  );
  await git(sandbox.workbenchRoot, 'add', 'registry.md');
  await git(sandbox.workbenchRoot, 'commit', '-m', 'seed: second project entry');
});

afterEach(async () => {
  await rm(sandbox.scratch, { recursive: true, force: true });
});

async function commitCount(): Promise<number> {
  const out = await git(sandbox.workbenchRoot, 'rev-list', '--count', 'HEAD');
  return Number(out.trim());
}

describe('remove project against a temp workbench', () => {
  it('drops every entry of the project, commits once, and leaves the tree clean', async () => {
    const registryPath = join(sandbox.workbenchRoot, 'registry.md');
    const before = await commitCount();

    // The handler's composition: read → pure rewrite → write → one commit.
    const content = await readFile(registryPath, 'utf8');
    const removal = removeRegistryProject(content, 'proj');
    expect(removal.removed).toBe(2); // both member repos' entries
    await writeFile(registryPath, removal.content, 'utf8');
    const commit = await commitWorkbenchPaths(
      sandbox.workbenchRoot,
      ['registry.md'],
      'proj: project removed from registry',
    );
    expect(commit).toEqual({ committed: true, error: null });

    // The other project's entry and the registry prose survive.
    const after = await readFile(registryPath, 'utf8');
    expect(parseRegistry(after).entries).toEqual([
      { repo: otherRepo, project: 'other', active: true },
    ]);
    expect(after).toContain('# Workbench registry');

    expect(await commitCount()).toBe(before + 1);
    const subject = await git(sandbox.workbenchRoot, 'log', '-1', '--format=%s');
    expect(subject.trim()).toBe('proj: project removed from registry');
    const status = await git(sandbox.workbenchRoot, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });

  it('is what stops discovery: the removed repos no longer resolve by cwd', async () => {
    const registryPath = join(sandbox.workbenchRoot, 'registry.md');
    const seeded = await readFile(registryPath, 'utf8');

    // Before: a session in repoA resolves to the workbench project.
    const beforeRes = resolveProject({
      registryContent: seeded,
      workbenchRoot: sandbox.workbenchRoot,
      cwd: sandbox.repoA,
      legacyIssuesPresent: false,
    });
    expect(beforeRes).toMatchObject({ kind: 'workbench', project: 'proj' });

    const removal = removeRegistryProject(seeded, 'proj');
    await writeFile(registryPath, removal.content, 'utf8');

    // After: the same cwd is unregistered — no resolution, no guessed path.
    const afterRes = resolveProject({
      registryContent: removal.content,
      workbenchRoot: sandbox.workbenchRoot,
      cwd: sandbox.repoA,
      legacyIssuesPresent: false,
    });
    expect(afterRes.kind).toBe('unresolved');
  });

  it('leaves the workbench project directory untouched — removal is registry-only', async () => {
    const issuesBefore = await readdir(sandbox.issuesRoot);
    const registryPath = join(sandbox.workbenchRoot, 'registry.md');

    const content = await readFile(registryPath, 'utf8');
    const removal = removeRegistryProject(content, 'proj');
    await writeFile(registryPath, removal.content, 'utf8');
    await commitWorkbenchPaths(
      sandbox.workbenchRoot,
      ['registry.md'],
      'proj: project removed from registry',
    );

    // Issues, CONFIG, and memory all still on disk, byte-identical.
    expect(await readdir(sandbox.issuesRoot)).toEqual(issuesBefore);
    expect(await readFile(join(sandbox.projectRoot, 'CONFIG.md'), 'utf8')).toBe(
      sandbox.configContent,
    );
    expect((await readFile(join(sandbox.memoryRoot, 'CORE.md'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('refuses an unknown project as a no-op: nothing written, nothing committed', async () => {
    const registryPath = join(sandbox.workbenchRoot, 'registry.md');
    const before = await commitCount();
    const content = await readFile(registryPath, 'utf8');

    const removal = removeRegistryProject(content, 'no-such-project');
    expect(removal.removed).toBe(0);
    // The handler returns before writing on removed: 0 — the registry (and
    // the commit count) stay exactly as they were.
    expect(removal.content).toBe(content);
    const commit = await commitWorkbenchPaths(
      sandbox.workbenchRoot,
      ['registry.md'],
      'no-such-project: project removed from registry',
    );
    expect(commit).toEqual({ committed: false, error: null });
    expect(await commitCount()).toBe(before);
  });
});
