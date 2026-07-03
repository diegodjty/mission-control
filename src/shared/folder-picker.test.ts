import { describe, it, expect } from 'vitest';
import { resolvePickedFolder, resolvePickerDefaultPath } from './folder-picker';

describe('resolvePickedFolder', () => {
  it('returns the chosen directory when one was picked', () => {
    expect(
      resolvePickedFolder({ canceled: false, filePaths: ['/repos/repo-a'] }),
    ).toBe('/repos/repo-a');
  });

  it('returns null when the dialog was cancelled (no-op)', () => {
    expect(resolvePickedFolder({ canceled: true, filePaths: [] })).toBeNull();
  });

  it('returns null when cancelled even if a stale path is present', () => {
    // Some platforms leave filePaths populated on cancel; canceled wins.
    expect(
      resolvePickedFolder({ canceled: true, filePaths: ['/repos/repo-a'] }),
    ).toBeNull();
  });

  it('returns null when nothing was chosen (empty filePaths)', () => {
    expect(resolvePickedFolder({ canceled: false, filePaths: [] })).toBeNull();
  });

  it('treats a whitespace-only path as no choice', () => {
    expect(resolvePickedFolder({ canceled: false, filePaths: ['   '] })).toBeNull();
  });

  it('trims surrounding whitespace from the chosen path', () => {
    expect(
      resolvePickedFolder({ canceled: false, filePaths: ['  /repos/repo-a  '] }),
    ).toBe('/repos/repo-a');
  });

  it('takes the first path when several are returned', () => {
    expect(
      resolvePickedFolder({ canceled: false, filePaths: ['/repos/first', '/repos/second'] }),
    ).toBe('/repos/first');
  });
});

describe('resolvePickerDefaultPath', () => {
  it('uses the last-used folder when there is one', () => {
    expect(resolvePickerDefaultPath('/repos/repo-a', '/home/dev')).toBe('/repos/repo-a');
  });

  it('falls back to the home directory when there is no last-used folder', () => {
    expect(resolvePickerDefaultPath(null, '/home/dev')).toBe('/home/dev');
    expect(resolvePickerDefaultPath(undefined, '/home/dev')).toBe('/home/dev');
  });

  it('ignores a blank/whitespace last-used value', () => {
    expect(resolvePickerDefaultPath('   ', '/home/dev')).toBe('/home/dev');
  });
});
