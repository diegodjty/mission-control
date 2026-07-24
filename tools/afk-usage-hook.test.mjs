/**
 * Unit tests for the pure logic of the AFK usage hook (issue 210). The stdin /
 * filesystem shell in main() is untested I/O; everything that turns a transcript
 * into a Receipt's usage frontmatter is covered here against a fixture transcript
 * in the exact shape Claude Code writes to ~/.claude/projects/<proj>/<id>.jsonl.
 */
import { describe, it, expect } from 'vitest';
import {
  tierFor,
  computeUsageFromTranscript,
  findReceiptPath,
  upsertUsageFrontmatter,
  transcriptPathFromPayload,
} from './afk-usage-hook.mjs';

// One assistant turn on haiku, escalating to opus, then the Receipt write on opus.
const TRANSCRIPT = [
  { type: 'user', timestamp: '2026-07-23T19:38:40.000Z', message: { role: 'user', content: 'go' } },
  {
    type: 'assistant',
    timestamp: '2026-07-23T19:39:00.000Z',
    message: {
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 },
      content: [{ type: 'text', text: 'thinking...' }],
    },
  },
  {
    type: 'assistant',
    timestamp: '2026-07-23T19:50:00.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 },
      content: [
        { type: 'text', text: 'writing the receipt' },
        { type: 'tool_use', name: 'Write', input: { file_path: '/Users/dev/Workbench/mission-control/completions/210-cost-telemetry.md', content: '...' } },
      ],
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

describe('tierFor', () => {
  it('maps model ids to tiers by family', () => {
    expect(tierFor('claude-opus-4-8')).toBe('opus');
    expect(tierFor('claude-sonnet-5')).toBe('sonnet');
    expect(tierFor('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(tierFor('claude-fable-5')).toBe('fable');
  });
  it('returns null for an unknown / non-string model', () => {
    expect(tierFor('gpt-5')).toBeNull();
    expect(tierFor(undefined)).toBeNull();
  });
});

describe('computeUsageFromTranscript', () => {
  const usage = computeUsageFromTranscript(TRANSCRIPT);

  it('sums tokens across all assistant messages', () => {
    expect(usage.inputTokens).toBe(3000);
    expect(usage.outputTokens).toBe(600);
    expect(usage.cacheReadTokens).toBe(15000);
    expect(usage.cacheCreationTokens).toBe(1800);
  });

  it('prices each message by its own model and sums (haiku turn + opus turn)', () => {
    // haiku: (1000*1 + 200*5 + 5000*0.1 + 800*1.25)/1e6 = 3500/1e6 = 0.0035
    // opus:  (2000*5 + 400*25 + 10000*0.5 + 1000*6.25)/1e6 = 31250/1e6 = 0.03125
    expect(usage.costUsd).toBeCloseTo(0.0348, 4);
  });

  it('measures duration from first→last timestamp', () => {
    // 19:38:40 → 19:50:00 = 11m20s = 680000ms
    expect(usage.durationMs).toBe(680000);
  });

  it('reports the highest tier seen (escalated to opus)', () => {
    expect(usage.tier).toBe('opus');
  });

  it('returns null when the transcript has no assistant usage', () => {
    expect(computeUsageFromTranscript('{"type":"user","message":{"content":"hi"}}')).toBeNull();
    expect(computeUsageFromTranscript('')).toBeNull();
  });

  it('tolerates a broken JSONL line without throwing', () => {
    const withJunk = `${TRANSCRIPT}\n{ not json`;
    expect(computeUsageFromTranscript(withJunk).inputTokens).toBe(3000);
  });
});

describe('findReceiptPath', () => {
  it('returns the completions/NN-slug.md path this transcript wrote', () => {
    expect(findReceiptPath(TRANSCRIPT)).toBe('/Users/dev/Workbench/mission-control/completions/210-cost-telemetry.md');
  });

  it('returns null when the transcript wrote no Receipt (dispatcher / no-op case)', () => {
    const noReceipt = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/index.ts' } }] },
    });
    expect(findReceiptPath(noReceipt)).toBeNull();
  });
});

describe('upsertUsageFrontmatter', () => {
  const RECEIPT = `---\nissue: 210\nslug: cost-telemetry\noutcome: completed\nfinished: 2026-07-23T19:50:00Z\n---\n\n## Completed issue 210 — cost-telemetry\n\n**What changed** — usage now rides the Receipt.\n`;
  const usage = { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 15000, cacheCreationTokens: 1800, durationMs: 680000, costUsd: 0.0348, tier: 'opus' };

  it('inserts usage_* keys inside the fence and leaves the body untouched', () => {
    const out = upsertUsageFrontmatter(RECEIPT, usage);
    expect(out).toMatch(/usage_input_tokens: 3000/);
    expect(out).toMatch(/usage_cost_usd: 0.0348/);
    expect(out).toMatch(/usage_tier: opus/);
    expect(out).toContain('## Completed issue 210 — cost-telemetry');
    expect(out).toContain('**What changed** — usage now rides the Receipt.');
  });

  it('is idempotent — re-running replaces the keys instead of duplicating them', () => {
    const once = upsertUsageFrontmatter(RECEIPT, usage);
    const twice = upsertUsageFrontmatter(once, usage);
    expect(twice).toBe(once);
    expect(twice.match(/usage_input_tokens/g)).toHaveLength(1);
  });

  it('leaves a fence-less file untouched (never fabricates frontmatter)', () => {
    const noFence = '## Completed issue 210\n\nbody only';
    expect(upsertUsageFrontmatter(noFence, usage)).toBe(noFence);
  });
});

describe('transcriptPathFromPayload', () => {
  it('prefers the subagent transcript on SubagentStop', () => {
    expect(
      transcriptPathFromPayload({ transcript_path: '/parent.jsonl', agent_transcript_path: '/child.jsonl' }),
    ).toBe('/child.jsonl');
  });
  it('falls back to transcript_path on Stop / SessionEnd', () => {
    expect(transcriptPathFromPayload({ transcript_path: '/session.jsonl' })).toBe('/session.jsonl');
  });
  it('returns null when neither is present', () => {
    expect(transcriptPathFromPayload({})).toBeNull();
  });
});
