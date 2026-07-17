import { describe, it, expect } from 'vitest';
import {
  buildRunPrompt,
  buildTalkPrompt,
  receiptPathFor,
  resolveRunCommand,
  resolveHeadlessRunCommand,
  resolveResumeRunCommand,
  resolveTalkCommand,
  HEADLESS_CLAUDE_FLAGS,
  RESUME_CLAUDE_FLAG,
} from './resolve-run-command';
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

describe('resolveHeadlessRunCommand (issue 139, ADR-0001 amendment)', () => {
  it('spawns `claude -p --output-format stream-json --verbose` with the SAME Worker seed', () => {
    const cmd = resolveHeadlessRunCommand({}, ISSUE);
    expect(cmd.file).toBe('claude');
    // The headless flags precede the positional prompt (which stays last).
    expect(cmd.args.slice(0, HEADLESS_CLAUDE_FLAGS.length)).toEqual([...HEADLESS_CLAUDE_FLAGS]);
    expect(cmd.args).toContain('-p');
    expect(cmd.args).toContain('--output-format');
    expect(cmd.args).toContain('stream-json');
    // stream-json in print mode REQUIRES --verbose.
    expect(cmd.args).toContain('--verbose');
    const last = cmd.args[cmd.args.length - 1];
    expect(last).toContain('issue 03');
    // The seed is byte-identical to the interactive Run's — same prompt builder.
    expect(last).toBe(resolveRunCommand({}, ISSUE).args[0]);
    expect(last).toContain('/repos/project/issues/completions/03-run-issue-in-pane.md');
  });

  it('honours CLAUDE_BIN for the executable path', () => {
    const cmd = resolveHeadlessRunCommand({ CLAUDE_BIN: '/opt/homebrew/bin/claude' }, ISSUE);
    expect(cmd.file).toBe('/opt/homebrew/bin/claude');
    expect(cmd.args).toContain('stream-json');
    expect(cmd.args[cmd.args.length - 1]).toContain('issue 03');
  });

  it('honours MC_RUN_CMD as a whole-command override and does NOT inject the headless flags', () => {
    // The command-override seam the e2e fake Worker rides: it speaks stream-json
    // itself, so `-p`/`--output-format` must not be forced onto it. Byte-identical
    // to resolveRunCommand's override branch — only the scoped prompt is appended.
    const cmd = resolveHeadlessRunCommand({ MC_RUN_CMD: 'node ./fake-headless.mjs --flag' }, ISSUE);
    expect(cmd.file).toBe('node');
    expect(cmd.args.slice(0, 2)).toEqual(['./fake-headless.mjs', '--flag']);
    expect(cmd.args).not.toContain('--output-format');
    expect(cmd.args[cmd.args.length - 1]).toContain('issue 03');
    expect(cmd).toEqual(resolveRunCommand({ MC_RUN_CMD: 'node ./fake-headless.mjs --flag' }, ISSUE));
  });

  it('carries the workbench paths + CORE.md exactly like an interactive Run', () => {
    const wbIssue = {
      ...ISSUE,
      cwd: '/repos/api',
      workbench: {
        issuesRoot: '/Users/dev/Workbench/billing/issues',
        completionsRoot: '/Users/dev/Workbench/billing/completions',
      },
      memoryCore: '- The billing repo deploys via Fastlane.',
    };
    const last = resolveHeadlessRunCommand({}, wbIssue).args.slice(-1)[0];
    expect(last).toBe(buildRunPrompt(wbIssue));
    expect(last).toContain('/Users/dev/Workbench/billing/issues');
    expect(last).toContain('- The billing repo deploys via Fastlane.');
  });
});

