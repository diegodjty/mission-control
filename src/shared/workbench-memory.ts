/**
 * Workbench memory (PURE) — the memory loop's two halves, as decisions
 * (issue 73, ADR-0015).
 *
 * **In:** a workbench Project's curated `memory/CORE.md` is injected into
 * every Worker prompt and Dispatcher seed as a clearly-labeled context
 * section, hard-capped at the ADR's ~1.5k tokens (a poisoned or runaway CORE
 * must never flood a prompt). Missing/empty CORE injects nothing — the prompt
 * stays byte-identical to today's. Legacy Projects never reach this code.
 *
 * **Out:** when a drain ends (any stop reason), one dated journal entry lands
 * in `memory/journal/` — every Run this drain produced with a one-line
 * outcome, doc-drift flags, and notable events (stray-Receipt adoptions,
 * finished-without-receipt) — assembled here from the drain's Run-log records.
 * A second drain the same day gets its own file (no clobber).
 *
 * House PURE contract: no file/network/Electron I/O, any input yields a
 * value, never a throw. The file reads/writes live in
 * `src/main/memory-files.ts`; the wiring in the main process and App.
 */
import type { RunLogRecord } from './ipc-contract';

// ---------------------------------------------------------------------------
// CORE.md injection — cap and label
// ---------------------------------------------------------------------------

/** The ADR-0015 hard cap on injected CORE.md content, in ~tokens. */
export const CORE_MEMORY_TOKEN_CAP = 1500;

/**
 * The character budget the token cap translates to. ~4 chars/token is the
 * standard rough English-prose estimate; precision doesn't matter here — the
 * cap exists to bound the prompt, not to meter it.
 */
export const CORE_MEMORY_CHAR_CAP = CORE_MEMORY_TOKEN_CAP * 4;

/** Appended when CORE.md content was cut at the cap — never a silent cut. */
export const CORE_TRUNCATION_MARKER =
  '[…CORE.md truncated at the ~1.5k-token cap]';

/**
 * Cap CORE.md content at the ADR's ~1.5k-token budget. Content at or under
 * the cap passes through verbatim; longer content is cut at the character
 * budget with an explicit truncation marker — never unbounded, never silent.
 */
