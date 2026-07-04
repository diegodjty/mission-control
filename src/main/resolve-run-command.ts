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
      `path and nowhere else.`
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
