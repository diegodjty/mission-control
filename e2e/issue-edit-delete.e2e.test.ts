/**
 * E2E — issue-file Edit / Delete against a temp workbench (issue 89,
 * ADR-0016 walkthrough finding).
 *
 * The Map's one write exception, exercised at module level exactly as the
 * main-process handlers compose it: the fs edge (`issue-file-store`) writing
 * into a REAL temp workbench git repo, the reparse through the REAL backlog
 * reader, and one boring workbench auto-commit per operation through the
 * REAL commit path (`workbench-git`) — mirroring the `IssueFileEdit` /
 * `IssueFileDelete` handler wiring in `src/main/index.ts`.
 *
 * Covered, per the issue's acceptance criteria:
 *   - Edit round-trips byte-what-was-typed; the reparsed backlog reflects it.
 *   - A parse-breaking save is refused naming the problem; disk untouched.
 *   - Delete removes the file after the (UI-side) confirm; `wip` is refused
 *     from CURRENT on-disk state; done deletes proceed ("delete anyway" is a
 *     renderer confirm, not an edge distinction).
 *   - Workbench projects get exactly ONE boring commit per operation, scoped
 *     to the project dir, leaving the workbench tree clean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteIssueFile, readIssueText, writeIssueText } from '../src/main/issue-file-store';
import { commitWorkbenchProject } from '../src/main/workbench-git';
import { readBacklogAt } from '../src/main/backlog-reader';
import {
  git,
  issueFileContent,
  seedWorkbenchSandbox,
  workbenchIssue,
  type WorkbenchSandbox,
} from './sandbox';

let sandbox: WorkbenchSandbox;

beforeEach(async () => {
  sandbox = await seedWorkbenchSandbox();
});

afterEach(async () => {
  await rm(sandbox.scratch, { recursive: true, force: true });
});

async function commitCount(): Promise<number> {
  const out = await git(sandbox.workbenchRoot, 'rev-list', '--count', 'HEAD');
  return Number(out.trim());
}

describe('issue edit against a temp workbench', () => {
  it('round-trips byte-what-was-typed and the reparsed backlog reflects it', async () => {
    const fileName = '04-b-independent.md';
    const before = await readIssueText(sandbox.issuesRoot, fileName);
    expect(before.error).toBeNull();

    // What a human would type into the raw editor: a status flip, a new
    // dependency, a reworded body — and deliberately no trailing newline.
    const typed =
      '---\nstatus: open\ndepends_on: [1, 2]\nrepo: b\n---\n\n' +
      '# 4 — B independent (edited)\n\nRe-scoped by hand in the Map editor.';
    const saved = await writeIssueText(sandbox.issuesRoot, fileName, typed);
    expect(saved).toEqual({ ok: true, error: null });

    const onDisk = await readFile(join(sandbox.issuesRoot, fileName), 'utf8');
    expect(onDisk).toBe(typed);

    // The real backlog reader (what the Map's watcher re-reads) sees the edit.
    const backlog = await readBacklogAt(sandbox.issuesRoot);
    const issue4 = backlog.issues.find((i) => i.id === 4);
    expect(issue4?.title).toBe('4 — B independent (edited)');
    expect(issue4?.dependsOn).toEqual([1, 2]);
    expect(issue4?.repoKey).toBe('b');
  });

  it('refuses a parse-breaking save with the reason and leaves the file untouched', async () => {
    const fileName = '02-core-api.md';
    const original = await readFile(join(sandbox.issuesRoot, fileName), 'utf8');

    const broken = await writeIssueText(
      sandbox.issuesRoot,
      fileName,
      '---\nstatus: in-progress\ndepends_on: []\n---\n\n# 2 — Core API\n',
    );
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('in-progress');

    const noFrontmatter = await writeIssueText(sandbox.issuesRoot, fileName, '# 2 — Core API\n');
    expect(noFrontmatter.ok).toBe(false);
    expect(noFrontmatter.error).toMatch(/frontmatter/i);

    expect(await readFile(join(sandbox.issuesRoot, fileName), 'utf8')).toBe(original);
  });

  it('lands exactly one boring workbench commit per edit, leaving the tree clean', async () => {
    const fileName = '02-core-api.md';
    const before = await commitCount();

    const typed =
      '---\nstatus: open\ndepends_on: []\nrepo: a\n---\n\n# 2 — Core API\n\nEdited body.\n';
    const saved = await writeIssueText(sandbox.issuesRoot, fileName, typed);
    expect(saved.ok).toBe(true);
    // The handler's commit step (same message shape, same commit path).
    const commit = await commitWorkbenchProject(sandbox.projectRoot, 'proj: issue 02 edited');
    expect(commit).toEqual({ committed: true, error: null });

    expect(await commitCount()).toBe(before + 1);
    const subject = await git(sandbox.workbenchRoot, 'log', '-1', '--format=%s');
    expect(subject.trim()).toBe('proj: issue 02 edited');
    const status = await git(sandbox.workbenchRoot, 'status', '--porcelain');
    expect(status.trim()).toBe('');

    // A refused save commits nothing: nothing changed on disk.
    const refused = await writeIssueText(sandbox.issuesRoot, fileName, 'no frontmatter');
    expect(refused.ok).toBe(false);
    const again = await commitWorkbenchProject(sandbox.projectRoot, 'proj: issue 02 edited');
    expect(again).toEqual({ committed: false, error: null });
    expect(await commitCount()).toBe(before + 1);
  });
});

describe('issue delete against a temp workbench', () => {
  it('deletes an open issue after confirm and commits once', async () => {
    const fileName = '08-a-followup.md';
    const before = await commitCount();

    const res = await deleteIssueFile(sandbox.issuesRoot, fileName);
    expect(res).toEqual({ ok: true, error: null });
    expect(await readdir(sandbox.issuesRoot)).not.toContain(fileName);

    const backlog = await readBacklogAt(sandbox.issuesRoot);
    expect(backlog.issues.map((i) => i.id)).not.toContain(8);

    const commit = await commitWorkbenchProject(sandbox.projectRoot, 'proj: issue 08 deleted');
    expect(commit).toEqual({ committed: true, error: null });
    expect(await commitCount()).toBe(before + 1);
    const subject = await git(sandbox.workbenchRoot, 'log', '-1', '--format=%s');
    expect(subject.trim()).toBe('proj: issue 08 deleted');
    const status = await git(sandbox.workbenchRoot, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });

  it('refuses a wip issue from CURRENT on-disk state — someone owns it', async () => {
    // Claim 04 on disk (as a Worker would), then try to delete it: the edge
    // re-reads the file, so even a caller holding a stale "open" view is
    // refused.
    const fileName = '04-b-independent.md';
    await writeFile(
      join(sandbox.issuesRoot, fileName),
      issueFileContent(workbenchIssue(4), 'wip'),
      'utf8',
    );

    const res = await deleteIssueFile(sandbox.issuesRoot, fileName);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wip/);
    expect(await readdir(sandbox.issuesRoot)).toContain(fileName);
  });

  it('allows a done delete (the renderer gates it behind "delete anyway")', async () => {
    const fileName = '01-foundation.md';
    const res = await deleteIssueFile(sandbox.issuesRoot, fileName);
    expect(res).toEqual({ ok: true, error: null });
    expect(await readdir(sandbox.issuesRoot)).not.toContain(fileName);
  });

  it('never reaches outside the issues root (CONFIG and traversal refused)', async () => {
    for (const name of ['CONFIG.md', '../CONFIG.md', '../../registry.md']) {
      const res = await deleteIssueFile(sandbox.issuesRoot, name);
      expect(res.ok).toBe(false);
    }
    expect(await readFile(join(sandbox.projectRoot, 'CONFIG.md'), 'utf8')).toBe(
      sandbox.configContent,
    );
  });
});
