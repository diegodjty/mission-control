import { describe, it, expect } from 'vitest';
import {
  isIssueFileName,
  validateIssueEdit,
  deleteRefusal,
} from './issue-file-ops';

const FILE = '42-example-slug.md';

function issueText(over: { status?: string; dependsOn?: string; frontmatter?: string }): string {
  const frontmatter =
    over.frontmatter ??
    `---\nstatus: ${over.status ?? 'open'}\ndepends_on: ${over.dependsOn ?? '[]'}\n---\n`;
  return `${frontmatter}\n# 42 — Example slug\n\n## What to build\n\nA thing.\n`;
}

describe('isIssueFileName', () => {
  it('accepts NN-slug.md names', () => {
    expect(isIssueFileName('01-foundation.md')).toBe(true);
    expect(isIssueFileName('89-issue-edit-and-delete.md')).toBe(true);
  });

  it('rejects non-issue files and path traversal', () => {
    expect(isIssueFileName('CONFIG.md')).toBe(false);
    expect(isIssueFileName('HUMAN-SETUP.md')).toBe(false);
    expect(isIssueFileName('01-foundation.txt')).toBe(false);
    expect(isIssueFileName('../42-escape.md')).toBe(false);
    expect(isIssueFileName('42-a/../../etc.md')).toBe(false);
    expect(isIssueFileName('sub/42-nested.md')).toBe(false);
    expect(isIssueFileName('42-back\\slash.md')).toBe(false);
    expect(isIssueFileName('')).toBe(false);
  });
});

describe('validateIssueEdit', () => {
  it('accepts a well-formed issue file', () => {
    expect(validateIssueEdit(FILE, issueText({}))).toEqual({ ok: true });
  });

  it('accepts every legal status', () => {
    for (const status of ['open', 'wip', 'done']) {
      expect(validateIssueEdit(FILE, issueText({ status }))).toEqual({ ok: true });
    }
  });

  it('accepts a real depends_on list', () => {
    expect(validateIssueEdit(FILE, issueText({ dependsOn: '[1, 2, 30]' }))).toEqual({
      ok: true,
    });
  });

  it('refuses a non-issue file name', () => {
    const res = validateIssueEdit('CONFIG.md', issueText({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/NN-slug\.md/);
  });

  it('refuses text without a frontmatter block, naming the problem', () => {
    const res = validateIssueEdit(FILE, '# 42 — no frontmatter\n\nbody\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/frontmatter/i);
  });

  it('refuses an unclosed frontmatter block', () => {
    const res = validateIssueEdit(FILE, '---\nstatus: open\n\n# heading\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/frontmatter/i);
  });

  it('refuses a missing status line', () => {
    const res = validateIssueEdit(FILE, issueText({ frontmatter: '---\ndepends_on: []\n---\n' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/status/);
  });

  it('refuses an illegal status value, naming it', () => {
    const res = validateIssueEdit(FILE, issueText({ status: 'blocked' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('blocked');
      expect(res.reason).toMatch(/open.*wip.*done/);
    }
  });

  it('refuses a depends_on entry that is not a number, naming the token', () => {
    const res = validateIssueEdit(FILE, issueText({ dependsOn: '[1, seven]' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('seven');
  });

  it('accepts a missing depends_on line (defaults to none)', () => {
    expect(
      validateIssueEdit(FILE, issueText({ frontmatter: '---\nstatus: open\n---\n' })),
    ).toEqual({ ok: true });
  });

  it('refuses empty text', () => {
    const res = validateIssueEdit(FILE, '');
    expect(res.ok).toBe(false);
  });
});

describe('deleteRefusal', () => {
  it('refuses wip — someone owns it', () => {
    const reason = deleteRefusal('wip');
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/wip/);
  });

  it('allows open and done', () => {
    expect(deleteRefusal('open')).toBeNull();
    expect(deleteRefusal('done')).toBeNull();
  });
});
