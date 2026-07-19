/**
 * Worktree verify (main, issue 170) — runs the project's verify commands
 * (`npm run type-check`, `npm run test`) against a killed Run's stranded
 * worktree, so a salvage decision (complete-from-worktree / discard-and-
 * requeue) is made on EVIDENCE, never a guess — the same "machine before
 * human" discipline the project's own CONFIG requires of a Worker before it
 * marks an issue done.
 *
 * A thin I/O edge: sequential plain `child_process` spawns (no pty, no
 * streaming — the caller wants pass/fail + a short output tail, not a live
 * Feed), modeled on the Headless Session Manager's spawn shape.
 */
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 20_000;

function tail(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

interface CommandResult {
  command: string;
  exitCode: number;
  output: string;
}

function runCommand(cwd: string, command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd });
    let output = '';
    proc.stdout?.on('data', (d) => (output += d.toString()));
    proc.stderr?.on('data', (d) => (output += d.toString()));
    proc.on('error', (err) => {
      resolve({ command: `${command} ${args.join(' ')}`, exitCode: 127, output: String(err) });
    });
    proc.on('close', (code) => {
      resolve({
        command: `${command} ${args.join(' ')}`,
        exitCode: typeof code === 'number' ? code : 1,
        output: tail(output),
      });
    });
  });
}

export interface WorktreeVerifyResult {
  /** True only when every verify command exited 0. */
  passed: boolean;
  /** A human-readable tail of each command's output, for the salvage UI. */
  output: string;
}

/**
 * Run `npm run type-check` then `npm run test` in `worktreePath`, stopping at
 * the first failure (a broken type-check makes the test run moot — and a
 * stuck/misbehaving Worker's worktree may not even build). Any command that
 * fails to spawn at all (exit 127) counts as a verify failure, never a throw.
 */
export async function verifyWorktree(worktreePath: string): Promise<WorktreeVerifyResult> {
  const commands: readonly { command: string; args: string[] }[] = [
    { command: 'npm', args: ['run', 'type-check'] },
    { command: 'npm', args: ['run', 'test'] },
  ];

  const outputs: string[] = [];
  for (const { command, args } of commands) {
    const result = await runCommand(worktreePath, command, args);
    outputs.push(`$ ${result.command}\n${result.output}`.trim());
    if (result.exitCode !== 0) {
      return { passed: false, output: outputs.join('\n\n') };
    }
  }
  return { passed: true, output: outputs.join('\n\n') };
}
