import { describe, it, expect } from 'vitest';
import { buildRunPrompt, receiptPathFor, resolveRunCommand } from './resolve-run-command';
import {
  CORE_MEMORY_CHAR_CAP,
  CORE_MEMORY_LABEL,
  CORE_TRUNCATION_MARKER,
} from '../shared/workbench-memory';

const ISSUE = {
  id: 3,
  fileName: '03-run-issue-in-pane.md',
  title: '03 — Run one issue in a Pane',
  cwd: '/repos/project',
};

describe('buildRunPrompt', () => {
  it('scopes the afk-issue-runner to exactly the given issue, zero-padded', () => {
    const prompt = buildRunPrompt(ISSUE);
    expect(prompt).toContain('issue 03');
    expect(prompt).toContain('03-run-issue-in-pane.md');
    expect(prompt).toContain('afk-issue-runner');
    expect(prompt).toContain('single-issue');
  });

  it('spells out the ABSOLUTE per-Run Receipt path from the resolved cwd (issue 62)', () => {
    // Solo mode: the resolved cwd is the Project repo.
    const solo = buildRunPrompt(ISSUE);
    expect(solo).toContain('/repos/project/issues/completions/03-run-issue-in-pane.md');

    // Parallel mode: the resolved cwd is the Run's OWN worktree — the prompt
    // must point the Receipt write there, not at the main checkout, so a cwd
    // mixup can't dirty `main` and block every later merge.
    const parallel = buildRunPrompt({
      ...ISSUE,
      cwd: '/repos/.afk-worktrees/03-run-issue-in-pane',
    });
    expect(parallel).toContain(
      '/repos/.afk-worktrees/03-run-issue-in-pane/issues/completions/03-run-issue-in-pane.md',
    );
    expect(parallel).not.toContain('/repos/project/issues/completions');
  });
});

describe('receiptPathFor', () => {
  it('derives <cwd>/issues/completions/<NN-slug>.md from the issue file name', () => {
    expect(receiptPathFor(ISSUE)).toBe(
      '/repos/project/issues/completions/03-run-issue-in-pane.md',
    );
  });
});

describe('resolveRunCommand', () => {
  it('spawns bare `claude` with the scoped prompt as its positional argument', () => {
    const cmd = resolveRunCommand({}, ISSUE);
    expect(cmd.file).toBe('claude');
    expect(cmd.args).toHaveLength(1);
    expect(cmd.args[0]).toContain('issue 03');
    // The launch carries the absolute per-Run Receipt path (issue 62).
    expect(cmd.args[0]).toContain('/repos/project/issues/completions/03-run-issue-in-pane.md');
  });

  it('honours CLAUDE_BIN for the executable path', () => {
    const cmd = resolveRunCommand({ CLAUDE_BIN: '/opt/homebrew/bin/claude' }, ISSUE);
    expect(cmd.file).toBe('/opt/homebrew/bin/claude');
    expect(cmd.args[0]).toContain('issue 03');
  });

  it('honours MC_RUN_CMD as a whole-command override and still appends the scoped prompt', () => {
    const cmd = resolveRunCommand({ MC_RUN_CMD: 'node ./fake-session.js --flag' }, ISSUE);
    expect(cmd.file).toBe('node');
    expect(cmd.args.slice(0, 2)).toEqual(['./fake-session.js', '--flag']);
    expect(cmd.args[cmd.args.length - 1]).toContain('issue 03');
    expect(cmd.args[cmd.args.length - 1]).toContain(
      '/repos/project/issues/completions/03-run-issue-in-pane.md',
    );
  });

  it('ignores a blank CLAUDE_BIN and falls back to `claude`', () => {
    const cmd = resolveRunCommand({ CLAUDE_BIN: '   ' }, ISSUE);
    expect(cmd.file).toBe('claude');
  });
});

describe('workbench Runs (issue 72, ADR-0015)', () => {
  const WB_ISSUE = {
    ...ISSUE,
    cwd: '/repos/api',
    workbench: {
      issuesRoot: '/Users/dev/Workbench/billing/issues',
      completionsRoot: '/Users/dev/Workbench/billing/completions',
    },
  };

  it('receiptPathFor points at the workbench completions root — never the cwd', () => {
    expect(receiptPathFor(WB_ISSUE)).toBe(
      '/Users/dev/Workbench/billing/completions/03-run-issue-in-pane.md',
    );
  });

  it('the prompt carries the explicit workbench paths (discovery order step 1)', () => {
    const prompt = buildRunPrompt(WB_ISSUE);
    expect(prompt).toContain('issue 03');
    expect(prompt).toContain('/Users/dev/Workbench/billing/issues');
    expect(prompt).toContain('/Users/dev/Workbench/billing/CONFIG.md');
    expect(prompt).toContain(
      '/Users/dev/Workbench/billing/completions/03-run-issue-in-pane.md',
    );
    // The Worker's cwd is the issue's target repo, named explicitly.
    expect(prompt).toContain('/repos/api');
    // And it must NOT point the Receipt at the cwd's issues/completions.
    expect(prompt).not.toContain('/repos/api/issues/completions');
  });

  it('a legacy Run (no workbench field) keeps the exact legacy prompt shape', () => {
    const prompt = buildRunPrompt(ISSUE);
    expect(prompt).toContain('issues/CONFIG.md');
    expect(prompt).toContain('/repos/project/issues/completions/03-run-issue-in-pane.md');
    expect(prompt).not.toContain('Workbench');
  });
});

describe('memory injection (issue 73, ADR-0015)', () => {
  const WB_ISSUE = {
    ...ISSUE,
    cwd: '/repos/api',
    workbench: {
      issuesRoot: '/Users/dev/Workbench/billing/issues',
      completionsRoot: '/Users/dev/Workbench/billing/completions',
    },
  };

  it('a workbench Run prompt carries CORE.md content, labeled', () => {
    const prompt = buildRunPrompt({
      ...WB_ISSUE,
      memoryCore: '- The billing repo deploys via Fastlane.',
    });
    expect(prompt).toContain(CORE_MEMORY_LABEL);
    expect(prompt).toContain('- The billing repo deploys via Fastlane.');
  });

  it('an oversized CORE is capped with the truncation marker — never unbounded', () => {
    const prompt = buildRunPrompt({
      ...WB_ISSUE,
      memoryCore: 'x'.repeat(CORE_MEMORY_CHAR_CAP * 4),
    });
    expect(prompt).toContain(CORE_TRUNCATION_MARKER);
    expect(prompt.length).toBeLessThan(CORE_MEMORY_CHAR_CAP * 2);
  });

  it('an absent/empty CORE injects nothing — the prompt is byte-identical', () => {
    const bare = buildRunPrompt(WB_ISSUE);
    expect(buildRunPrompt({ ...WB_ISSUE, memoryCore: null })).toBe(bare);
    expect(buildRunPrompt({ ...WB_ISSUE, memoryCore: '' })).toBe(bare);
    expect(buildRunPrompt({ ...WB_ISSUE, memoryCore: '  \n ' })).toBe(bare);
    expect(bare).not.toContain(CORE_MEMORY_LABEL);
  });

  it('a legacy Run never carries memory, even if a caller passes it', () => {
    const prompt = buildRunPrompt({ ...ISSUE, memoryCore: 'should not appear' });
    expect(prompt).toBe(buildRunPrompt(ISSUE));
    expect(prompt).not.toContain('should not appear');
  });
});
