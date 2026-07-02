import { describe, it, expect } from 'vitest';
import { resolveShell } from './resolve-shell';

describe('resolveShell', () => {
  it('uses $SHELL on POSIX when set', () => {
    expect(resolveShell({ SHELL: '/bin/zsh' }, 'darwin')).toEqual({
      file: '/bin/zsh',
      args: [],
    });
  });

  it('falls back to /bin/bash on POSIX when $SHELL is unset', () => {
    expect(resolveShell({}, 'linux')).toEqual({ file: '/bin/bash', args: [] });
  });

  it('uses %COMSPEC% on win32 when set', () => {
    expect(
      resolveShell({ COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'),
    ).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] });
  });

  it('falls back to cmd.exe on win32 when %COMSPEC% is unset', () => {
    expect(resolveShell({}, 'win32')).toEqual({ file: 'cmd.exe', args: [] });
  });

  it('honours the MC_SHELL override ahead of platform defaults', () => {
    expect(
      resolveShell({ MC_SHELL: '/usr/local/bin/fish', SHELL: '/bin/zsh' }, 'darwin'),
    ).toEqual({ file: '/usr/local/bin/fish', args: [] });
  });

  it('ignores a blank/whitespace override and uses the platform default', () => {
    expect(resolveShell({ MC_SHELL: '   ', SHELL: '/bin/zsh' }, 'darwin')).toEqual({
      file: '/bin/zsh',
      args: [],
    });
  });
});
