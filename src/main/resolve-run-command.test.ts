import { describe, it, expect } from 'vitest';
import { buildRunPrompt, resolveRunCommand } from './resolve-run-command';

const ISSUE = { id: 3, fileName: '03-run-issue-in-pane.md', title: '03 — Run one issue in a Pane' };

describe('buildRunPrompt', () => {
  it('scopes the afk-issue-runner to exactly the given issue, zero-padded', () => {
    const prompt = buildRunPrompt(ISSUE);
    expect(prompt).toContain('issue 03');
    expect(prompt).toContain('03-run-issue-in-pane.md');
    expect(prompt).toContain('afk-issue-runner');
    expect(prompt).toContain('single-issue');
  });
});

describe('resolveRunCommand', () => {
  it('spawns bare `claude` with the scoped prompt as its positional argument', () => {
    const cmd = resolveRunCommand({}, ISSUE);
    expect(cmd.file).toBe('claude');
    expect(cmd.args).toHaveLength(1);
    expect(cmd.args[0]).toContain('issue 03');
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
  });

  it('ignores a blank CLAUDE_BIN and falls back to `claude`', () => {
    const cmd = resolveRunCommand({ CLAUDE_BIN: '   ' }, ISSUE);
    expect(cmd.file).toBe('claude');
  });
});
