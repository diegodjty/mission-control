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
import { coreMemorySection } from '../shared/workbench-memory';
import {
  modelIdForTier,
  type WorkerEffort,
  type WorkerModelTier,
} from '../shared/worker-model';

/**
 * Spawn-time options a Run's command builder honors (issues 154/155): the model
 * tier and the reasoning effort. Both are present ONLY for a Run the DRAIN
 * spawns unattended, absent for every interactive entry point (a manual Run now,
 * a Simple issue, a Quick fix, a Grill/Planning session, Just talk) — which
 * keeps inheriting the interactive defaults. The tiering, in other words, fires
 * purely by whether the caller passes these, so a manual Pane can never be
 * silently downgraded.
 */
export interface RunCommandOptions {
  /**
   * The tier this drain Worker spawns on. When set, `--model <id>` is injected
   * ahead of the positional prompt. The `MC_RUN_CMD` override branch is never
   * tiered — an override (e.g. the e2e fake Worker) defines its own argv.
   */
  model?: WorkerModelTier | null;
  /**
   * The reasoning effort this drain Worker spawns on (issue 155). When set,
   * `--effort <level>` is injected ahead of the positional prompt, alongside
   * `--model`. Same drain-only scope and same `MC_RUN_CMD`-override exemption as
   * `model` — an override defines its own argv and is never tiered.
   */
  effort?: WorkerEffort | null;
}

/**
 * The workbench paths a workbench Project's Run carries in its prompt (issue
 * 72, ADR-0015): explicit paths are the FIRST step of the skill's discovery
 * order, so a Worker spawned with them never has to guess where the backlog
 * lives — its cwd is a code repo that holds no `issues/` at all.
 */
export interface RunWorkbenchPaths {
  /** Where the project's `NN-slug.md` issue files live. */
  issuesRoot: string;
  /** Where Receipts land: `~/Workbench/<project>/completions`. */
  completionsRoot: string;
}

/** The subset of a backlog issue a Run needs to scope itself. */
export interface RunIssueRef {
  id: number;
  fileName: string;
  title: string;
  /**
   * The Run's RESOLVED working directory — its own worktree in parallel mode,
   * the Project repo in solo mode; for a workbench Project, the issue's TARGET
   * repo (its `repo:` key, else the project default — issue 72). Used to spell
   * out the Run's absolute Receipt path in the prompt (issue 62): Workers are
   * LLMs, and a parallel Worker once wrote its Receipt into the MAIN checkout's
   * `issues/completions/` instead of its worktree's copy (cwd confusion),
   * dirtying `main` and blocking every merge. The skill's relative-path wording
   * stays the general contract; the per-Run absolute path is Mission Control
   * being defensive.
   */
  cwd: string;
  /**
   * Present exactly when this is a workbench Project's Run: the explicit
   * workbench paths the prompt must carry (ADR-0015's discovery order — the
   * spawning prompt's paths win outright). Absent for a legacy Project, whose
   * prompt is byte-identical to what it always was.
   */
  workbench?: RunWorkbenchPaths | null;
  /**
   * The workbench project's `memory/CORE.md` content (issue 73, ADR-0015),
   * read at the spawn edge, or null/absent when the project has none. Injected
   * ONLY into a workbench Run's prompt, capped and labeled by the pure
   * `shared/workbench-memory` module; a legacy Run's prompt never carries it.
   */
  memoryCore?: string | null;
}

/**
 * The Run's absolute Receipt path: the workbench completions root when the
 * Run belongs to a workbench Project (ONE Receipt root, never per-worktree —
 * issue 72), else `<cwd>/issues/completions/<NN-slug>.md` as always.
 */
export function receiptPathFor(
  issue: Pick<RunIssueRef, 'fileName' | 'cwd' | 'workbench'>,
): string {
  const stem = issue.fileName.replace(/\.md$/, '');
  const workbench = issue.workbench ?? null;
  if (workbench !== null) return `${workbench.completionsRoot}/${stem}.md`;
  return `${issue.cwd}/issues/completions/${stem}.md`;
}

