import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIssueText, writeIssueText, deleteIssueFile } from './issue-file-store';

let issuesRoot: string;

const OPEN_ISSUE = '---\nstatus: open\ndepends_on: []\n---\n\n# 03 — Third thing\n\nBody.\n';
const WIP_ISSUE = '---\nstatus: wip\ndepends_on: []\n---\n\n# 04 — Claimed thing\n\nBody.\n';
const DONE_ISSUE = '---\nstatus: done\ndepends_on: []\n---\n\n# 05 — Done thing\n\nBody.\n';

beforeEach(async () => {
  issuesRoot = await mkdtemp(join(tmpdir(), 'mc-issue-store-'));
  await writeFile(join(issuesRoot, '03-third-thing.md'), OPEN_ISSUE, 'utf8');
  await writeFile(join(issuesRoot, '04-claimed-thing.md'), WIP_ISSUE, 'utf8');
  await writeFile(join(issuesRoot, '05-done-thing.md'), DONE_ISSUE, 'utf8');
});

afterEach(async () => {
  await rm(issuesRoot, { recursive: true, force: true });
});

describe('readIssueText', () => {
  it('returns the raw file text verbatim', async () => {
    const res = await readIssueText(issuesRoot, '03-third-thing.md');
    expect(res).toEqual({ content: OPEN_ISSUE, error: null });
  });

  it('reports a missing file', async () => {
    const res = await readIssueText(issuesRoot, '99-not-there.md');
    expect(res.content).toBeNull();
    expect(res.error).toMatch(/99-not-there\.md/);
  });

  it('refuses a non-issue file name (no CONFIG reads, no traversal)', async () => {
    await writeFile(join(issuesRoot, 'CONFIG.md'), 'secret config', 'utf8');
    for (const name of ['CONFIG.md', '../03-third-thing.md', 'a/03-b.md']) {
      const res = await readIssueText(issuesRoot, name);
      expect(res.content).toBeNull();
      expect(res.error).not.toBeNull();
    }
  });
});

describe('writeIssueText', () => {
  it('writes byte-what-was-typed (no normalization, trailing state preserved)', async () => {
    const typed = '---\nstatus: wip\ndepends_on: [1]\n---\n# 03 — Renamed\n\nnew body, no trailing newline';
    const res = await writeIssueText(issuesRoot, '03-third-thing.md', typed);
    expect(res).toEqual({ ok: true, error: null });
    const onDisk = await readFile(join(issuesRoot, '03-third-thing.md'), 'utf8');
    expect(onDisk).toBe(typed);
  });

  it('refuses a parse-breaking save, naming the reason, and leaves the file untouched', async () => {
    const res = await writeIssueText(
      issuesRoot,
      '03-third-thing.md',
      '---\nstatus: banana\n---\n# 03\n',
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('banana');
    const onDisk = await readFile(join(issuesRoot, '03-third-thing.md'), 'utf8');
    expect(onDisk).toBe(OPEN_ISSUE);
  });

  it('refuses to edit a file that does not exist (edit is not create)', async () => {
    const res = await writeIssueText(issuesRoot, '99-not-there.md', OPEN_ISSUE);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/99-not-there\.md/);
    const names = await readdir(issuesRoot);
    expect(names).not.toContain('99-not-there.md');
  });

  it('refuses a non-issue file name', async () => {
    const res = await writeIssueText(issuesRoot, 'CONFIG.md', '---\nstatus: open\n---\n# x\n');
    expect(res.ok).toBe(false);
    expect(res.error).not.toBeNull();
  });
});

describe('deleteIssueFile', () => {
  it('deletes an open issue', async () => {
    const res = await deleteIssueFile(issuesRoot, '03-third-thing.md');
    expect(res).toEqual({ ok: true, error: null });
    const names = await readdir(issuesRoot);
    expect(names).not.toContain('03-third-thing.md');
  });

  it('deletes a done issue (the UI gates this behind "delete anyway")', async () => {
    const res = await deleteIssueFile(issuesRoot, '05-done-thing.md');
    expect(res).toEqual({ ok: true, error: null });
  });

  it('refuses a wip issue — someone owns it — and keeps the file', async () => {
    const res = await deleteIssueFile(issuesRoot, '04-claimed-thing.md');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wip/);
    const onDisk = await readFile(join(issuesRoot, '04-claimed-thing.md'), 'utf8');
    expect(onDisk).toBe(WIP_ISSUE);
  });

  it('reads the CURRENT on-disk status, not what the caller believed', async () => {
    // The renderer may hold a stale backlog; the edge re-reads before acting.
    await writeFile(join(issuesRoot, '03-third-thing.md'), WIP_ISSUE, 'utf8');
    const res = await deleteIssueFile(issuesRoot, '03-third-thing.md');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wip/);
  });

  it('reports a missing file', async () => {
    const res = await deleteIssueFile(issuesRoot, '99-not-there.md');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/99-not-there\.md/);
  });

  it('refuses a non-issue file name', async () => {
    await writeFile(join(issuesRoot, 'CONFIG.md'), 'config', 'utf8');
    const res = await deleteIssueFile(issuesRoot, 'CONFIG.md');
    expect(res.ok).toBe(false);
    const names = await readdir(issuesRoot);
    expect(names).toContain('CONFIG.md');
  });
});
