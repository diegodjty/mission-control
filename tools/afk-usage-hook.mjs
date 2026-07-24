#!/usr/bin/env node
/**
 * AFK usage hook (issue 210, ADR-0013 amendment) — the producer-side telemetry
 * bridge for CLI drains.
 *
 * Mission Control's Cost and Receipts tabs read per-issue tokens / duration /
 * cost off each Run-log record's `usage`. That field is stamped by the in-app
 * headless bridge (issue 143) — but a drain run from the CLI (the afk-issue-
 * runner skill in a terminal) is never spawned by MC, so the bridge never
 * fires and every such Receipt lands with `usage: null`. This hook closes that
 * gap WITHOUT asking the model to self-report (models can't count their own
 * tokens): it runs at the drain (sub)agent's exit, reads the session TRANSCRIPT
 * — the deterministic source of truth Claude Code writes to disk — sums the
 * per-message `usage`, prices it from a bundled table, measures wall-clock from
 * the transcript timestamps, and writes `usage_*` keys into the Receipt's YAML
 * frontmatter. `receipt-parser.ts` reads those keys back into `RunUsage`.
 *
 * Registered on BOTH `Stop` (single-issue mode) and `SubagentStop` (drain mode
 * — one subagent = exactly one issue, its own `agent_transcript_path`). The two
 * can't double-count: the hook stamps a Receipt ONLY when the transcript it is
 * reading actually WROTE that Receipt (a `completions/NN-slug.md` tool-use), so
 * the drain dispatcher's own `Stop` (which writes no Receipt) is a clean no-op.
 *
 * Self-contained on purpose: it runs in whatever repo a drain executes in, at
 * drain time, with no dependency on MC's build. The pure functions are exported
 * so the repo can unit-test the token/cost math against a fixture transcript
 * (tools/afk-usage-hook.test.mjs); only the stdin / filesystem shell in main()
 * is untested I/O.
 *
 * Cost is a client-side ESTIMATE (tokens × the table below) — the same thing
 * Claude Code's own `/cost` shows — not a billing-authoritative figure.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Per-model USD rates per 1,000,000 tokens (verified against the claude-api
// skill's model table, 2026-07). Cache follows the documented formula: read =
// 0.1 × input, 5-minute write = 1.25 × input. Sonnet 5 has an introductory
// $2/$10 in/out through 2026-08-31; we use the stable $3/$15 sticker so the
// estimate never depends on a clock (it errs slightly high during the intro
// window — the safe direction for a "what did this cost me" display).
const PRICING = {
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  fable: { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
};

// Cheapest → most expensive; the reported `tier` is the highest one seen in the
// transcript, so an issue that escalated haiku→opus reads as `opus`.
const TIER_LADDER = ['haiku', 'sonnet', 'opus', 'fable'];

/** Map a Claude model id (e.g. `claude-opus-4-8`, `claude-haiku-4-5-20251001`) to a tier, or null. */
export function tierFor(modelId) {
  if (typeof modelId !== 'string') return null;
  const id = modelId.toLowerCase();
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  if (id.includes('fable') || id.includes('mythos')) return 'fable';
  return null;
}

// Unknown models are priced at the opus rate rather than silently costed at $0,
// so a cost is never under-reported to zero by an unrecognized id. Every current
// Claude model matches a family above, so this fallback is a belt, not a path.
function rateFor(modelId) {
  return PRICING[tierFor(modelId) ?? 'opus'];
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Sum a transcript's per-message token usage, price it per message by that
 * message's own model, and measure wall-clock from the first→last timestamp.
 * Returns null when the transcript carries no assistant usage at all (nothing
 * to stamp). `tier` is the highest tier observed.
 */
export function computeUsageFromTranscript(text) {
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
    costUsd = 0,
    sawUsage = false;
  let highestTier = -1;
  let firstTs = null,
    lastTs = null;

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // a partial/broken line never takes down the sum
    }

    const ts = Date.parse(entry?.timestamp ?? '');
    if (Number.isFinite(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    const usage = entry?.message?.usage;
    if (entry?.type !== 'assistant' || usage == null) continue;

    sawUsage = true;
    const model = entry.message.model;
    const rate = rateFor(model);
    const inp = num(usage.input_tokens);
    const out = num(usage.output_tokens);
    const cr = num(usage.cache_read_input_tokens);
    const cc = num(usage.cache_creation_input_tokens);

    inputTokens += inp;
    outputTokens += out;
    cacheReadTokens += cr;
    cacheCreationTokens += cc;
    costUsd += (inp * rate.input + out * rate.output + cr * rate.cacheRead + cc * rate.cacheWrite) / 1_000_000;

    const t = TIER_LADDER.indexOf(tierFor(model));
    if (t > highestTier) highestTier = t;
  }

  if (!sawUsage) return null;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    durationMs: firstTs !== null && lastTs !== null ? lastTs - firstTs : null,
    // Round to the cent's fourth decimal — sub-$0.0001 precision is noise.
    costUsd: Math.round(costUsd * 10000) / 10000,
    tier: highestTier >= 0 ? TIER_LADDER[highestTier] : null,
  };
}