describe('resolveResumeRunCommand (issue 144 — take over / post-mortem resume)', () => {
  it('spawns interactive `claude --resume <session-id>` with NO scoped prompt', () => {
    const cmd = resolveResumeRunCommand({}, 'sess-abc-123');
    expect(cmd.file).toBe('claude');
    expect(cmd.args).toEqual([RESUME_CLAUDE_FLAG, 'sess-abc-123']);
    // A resume re-attaches to an existing session, so — unlike a fresh Run — it
    // carries no initial prompt: the session already holds its full context.
    expect(cmd.args).not.toContain('-p');
    expect(cmd.args.some((a) => a.includes('afk-issue-runner'))).toBe(false);
  });

  it('honours CLAUDE_BIN for the executable path', () => {
    const cmd = resolveResumeRunCommand({ CLAUDE_BIN: '/opt/homebrew/bin/claude' }, 'sess-x');
    expect(cmd.file).toBe('/opt/homebrew/bin/claude');
    expect(cmd.args).toEqual([RESUME_CLAUDE_FLAG, 'sess-x']);
  });

  it('ignores a blank CLAUDE_BIN and falls back to `claude`', () => {
    const cmd = resolveResumeRunCommand({ CLAUDE_BIN: '   ' }, 'sess-x');
    expect(cmd.file).toBe('claude');
  });

  it('honours MC_RUN_CMD as a whole-command override, appending --resume <id> last', () => {
    // The same command-override seam the e2e take-over test rides: the fake
    // Worker still receives the resumed session id as its trailing argv.
    const cmd = resolveResumeRunCommand({ MC_RUN_CMD: 'node ./fake.mjs --flag' }, 'sess-e2e');
    expect(cmd.file).toBe('node');
    expect(cmd.args).toEqual(['./fake.mjs', '--flag', RESUME_CLAUDE_FLAG, 'sess-e2e']);
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

describe('buildTalkPrompt / resolveTalkCommand (issue 81)', () => {
  it('no memory ⇒ no initial prompt at all — a genuinely bare warm session', () => {
    expect(buildTalkPrompt(null)).toBeNull();
    expect(buildTalkPrompt('')).toBeNull();
    expect(buildTalkPrompt('  \n ')).toBeNull();
    const cmd = resolveTalkCommand({}, null);
    expect(cmd.file).toBe('claude');
    expect(cmd.args).toEqual([]);
  });

  it('memory present ⇒ the labeled, capped CORE section rides the initial prompt', () => {
    const prompt = buildTalkPrompt('- Stack: Electron + React');
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(CORE_MEMORY_LABEL);
    expect(prompt).toContain('- Stack: Electron + React');
    expect(prompt).toContain('no issue is claimed');
    const cmd = resolveTalkCommand({ CLAUDE_BIN: '/opt/claude' }, '- Stack: Electron + React');
    expect(cmd.file).toBe('/opt/claude');
    expect(cmd.args).toEqual([prompt]);
  });

  it('oversized memory is capped with the explicit truncation marker', () => {
    const prompt = buildTalkPrompt('x'.repeat(CORE_MEMORY_CHAR_CAP * 4));
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(CORE_TRUNCATION_MARKER);
    expect(prompt!.length).toBeLessThan(CORE_MEMORY_CHAR_CAP * 2);
  });

  it('MC_RUN_CMD override keeps working, with and without a memory prompt', () => {
    const bare = resolveTalkCommand({ MC_RUN_CMD: 'node fake.js --talk' }, null);
    expect(bare).toEqual({ file: 'node', args: ['fake.js', '--talk'] });
    const warm = resolveTalkCommand({ MC_RUN_CMD: 'node fake.js --talk' }, 'facts');
    expect(warm.file).toBe('node');
    expect(warm.args.slice(0, 2)).toEqual(['fake.js', '--talk']);
    expect(warm.args[2]).toContain(CORE_MEMORY_LABEL);
  });

  it('a plain talk prompt is byte-identical whether dest is omitted or explicitly null', () => {
    expect(buildTalkPrompt('- Stack: Electron', null)).toBe(buildTalkPrompt('- Stack: Electron'));
    expect(buildTalkPrompt(null, null)).toBeNull();
  });
});

describe('planning talk sessions carry the Workbench destination (issue 101)', () => {
  const DEST = {
    issuesRoot: '/Users/me/Workbench/repoless-qa/issues',
    projectRoot: '/Users/me/Workbench/repoless-qa',
  };

  it('names the Workbench issues root, PRD/HUMAN-SETUP location, and forbids the cwd fallback', () => {
    const prompt = buildTalkPrompt(null, DEST);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('/Users/me/Workbench/repoless-qa/issues');
    expect(prompt).toContain('/to-prd');
    expect(prompt).toContain('/to-issues');
    expect(prompt).toContain('/Users/me/Workbench/repoless-qa/HUMAN-SETUP.md');
    expect(prompt).toContain('Do NOT create an issues/ directory');
    // A planning session is not framed as untracked free-form talk.
    expect(prompt).toContain('planning session');
    expect(prompt).not.toContain('nothing is tracked');
  });

  it('carries the destination even when the project has NO memory (repo-less, empty CORE.md)', () => {
    // The exact issue-101 case: without a dest this returns null (bare session);
    // with a dest it must still carry the destination block.
    expect(buildTalkPrompt(null)).toBeNull();
    const prompt = buildTalkPrompt('', DEST);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(DEST.issuesRoot);
  });

  it('combines the destination block with CORE.md when both are present', () => {
    const prompt = buildTalkPrompt('- Stack: Electron + React', DEST);
    expect(prompt).toContain(DEST.issuesRoot);
    expect(prompt).toContain(CORE_MEMORY_LABEL);
    expect(prompt).toContain('- Stack: Electron + React');
  });

  it('resolveTalkCommand passes the destination-bearing prompt as the claude arg', () => {
    const cmd = resolveTalkCommand({ CLAUDE_BIN: '/opt/claude' }, null, DEST);
    expect(cmd.file).toBe('/opt/claude');
    expect(cmd.args).toHaveLength(1);
    expect(cmd.args[0]).toContain(DEST.issuesRoot);
  });
});
