import { describe, it, expect } from 'vitest';
import {
  buildDispatcherPrompt,
  resolveDispatcherCommand,
} from './dispatcher-session';
import {
  CORE_MEMORY_CHAR_CAP,
  CORE_MEMORY_LABEL,
  CORE_TRUNCATION_MARKER,
} from '../shared/workbench-memory';

const REF = { projectPath: '/repo', activePrd: 'docs/PRD-dispatcher.md' };

describe('buildDispatcherPrompt', () => {
  it('frames the session as the conversational orchestrator over summaries', () => {
    const prompt = buildDispatcherPrompt(REF);
    expect(prompt).toContain('Dispatcher');
    expect(prompt).toContain('Completion block');
    // Reasons over summaries, never raw Pane scroll (ADR-0001/0009).
    expect(prompt.toLowerCase()).toContain('never');
    expect(prompt.toLowerCase()).toContain('raw');
    // Scheduling is delegated, not the LLM's job (ADR-0008).
    expect(prompt).toContain('Run Coordinator');
    // Names the active PRD when set.
    expect(prompt).toContain('docs/PRD-dispatcher.md');
  });

  it('answers "what\'s left?" from the blocks, and asks before scope changes', () => {
    const prompt = buildDispatcherPrompt(REF);
    expect(prompt).toContain("what's left?");
    expect(prompt.toLowerCase()).toContain('approval');
  });

  it('directs cross-Run synthesis: doc-drift amendment, patterns, consolidation (issue 38)', () => {
    const prompt = buildDispatcherPrompt(REF);
    const lower = prompt.toLowerCase();
    // (a) doc-drift → propose an approval-gated plan amendment, never self-edit.
    expect(lower).toContain('doc-drift');
    expect(lower).toContain('propose');
    expect(lower).toContain('amend');
    // (b) cross-Run patterns — same seam / recurring finding class.
    expect(lower).toContain('seam');
    expect(lower).toContain('recurring');
    // (c) consolidate related findings into one summary.
    expect(lower).toContain('consolidate');
  });

  it('omits the PRD clause when none is set', () => {
    const prompt = buildDispatcherPrompt({ projectPath: '/repo', activePrd: null });
    expect(prompt).not.toContain('active PRD is');
  });

  it('a workbench seed carries CORE.md content, labeled and capped (issue 73)', () => {
    const prompt = buildDispatcherPrompt({
      ...REF,
      memoryCore: '- Ship behind the feature flag.',
    });
    expect(prompt).toContain(CORE_MEMORY_LABEL);
    expect(prompt).toContain('- Ship behind the feature flag.');

    const capped = buildDispatcherPrompt({
      ...REF,
      memoryCore: 'y'.repeat(CORE_MEMORY_CHAR_CAP * 4),
    });
    expect(capped).toContain(CORE_TRUNCATION_MARKER);
    expect(capped.length).toBeLessThan(CORE_MEMORY_CHAR_CAP * 2);
  });

  it('an absent/empty CORE injects nothing — the seed is byte-identical (issue 73)', () => {
    const bare = buildDispatcherPrompt(REF);
    expect(buildDispatcherPrompt({ ...REF, memoryCore: null })).toBe(bare);
    expect(buildDispatcherPrompt({ ...REF, memoryCore: '' })).toBe(bare);
    expect(bare).not.toContain(CORE_MEMORY_LABEL);
  });
});

describe('resolveDispatcherCommand', () => {
  it('spawns bare `claude` with the orchestrator prompt as its argument', () => {
    const cmd = resolveDispatcherCommand({}, REF);
    expect(cmd.file).toBe('claude');
    expect(cmd.args).toHaveLength(1);
    expect(cmd.args[0]).toContain('Dispatcher');
  });

  it('honours CLAUDE_BIN for the executable path', () => {
    const cmd = resolveDispatcherCommand({ CLAUDE_BIN: '/opt/homebrew/bin/claude' }, REF);
    expect(cmd.file).toBe('/opt/homebrew/bin/claude');
    expect(cmd.args[0]).toContain('Dispatcher');
  });

  it('honours MC_DISPATCHER_CMD as a whole-command override, appending the prompt', () => {
    const cmd = resolveDispatcherCommand(
      { MC_DISPATCHER_CMD: 'node ./fake-dispatcher.js --flag' },
      REF,
    );
    expect(cmd.file).toBe('node');
    expect(cmd.args.slice(0, 2)).toEqual(['./fake-dispatcher.js', '--flag']);
    expect(cmd.args[cmd.args.length - 1]).toContain('Dispatcher');
  });

  it('ignores a blank CLAUDE_BIN and falls back to `claude`', () => {
    const cmd = resolveDispatcherCommand({ CLAUDE_BIN: '   ' }, REF);
    expect(cmd.file).toBe('claude');
  });
});
