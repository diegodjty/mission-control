/**
 * Pure logic for deciding which process a Pane's PTY should spawn.
 *
 * Kept free of any Electron / node-pty imports so it stays unit-testable
 * (see PRD "keep pure modules importable by main and free of Electron APIs").
 *
 * For the walking skeleton we spawn an interactive shell. A later slice
 * (issue 03) will use `CLAUDE_BIN` to spawn `claude` itself; the override
 * hook is here now so that change is a one-liner.
 */

export interface ShellCommand {
  /** Executable to spawn. */
  file: string;
  /** Arguments passed to the executable. */
  args: string[];
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the command a Pane should spawn.
 *
 * Precedence:
 *   1. `MC_SHELL` env override (explicit escape hatch, mostly for tests).
 *   2. Platform default: `$SHELL` on POSIX, `%COMSPEC%` on Windows.
 *   3. Hard fallback: `/bin/bash` (POSIX) or `cmd.exe` (Windows).
 */
export function resolveShell(env: EnvLike, platform: NodeJS.Platform): ShellCommand {
  const override = env.MC_SHELL?.trim();
  if (override) {
    return { file: override, args: [] };
  }

  if (platform === 'win32') {
    return { file: env.COMSPEC?.trim() || 'cmd.exe', args: [] };
  }

  return { file: env.SHELL?.trim() || '/bin/bash', args: [] };
}
