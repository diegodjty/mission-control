/**
 * Pure logic for the command a Run's Pane spawns: a FRESH interactive `claude`
 * session scoped to one issue via the afk-issue-runner skill. This is the
 * issue-03 counterpart to `resolve-shell` (which the walking-skeleton Pane
 * uses); resolve-shell explicitly left `CLAUDE_BIN` as the override hook for
 * this slice.
 *
 * Kept free of Electron / node-pty imports so it stays unit-testable. The
 * actual spawn (with cwd = the Project repo) happens in the PTY Session Manager
 * adapter.
 */
import type { ShellCommand } from './resolve-shell';

/** The subset of a backlog issue a Run needs to scope itself. */
export interface RunIssueRef {
  id: number;
  fileName: string;
  title: string;
}

/**
 * The initial prompt handed to `claude` so it works EXACTLY this one issue via
 * the afk-issue-runner skill (non-drain, single-issue mode). Pure and
 * deterministic so it can be asserted in tests.
 */
export function buildRunPrompt(issue: RunIssueRef): string {
  const num = String(issue.id).padStart(2, '0');
  return (
    `Use the afk-issue-runner skill in normal single-issue (non-drain) mode to ` +
    `work EXACTLY issue ${num} (${issue.fileName}). ` +
    `Read ~/.claude/skills/afk-issue-runner/SKILL.md and issues/CONFIG.md, ` +
    `claim issue ${num} by flipping it to wip, complete it per its acceptance ` +
    `criteria, and stop after that one issue. Do not pick any other issue.`
  );
}

/**
 * Resolve the executable + args for a Run's Pane.
 *
 * Precedence:
 *   1. `MC_RUN_CMD` — explicit whole-command override (space-split). An escape
 *      hatch for tests / manual runs (e.g. a fake session, or `claude` at an
 *      odd path with extra flags). The scoped prompt is appended as the final
 *      argument so even the override still targets the right issue.
 *   2. `CLAUDE_BIN` (or the bare `claude` on PATH) with the scoped prompt as its
 *      positional initial-prompt argument.
 */
export function resolveRunCommand(
  env: Record<string, string | undefined>,
  issue: RunIssueRef,
): ShellCommand {
  const prompt = buildRunPrompt(issue);

  const override = env.MC_RUN_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: [...parts.slice(1), prompt] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  return { file: bin, args: [prompt] };
}
