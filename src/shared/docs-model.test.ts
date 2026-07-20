import { describe, it, expect } from 'vitest';
import {
  deriveDocEntries,
  isAdrDocsChange,
  isAllowedDoc,
  isDocsDirChange,
  isRepoDocsChange,
  type DocsRoots,
} from './docs-model';

const roots: DocsRoots = { repoPath: '/code/repo' };

describe('deriveDocEntries', () => {
  it('orders ARCHITECTURE.md, then CONTEXT.md, then ADRs by file name', () => {
    const entries = deriveDocEntries(roots, {
      architectureMtimeMs: 10,
      contextMtimeMs: 5,
      adrFiles: [
        { name: '0016-mc-guides.md', mtimeMs: 30 },
        { name: '0001-first.md', mtimeMs: 20 },
      ],
    });
    expect(entries.map((e) => e.label)).toEqual([
      'ARCHITECTURE.md',
      'CONTEXT.md',
      'docs/adr/0001-first.md',
      'docs/adr/0016-mc-guides.md',
    ]);
    expect(entries.map((e) => e.group)).toEqual(['architecture', 'context', 'adr', 'adr']);
    expect(entries[0].path).toBe('/code/repo/docs/ARCHITECTURE.md');
    expect(entries[1].path).toBe('/code/repo/CONTEXT.md');
    expect(entries[2].path).toBe('/code/repo/docs/adr/0001-first.md');
  });

  it('omits ARCHITECTURE.md/CONTEXT.md when absent, and tolerates an empty ADR dir', () => {
    const entries = deriveDocEntries(roots, {
      architectureMtimeMs: null,
      contextMtimeMs: null,
      adrFiles: [],
    });
    expect(entries).toEqual([]);
  });

  it('excludes dotfiles and non-markdown ADR entries', () => {
    const entries = deriveDocEntries(roots, {
      architectureMtimeMs: null,
      contextMtimeMs: null,
      adrFiles: [
        { name: '.hidden.md', mtimeMs: 1 },
        { name: 'notes.txt', mtimeMs: 1 },
        { name: '0001-real.md', mtimeMs: 1 },
      ],
    });
    expect(entries.map((e) => e.label)).toEqual(['docs/adr/0001-real.md']);
  });
});

describe('watch relevance', () => {
  it('isRepoDocsChange: CONTEXT.md and docs appearing are relevant; other root files are not', () => {
    expect(isRepoDocsChange('CONTEXT.md')).toBe(true);
    expect(isRepoDocsChange('docs')).toBe(true);
    expect(isRepoDocsChange('package.json')).toBe(false);
    expect(isRepoDocsChange(null)).toBe(true);
  });

  it('isDocsDirChange: ARCHITECTURE.md and adr appearing are relevant; other docs files are not', () => {
    expect(isDocsDirChange('ARCHITECTURE.md')).toBe(true);
    expect(isDocsDirChange('adr')).toBe(true);
    expect(isDocsDirChange('design')).toBe(false);
    expect(isDocsDirChange(null)).toBe(true);
  });

  it('isAdrDocsChange: any markdown file is relevant; dotfiles are not', () => {
    expect(isAdrDocsChange('0001-x.md')).toBe(true);
    expect(isAdrDocsChange('.hidden.md')).toBe(false);
    expect(isAdrDocsChange('notes.txt')).toBe(false);
    expect(isAdrDocsChange(null)).toBe(true);
  });
});

describe('isAllowedDoc', () => {
  it('allows ARCHITECTURE.md, CONTEXT.md, and docs/adr files under the repo', () => {
    expect(isAllowedDoc(roots, '/code/repo/docs/ARCHITECTURE.md')).toBe(true);
    expect(isAllowedDoc(roots, '/code/repo/CONTEXT.md')).toBe(true);
    expect(isAllowedDoc(roots, '/code/repo/docs/adr/0001-x.md')).toBe(true);
  });

  it('rejects paths outside the allowlist, traversal attempts, and non-markdown', () => {
    expect(isAllowedDoc(roots, '/code/repo/README.md')).toBe(false);
    expect(isAllowedDoc(roots, '/code/repo/docs/design/mock.md')).toBe(false);
    expect(isAllowedDoc(roots, '/code/repo/docs/adr/../../../etc/passwd.md')).toBe(false);
    expect(isAllowedDoc(roots, '/code/repo/docs/adr/0001-x.txt')).toBe(false);
    expect(isAllowedDoc(roots, '/other/repo/CONTEXT.md')).toBe(false);
  });
});
