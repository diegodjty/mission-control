/**
 * Unit tests for the pure install-artifact hygiene rules (issue 98): which paths
 * count as local install artifacts, and the truthful merge-preflight refusal
 * message that names them.
 */
import { describe, it, expect } from 'vitest';
import {
  isIgnoredArtifactPath,
  ignoredArtifactPaths,
  artifactMergeRefusalMessage,
} from './artifact-hygiene';

describe('isIgnoredArtifactPath — matches install artifacts by path segment', () => {
  it('matches node_modules exactly and nested under it', () => {
    expect(isIgnoredArtifactPath('node_modules')).toBe(true);
    expect(isIgnoredArtifactPath('node_modules/vitest/index.js')).toBe(true);
  });

  it('matches a node_modules nested anywhere in the path (monorepo package dir)', () => {
    expect(isIgnoredArtifactPath('packages/app/node_modules/x')).toBe(true);
  });

  it('matches the sibling build outputs the repo also ignores', () => {
    expect(isIgnoredArtifactPath('dist/main.js')).toBe(true);
    expect(isIgnoredArtifactPath('out/index.html')).toBe(true);
  });

  it('does NOT match innocent lookalikes — segment boundaries matter', () => {
    expect(isIgnoredArtifactPath('my_node_modules/x')).toBe(false);
    expect(isIgnoredArtifactPath('node_modules_backup')).toBe(false);
    expect(isIgnoredArtifactPath('distribution/readme.md')).toBe(false);
    expect(isIgnoredArtifactPath('src/feature.ts')).toBe(false);
    expect(isIgnoredArtifactPath('README.md')).toBe(false);
  });

  it('normalises Windows-style separators', () => {
    expect(isIgnoredArtifactPath('packages\\app\\node_modules\\x')).toBe(true);
  });
});

describe('ignoredArtifactPaths — filters a mixed path list', () => {
  it('keeps only artifact paths, order-preserving and deduped', () => {
    const paths = [
      'src/feature.ts',
      'node_modules',
      'issues/94.md',
      'node_modules/vitest/index.js',
      'node_modules', // duplicate
      'dist/main.js',
    ];
    expect(ignoredArtifactPaths(paths)).toEqual([
      'node_modules',
      'node_modules/vitest/index.js',
      'dist/main.js',
    ]);
  });

  it('returns [] when nothing is an artifact', () => {
    expect(ignoredArtifactPaths(['src/a.ts', 'README.md'])).toEqual([]);
  });
});

describe('artifactMergeRefusalMessage — truthful, issue-59-style', () => {
  it('names the single offending branch, its path, and the real cause', () => {
    const msg = artifactMergeRefusalMessage('main', [
      { slug: '94-x', paths: ['node_modules'] },
    ]);
    expect(msg).toContain('Merge preflight failed');
    expect(msg).toContain('branch afk/94-x (node_modules)');
    expect(msg).toContain('to main');
    expect(msg).toContain('self-referential');
    expect(msg).toContain('issue 98');
    // A preflight refusal is NOT a conflict — it must never read as one.
    expect(msg).not.toMatch(/conflict/i);
  });

  it('lists every offending branch when more than one carries an artifact', () => {
    const msg = artifactMergeRefusalMessage('master', [
      { slug: '94-x', paths: ['node_modules'] },
      { slug: '96-y', paths: ['node_modules', 'dist/main.js'] },
    ]);
    expect(msg).toContain('branches');
    expect(msg).toContain('afk/94-x (node_modules)');
    expect(msg).toContain('afk/96-y (node_modules, dist/main.js)');
    expect(msg).toContain('to master');
  });

  it('summarises a long path list with a (+N more) suffix', () => {
    const many = Array.from({ length: 7 }, (_, i) => `node_modules/pkg-${i}/index.js`);
    const msg = artifactMergeRefusalMessage('main', [{ slug: '94-x', paths: many }]);
    expect(msg).toContain('(+3 more)');
  });
});
