/**
 * Pure logic for the command a **Dispatcher** session spawns: a fresh
 * interactive `claude` session running as the conversational orchestrator for a
 * drain (PRD-dispatcher, ADR-0007–0010). It is the Dispatcher counterpart to
 * `resolve-run-command` (which spawns a Worker on one issue) — same shape, a
 * different prompt.
 *
 * The Dispatcher session is the LLM integration in this slice: the app feeds it
 * the input contract (seed + a stream of Completion blocks, never raw Pane
 * output — see `dispatcher-input-contract`), and it synthesizes across Runs and
 * answers questions ("what's left?") from those summaries. The deterministic
 * mechanics around it — who starts next under the cap (Run Coordinator, via the
 * bridge), spawning worker Panes, committing the inter-issue checkpoint — are
 * the app's, NOT the LLM's (ADR-0008); the prompt says so explicitly.
 *
 * Kept free of Electron / node-pty imports so it stays unit-testable; the actual
 * spawn (cwd = the Project repo) happens in the PTY Session Manager adapter.
 */
import type { ShellCommand } from './resolve-shell';

/** The subset a Dispatcher session needs to scope itself to one Project. */
export interface DispatcherRef {
  /** The Project repo path the orchestrator session runs in (its cwd). */
  projectPath: string;
  /** The active PRD path (seed context), or null when none is set. */
  activePrd: string | null;
}

/**
 * The initial prompt handed to `claude` so it acts as the Dispatcher for this
 * drain. Pure and deterministic so it can be asserted in tests. It states the
 * ADR-0007/0008/0009 contract in plain terms: reason over summaries (never raw
 * Pane scroll), let the app/Run Coordinator handle scheduling, act freely on
 * reversible mechanics but ask before scope changes, synthesize as Runs finish,
 * and answer questions from the Completion blocks / Run log.
 */
export function buildDispatcherPrompt(ref: DispatcherRef): string {
  const prd = ref.activePrd ? ` The active PRD is ${ref.activePrd}.` : '';
  return (
    `You are the Dispatcher: the conversational orchestrator for a drain of this ` +
    `backlog in Mission Control.${prd} You reason over each Run's structured ` +
    `Completion block (its "what changed / try it / verified / doc drift"), which ` +
    `will be fed to you as each Run finishes — you never read a Run's raw terminal ` +
    `scroll. Scheduling (which issues start next under the concurrency cap, ` +
    `respecting depends_on) is handled deterministically by Mission Control's Run ` +
    `Coordinator, and spawning the worker Panes and committing a clean checkpoint ` +
    `between issues happen automatically — do NOT try to do that arithmetic or run ` +
    `git yourself. Act on your own only for safe, reversible mechanics (relaying ` +
    `and synthesizing progress). Ask for one-click approval before any ` +
    `scope-changing action (logging a new issue, a merge, aborting the drain, or ` +
    `changing course). As Runs finish, synthesize a short plain-language summary ` +
    `of what changed across them, and answer questions like "what's left?" from ` +
    `the Completion blocks and Run log — never from raw Pane output. Wait for the ` +
    `first Completion block before summarizing.`
  );
}

/**
 * Resolve the executable + args for a Dispatcher session's chat Pane.
 *
 * Precedence mirrors `resolveRunCommand`:
 *   1. `MC_DISPATCHER_CMD` — explicit whole-command override (space-split), for
 *      tests / manual runs (a fake session, or `claude` at an odd path). The
 *      orchestrator prompt is appended as the final argument.
 *   2. `CLAUDE_BIN` (or the bare `claude` on PATH) with the orchestrator prompt
 *      as its positional initial-prompt argument.
 */
export function resolveDispatcherCommand(
  env: Record<string, string | undefined>,
  ref: DispatcherRef,
): ShellCommand {
  const prompt = buildDispatcherPrompt(ref);

  const override = env.MC_DISPATCHER_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: [...parts.slice(1), prompt] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  return { file: bin, args: [prompt] };
}