export function capCoreMemory(content: string): { text: string; truncated: boolean } {
  if (content.length <= CORE_MEMORY_CHAR_CAP) return { text: content, truncated: false };
  return {
    text: `${content.slice(0, CORE_MEMORY_CHAR_CAP)}\n${CORE_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/** The heading line that labels injected memory in a prompt. */
export const CORE_MEMORY_LABEL =
  'Project memory (from this project\'s Workbench memory/CORE.md — curated ' +
  'standing context; treat it as background knowledge):';

/**
 * The labeled context section a workbench prompt carries for CORE.md content,
 * ready to append to a Worker prompt or Dispatcher seed. A missing/empty/
 * whitespace-only CORE yields '' — nothing is injected, and the prompt stays
 * byte-identical to a memory-less one. Oversized content is capped with the
 * truncation marker. Never throws, whatever arrives.
 */
export function coreMemorySection(content: unknown): string {
  if (typeof content !== 'string' || content.trim().length === 0) return '';
  const capped = capCoreMemory(content.trim());
  return `\n\n${CORE_MEMORY_LABEL}\n\n${capped.text}`;
}

// ---------------------------------------------------------------------------
// Drain journal — one dated entry per drain
// ---------------------------------------------------------------------------

/**
 * The journal file name for a drain that ended at `endedAtIso`: the date part
 * (`YYYY-MM-DD.md`), suffixed `-2`, `-3`, … when the day already has entries —
 * a second drain the same day gets its OWN file, never a clobber. `existing`
 * is the journal directory's current file names. A malformed timestamp
 * degrades to `undated` rather than throwing.
 */
export function journalFileName(endedAtIso: string, existing: readonly string[]): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(typeof endedAtIso === 'string' ? endedAtIso : '');
  const day = match ? match[1] : 'undated';
  const taken = new Set(existing);
  if (!taken.has(`${day}.md`)) return `${day}.md`;
  for (let n = 2; ; n++) {
    const name = `${day}-${n}.md`;
    if (!taken.has(name)) return name;
  }
}

/** What one drain produced, as the journal builder consumes it. */
export interface DrainJournalInput {
  /** ISO-8601 timestamp of the drain's end (any stop reason). */
  endedAt: string;
  /** The drain's stated stop reason (the Run Coordinator's / the user's). */
  reason: string;
  /** THIS drain's Run-log records (the delta since the drain started). */
  records: readonly RunLogRecord[];
  /** One-line notable events: stray adoptions, finished-without-receipt. */
  notables?: readonly string[];
}

/** One line, bounded, so a whole pasted block can't become a journal line. */
function oneLine(text: string, max = 200): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The human phrase for a declared Receipt outcome. */
function outcomeLabel(outcome: RunLogRecord['outcome']): string {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'needs-verification') return 'parked (needs manual verification)';
  if (outcome === 'blocked') return 'blocked';
  return 'unknown';
}

/** True when a doc-drift section carries an actual finding (not "none"). */
function isRealDrift(docDrift: string | null): docDrift is string {
  return docDrift !== null && docDrift.trim().length > 0 && !/^none\b/i.test(docDrift.trim());
}

/**
 * Build one drain's journal entry from its Run-log records: every Run named
 * with its declared outcome and a one-line summary, doc-drift flags, and the
 * notable events. Records with an `unknown` outcome carry no declared story
 * and are skipped (the noise floor already keeps ghosts out of the log).
 * Deterministic; sorted by issue id so the entry reads as the backlog does.
 * Never throws — malformed records degrade to what they do carry.
 */
export function buildJournalEntry(input: DrainJournalInput): string {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(input.endedAt)?.[1] ?? input.endedAt;
  const lines: string[] = [
    `# Drain journal — ${day}`,
    '',
    `- Ended: ${input.endedAt}`,
    `- Reason: ${oneLine(input.reason) || '(none given)'}`,
    '',
    '## Runs',
    '',
  ];

  const runs = input.records
    .filter((rec) => rec.outcome !== 'unknown')
    .slice()
    .sort((a, b) => (a.issueId ?? Infinity) - (b.issueId ?? Infinity));

  if (runs.length === 0) {
    lines.push('- (no Run reported a Receipt this drain)');
  }
  for (const rec of runs) {
    const name = rec.slug ?? (rec.issueId !== null ? `issue ${rec.issueId}` : 'unknown issue');
    const summary = oneLine(rec.whatChanged ?? rec.detail ?? '');
    lines.push(`- ${name}: ${outcomeLabel(rec.outcome)}${summary ? ` — ${summary}` : ''}`);
  }

  const drifts = runs.filter((rec) => isRealDrift(rec.docDrift));
  if (drifts.length > 0) {
    lines.push('', '## Doc drift', '');
    for (const rec of drifts) {
      const name = rec.slug ?? `issue ${rec.issueId ?? '?'}`;
      lines.push(`- ${name}: ${oneLine(rec.docDrift!)}`);
    }
  }

  const notables = (input.notables ?? []).map((n) => oneLine(n)).filter((n) => n.length > 0);
  if (notables.length > 0) {
    lines.push('', '## Notable events', '');
    for (const note of notables) lines.push(`- ${note}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Whether a Dispatcher activity-log entry is a NOTABLE drain event the journal
 * records (issue 73): stray-Receipt adoptions and finished-without-receipt
 * notes. Keyed on the stable activity-id prefixes those surfaces use.
 */
export function isNotableDrainActivity(id: string): boolean {
  return id.startsWith('receipt-adopt:') || id.startsWith('finished-without-receipt:');
}