/**
 * The initial prompt handed to `claude` so it works EXACTLY this one issue via
 * the afk-issue-runner skill (non-drain, single-issue mode). Pure and
 * deterministic so it can be asserted in tests.
 *
 * A workbench Run's prompt (issue 72) carries the EXPLICIT workbench paths per
 * ADR-0015's discovery order: the issues root (where to find and flip the
 * issue file and read CONFIG.md beside it) and the absolute Receipt path in
 * the workbench completions root. The Worker's cwd is the issue's target code
 * repo, which holds no pipeline artifacts of its own.
 */
export function buildRunPrompt(issue: RunIssueRef): string {
  const num = String(issue.id).padStart(2, '0');
  const workbench = issue.workbench ?? null;

  if (workbench !== null) {
    const projectRoot = workbench.issuesRoot.includes('/')
      ? workbench.issuesRoot.slice(0, workbench.issuesRoot.lastIndexOf('/'))
      : workbench.issuesRoot;
    return (
      `Use the afk-issue-runner skill in normal single-issue (non-drain) mode to ` +
      `work EXACTLY issue ${num} (${issue.fileName}). ` +
      `Read ~/.claude/skills/afk-issue-runner/SKILL.md. This project's pipeline ` +
      `artifacts live in its Workbench, not in this repo (ADR-0015): its issue ` +
      `files are in ${workbench.issuesRoot} and its project config is ` +
      `${projectRoot}/CONFIG.md — use these explicit paths; do not look for an ` +
      `issues/ directory in your cwd. Claim issue ${num} by flipping ` +
      `${workbench.issuesRoot}/${issue.fileName} to wip, do the code work in ` +
      `your cwd (${issue.cwd} — this issue's target repo), complete it per its ` +
      `acceptance criteria, and stop after that one issue. Do not pick any ` +
      `other issue. Your Receipt path for this Run is exactly ` +
      `${receiptPathFor(issue)} (the workbench completions root — an absolute ` +
      `path so a cwd mixup cannot misplace it); write your Receipt to that ` +
      `path and nowhere else.` +
      // Memory injection (issue 73): the project's curated CORE.md rides the
      // prompt as a clearly-labeled context section, capped at the ADR-0015
      // ~1.5k-token budget. Absent/empty CORE appends '' — byte-identical.
      coreMemorySection(issue.memoryCore)
    );
  }

  return (
    `Use the afk-issue-runner skill in normal single-issue (non-drain) mode to ` +
    `work EXACTLY issue ${num} (${issue.fileName}). ` +
    `Read ~/.claude/skills/afk-issue-runner/SKILL.md and issues/CONFIG.md, ` +
    `claim issue ${num} by flipping it to wip, complete it per its acceptance ` +
    `criteria, and stop after that one issue. Do not pick any other issue. ` +
    `Your Receipt path for this Run is exactly ${receiptPathFor(issue)} ` +
    `(this checkout's own issues/completions/ — an absolute path so a cwd mixup ` +
    `cannot misplace it); write your Receipt to that path and nowhere else.`
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
 *
 * A drain caller passes `options.model` (issue 154) and `options.effort` (issue
 * 155) to spawn the Worker on a declared, cheap-by-default tier and effort;
 * `--model <id>` and `--effort <level>` are injected ahead of the prompt. A
 * manual/interactive Run passes neither, so its command is byte-identical to
 * before — it inherits the interactive default model and effort.
 */
export function resolveRunCommand(
  env: Record<string, string | undefined>,
  issue: RunIssueRef,
  options: RunCommandOptions = {},
): ShellCommand {
  const prompt = buildRunPrompt(issue);

  const override = env.MC_RUN_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: [...parts.slice(1), prompt] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  const modelFlag = options.model ? ['--model', modelIdForTier(options.model)] : [];
  const effortFlag = options.effort ? ['--effort', options.effort] : [];
  return { file: bin, args: [...modelFlag, ...effortFlag, prompt] };
}

/**
 * The flags that turn a `claude` invocation headless (issue 139, ADR-0001
 * amendment): print mode + a newline-delimited JSON event stream. `--verbose`
 * is REQUIRED for `stream-json` in print mode (the CLI errors without it); it is
 * what makes the full event stream — including the leading `system`/`init` event
 * that declares the `session_id` — land on stdout. Ordered before the positional
 * prompt so the prompt stays the final argument, exactly as the interactive Run
 * command places it.
 */
export const HEADLESS_CLAUDE_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose'] as const;

/**
 * Resolve the executable + args for a HEADLESS drain Run (issue 139): the same
 * Worker seed (`buildRunPrompt`) and the same override precedence as an
 * interactive Run, but spawned as a plain child process emitting stream-json
 * rather than an interactive pty.
 *
 * Precedence, mirroring `resolveRunCommand`:
 *   1. `MC_RUN_CMD` — whole-command override (the e2e command-override seam, and
 *      a manual escape hatch). The scoped prompt is appended as the final arg.
 *      The headless flags are NOT injected: an override defines its own argv (a
 *      scripted fake Worker that speaks stream-json itself), so forcing `-p` onto
 *      it would be wrong. This is the seam the fake Worker rides — byte-identical
 *      to `resolveRunCommand`'s override branch on purpose.
 *   2. `CLAUDE_BIN` (or bare `claude`) with `HEADLESS_CLAUDE_FLAGS`, then (for a
 *      drain Worker) `--model <id>` and `--effort <level>`, then the scoped
 *      prompt as the positional initial-prompt argument. The prompt stays last;
 *      `--model`/`--effort` sit ahead of it exactly as the interactive Run
 *      command places them (issues 154/155).
 */
export function resolveHeadlessRunCommand(
  env: Record<string, string | undefined>,
  issue: RunIssueRef,
  options: RunCommandOptions = {},
): ShellCommand {
  const prompt = buildRunPrompt(issue);

  const override = env.MC_RUN_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: [...parts.slice(1), prompt] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  const modelFlag = options.model ? ['--model', modelIdForTier(options.model)] : [];
  const effortFlag = options.effort ? ['--effort', options.effort] : [];
  return { file: bin, args: [...HEADLESS_CLAUDE_FLAGS, ...modelFlag, ...effortFlag, prompt] };
}

/**
 * The flag that re-attaches an interactive `claude` to an existing session by
 * its id (issue 144): `claude --resume <session-id>`. A take-over kills the
 * headless child and spawns THIS in the same working directory, so the operator
 * grabs the wheel of the very session the drain was running — same conversation,
 * same context — rather than starting fresh. Post-mortem resume of a finished
 * Run uses the identical command; the only difference is there is no live child
 * to kill first.
 */
export const RESUME_CLAUDE_FLAG = '--resume' as const;

/**
 * Resolve the executable + args for a TAKE-OVER / post-mortem RESUME Pane (issue
 * 144): an interactive `claude --resume <claudeSessionId>` re-attaching to the
 * session a headless Run captured. NO scoped prompt is appended — the session
 * already holds its full context and the operator drives it by hand from here
 * (the Feed→Pane switch is exactly "stop watching, start talking").
 *
 * Same override precedence as every other Run/Talk command, so the e2e's
 * command-override seam (`MC_RUN_CMD`) and a manual `CLAUDE_BIN` both work:
 *   1. `MC_RUN_CMD` — whole-command override; `--resume <id>` is appended after
 *      the override's own argv (mirroring how the scoped prompt is appended for
 *      a fresh Run), so a scripted fake Worker still receives the session id.
 *   2. `CLAUDE_BIN` (or bare `claude`) with `--resume <id>` as its arguments.
 */
export function resolveResumeRunCommand(
  env: Record<string, string | undefined>,
  claudeSessionId: string,
): ShellCommand {
  const override = env.MC_RUN_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: [...parts.slice(1), RESUME_CLAUDE_FLAG, claudeSessionId] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  return { file: bin, args: [RESUME_CLAUDE_FLAG, claudeSessionId] };
}

/**
 * The Workbench artifact destination a PLANNING talk session carries (issue
 * 101, ADR-0015): where `/to-prd`, `/to-issues`, and `/grill-with-docs` must
 * write, so they don't fall back to a file backlog in the session's cwd (a
 * code/workspace directory that holds no pipeline artifacts). Absent for a
 * plain "Just talk" session, which stays untracked.
 */
export interface TalkWorkbenchDest {
  /** Where issue files go: `~/Workbench/<project>/issues`. */
  issuesRoot: string;
  /** Where the PRD + HUMAN-SETUP go: `~/Workbench/<project>`. */
  projectRoot: string;
}

/**
 * The destination block a planning session's prompt carries: it names the
 * Workbench as the issue tracker so the planning skills write there, and
 * explicitly forbids the cwd fallback. Empty string when there is no
 * destination (a plain talk session) — the prompt is then byte-identical to
 * what it was before issue 101.
 */
function planningDestinationSection(dest: TalkWorkbenchDest | null): string {
  if (dest === null) return '';
  return (
    ` This project's pipeline artifacts live in its Workbench, not in this ` +
    `working directory (ADR-0015). When you run /to-prd, /to-issues, or ` +
    `/grill-with-docs, treat this project's issue tracker as a file backlog at ` +
    `${dest.issuesRoot}: write issue files (NN-slug.md) there, the PRD to ` +
    `${dest.projectRoot}/, and any HUMAN-SETUP.md to ` +
    `${dest.projectRoot}/HUMAN-SETUP.md. Do NOT create an issues/ directory or ` +
    `a PRD in the current working directory.`
  );
}

/**
 * The initial prompt for a talk Pane (issue 81, ADR-0016): a warm `claude`
 * session carrying the workbench project's CORE.md as labeled background
 * context (issue 73's cap and label).
 *
 * A PLANNING session (issue 101) additionally carries an explicit Workbench
 * artifact destination, so `/to-prd` / `/to-issues` write to the Workbench
 * rather than defaulting to a file backlog in the cwd. A plain "Just talk"
 * session passes no destination — no issue is claimed, nothing is tracked —
 * and with no memory either it returns null: the session spawns with NO initial
 * prompt at all, a genuinely bare warm start.
 */
export function buildTalkPrompt(
  memoryCore: string | null | undefined,
  dest?: TalkWorkbenchDest | null,
): string | null {
  const section = coreMemorySection(memoryCore ?? null);
  const destination = planningDestinationSection(dest ?? null);
  if (section === '' && destination === '') return null;
  const intro =
    destination !== ''
      ? `This is a planning session for a Workbench project. The user will ` +
        `drive the conversation; wait for their first message.`
      : `This is a free-form working session — no issue is claimed and nothing ` +
        `is tracked. The user will drive the conversation; wait for their first ` +
        `message.`;
  return intro + destination + section;
}

/**
 * Resolve the executable + args for a talk Pane: same precedence as a Run
 * (`MC_RUN_CMD` override → `CLAUDE_BIN`/`claude`). The prompt is the labeled
 * memory context plus, for a planning session, the Workbench destination — and
 * absent entirely when a plain talk session has no memory.
 */
export function resolveTalkCommand(
  env: Record<string, string | undefined>,
  memoryCore: string | null | undefined,
  dest?: TalkWorkbenchDest | null,
): ShellCommand {
  const prompt = buildTalkPrompt(memoryCore, dest ?? null);

  const override = env.MC_RUN_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { file: parts[0], args: prompt === null ? parts.slice(1) : [...parts.slice(1), prompt] };
  }

  const bin = env.CLAUDE_BIN?.trim() || 'claude';
  return { file: bin, args: prompt === null ? [] : [prompt] };
}