// A Write/Edit/create tool-use whose target is a Receipt: `.../completions/NN-slug.md`.
const RECEIPT_PATH_RE = /[/\\]completions[/\\]\d+-[^/\\]+\.md$/;

/**
 * The absolute path of the Receipt THIS transcript wrote (the disambiguation
 * that keeps the drain dispatcher's Stop a no-op), or null. Scans assistant
 * tool-use blocks for a file-writing tool whose `file_path` is a Receipt; the
 * LAST such write wins (the skill writes the Receipt once, near the end).
 */
export function findReceiptPath(text) {
  let found = null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.includes('completions')) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const p = block?.input?.file_path;
      if (typeof p === 'string' && RECEIPT_PATH_RE.test(p)) found = p;
    }
  }
  return found;
}

const USAGE_LINE_RE = /^usage_[a-z_]+\s*:.*$/;

/**
 * Insert/replace the `usage_*` keys inside a Receipt's YAML frontmatter fence,
 * leaving the body (the producer-owned completion block) byte-for-byte intact.
 * Returns the original text unchanged if there is no leading `---` fence.
 */
export function upsertUsageFrontmatter(fileText, usage) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(fileText);
  if (!m) return fileText; // no frontmatter fence — never fabricate one
  const kept = m[1]
    .split(/\r?\n/)
    .filter((l) => !USAGE_LINE_RE.test(l.trim()));
  const lines = [
    `usage_input_tokens: ${usage.inputTokens}`,
    `usage_output_tokens: ${usage.outputTokens}`,
    `usage_cache_read: ${usage.cacheReadTokens}`,
    `usage_cache_creation: ${usage.cacheCreationTokens}`,
  ];
  if (usage.durationMs !== null) lines.push(`usage_duration_ms: ${usage.durationMs}`);
  if (usage.tier !== null) lines.push(`usage_tier: ${usage.tier}`);
  lines.push(`usage_cost_usd: ${usage.costUsd}`);
  const body = fileText.slice(m[0].length);
  return `---\n${[...kept, ...lines].join('\n')}\n---\n${body}`;
}

/** Which transcript this hook event points at (subagent's own file wins on SubagentStop). */
export function transcriptPathFromPayload(payload) {
  return payload?.agent_transcript_path ?? payload?.transcript_path ?? null;
}

/** Read all of stdin as text (the hook payload). */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  // Never fail the session: any error here is swallowed so a telemetry hiccup
  // can't break a drain. Exit 0 always.
  try {
    const payload = JSON.parse((await readStdin()) || '{}');
    const transcriptPath = transcriptPathFromPayload(payload);
    if (!transcriptPath) return;

    const transcript = await readFile(transcriptPath, 'utf8').catch(() => null);
    if (transcript === null) return;

    // Disambiguation: only stamp a Receipt this transcript actually wrote.
    const receiptPath = findReceiptPath(transcript);
    if (!receiptPath) return;

    const usage = computeUsageFromTranscript(transcript);
    if (!usage) return;

    const receiptText = await readFile(receiptPath, 'utf8').catch(() => null);
    if (receiptText === null) return;

    const patched = upsertUsageFrontmatter(receiptText, usage);
    if (patched === receiptText) return; // no fence / nothing to do

    // Atomic write (temp + rename) so a watcher never reads a half-written file.
    const tmp = `${receiptPath}.usage-${process.pid}.tmp`;
    await writeFile(tmp, patched, 'utf8');
    await rename(tmp, receiptPath);
  } catch {
    // swallow — telemetry must never break a drain
  }
}

// Run only when executed directly (so the test file can import the pure fns).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
