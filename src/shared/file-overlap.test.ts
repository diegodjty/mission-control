import { describe, it, expect } from 'vitest';
import {
  footprintOverlap,
  matchesGlob,
  overlapSerializationNote,
  parseHotFiles,
  predictedFootprint,
} from './file-overlap';

describe('parseHotFiles', () => {
  it('parses a flow list', () => {
    const config = '---\nhot_files: [src/renderer/src/App.tsx, src/shared/god.ts]\n---\n';
    expect(parseHotFiles(config)).toEqual(['src/renderer/src/App.tsx', 'src/shared/god.ts']);
  });

  it('parses a YAML block list', () => {
    const config = '---\nhot_files:\n  - src/renderer/src/App.tsx\n  - src/shared/god.ts\n---\n';
    expect(parseHotFiles(config)).toEqual(['src/renderer/src/App.tsx', 'src/shared/god.ts']);
  });

  it('returns [] when unset, or content is null', () => {
    expect(parseHotFiles('---\nrepos:\n  a: /x\n---\n')).toEqual([]);
    expect(parseHotFiles(null)).toEqual([]);
    expect(parseHotFiles(undefined)).toEqual([]);
  });
});

describe('matchesGlob', () => {
  it('matches a literal path against itself', () => {
    expect(matchesGlob('src/App.tsx', 'src/App.tsx')).toBe(true);
    expect(matchesGlob('src/App.tsx', 'src/Other.tsx')).toBe(false);
  });

  it('matches `*` across path segments', () => {
    expect(matchesGlob('src/shared/*', 'src/shared/god.ts')).toBe(true);
    expect(matchesGlob('src/shared/*', 'src/renderer/god.ts')).toBe(false);
  });
});

describe('predictedFootprint', () => {
  it('includes declared `touches` globs verbatim', () => {
    const issue = { touches: ['src/shared/god.ts'], body: 'nothing relevant here' };
    expect(predictedFootprint(issue, [])).toEqual(['src/shared/god.ts']);
  });

  it('adds a hot file the body mentions by full path', () => {
    const issue = { touches: [], body: 'This edits src/renderer/src/App.tsx directly.' };
    expect(predictedFootprint(issue, ['src/renderer/src/App.tsx'])).toEqual([
      'src/renderer/src/App.tsx',
    ]);
  });

  it('adds a hot file the body mentions by base name only', () => {
    const issue = { touches: [], body: 'This wires a new route into App.tsx.' };
    expect(predictedFootprint(issue, ['src/renderer/src/App.tsx'])).toEqual([
      'src/renderer/src/App.tsx',
    ]);
  });

  it('does not add a hot file the body never mentions', () => {
    const issue = { touches: [], body: 'This only touches a backend module.' };
    expect(predictedFootprint(issue, ['src/renderer/src/App.tsx'])).toEqual([]);
  });

  it('dedupes when touches and a hot-file mention name the same path', () => {
    const issue = {
      touches: ['src/renderer/src/App.tsx'],
      body: 'Also edits src/renderer/src/App.tsx.',
    };
    expect(predictedFootprint(issue, ['src/renderer/src/App.tsx'])).toEqual([
      'src/renderer/src/App.tsx',
    ]);
  });
});

describe('footprintOverlap', () => {
  it('finds an exact shared path', () => {
    expect(footprintOverlap(['src/App.tsx'], ['src/App.tsx'])).toBe('src/App.tsx');
  });

  it('finds a glob-vs-literal overlap in either direction', () => {
    expect(footprintOverlap(['src/shared/*'], ['src/shared/god.ts'])).toBe('src/shared/god.ts');
    expect(footprintOverlap(['src/shared/god.ts'], ['src/shared/*'])).toBe('src/shared/god.ts');
  });

  it('returns null for genuinely disjoint footprints', () => {
    expect(footprintOverlap(['src/a.ts'], ['src/b.ts'])).toBeNull();
  });

  it('returns null for two empty footprints', () => {
    expect(footprintOverlap([], [])).toBeNull();
  });
});

describe('overlapSerializationNote', () => {
  it('names the lower issue id first regardless of argument order', () => {
    expect(overlapSerializationNote(167, 161, 'App.tsx')).toBe(
      '161 and 167 both touch App.tsx — running serially.',
    );
    expect(overlapSerializationNote(161, 167, 'App.tsx')).toBe(
      '161 and 167 both touch App.tsx — running serially.',
    );
  });
});
