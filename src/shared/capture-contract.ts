/**
 * Capture contract (PURE) — the lifecycle event types the audit/notification
 * path still needs from a Run's parsed Completion block.
 *
 * This module used to also assemble the retired Dispatcher chat's full
 * seed/stream input contract (the backlog seed + PRD/CONTEXT text alongside
 * the event stream). That assembler (`assembleInputContract` and its seed
 * types) had no consumer left once the Dispatcher chat surface was removed
 * (issue 161) and was deleted with this rename (issue 164) — only the
 * whitelisted-fields boundary below survives, because `App.tsx` still uses it
 * to render a finished Run's Completion block as plain text for the
 * notification/Run-log narrative path.
 *
 * The property this module still guarantees: a finished Run's structured
 * `CompletionRecord` is projected through a WHITELIST of its fields, and the
 * raw Pane scroll — present on `RunResult` ONLY so the exclusion is a real,
 * tested boundary — is never read into the rendered text.
 *
 * PURE: no I/O, no Electron, no LLM. Unit-testable in isolation and safe to
 * share across main/renderer.
 */
import type { CompletionRecord, RunOutcome } from './completion-parser';

/**
 * A finished Run as the assembler sees it: its stable id, its parsed Completion
 * block, and — present ONLY so the exclusion is a real, tested boundary — its
 * raw Pane scroll. `rawPaneOutput` is never read into the contract.
 */
export interface RunResult {
  /** Stable per-Run id (the PTY session id). */
  id: string;
  /** The parsed Completion block — the ONLY thing that enters the contract. */
  record: CompletionRecord;
  /**
   * The Run's raw terminal/Pane scroll. The assembler must NOT surface this: it
   * is here to make "excludes raw Pane output" a boundary the test can push on.
   */
  rawPaneOutput?: string;
}

/**
 * One event built from a Run's Completion block. Every field is a WHITELISTED
 * structured field from the parsed record — there is deliberately no field
 * that could carry raw Pane scroll.
 */
export interface CompletionBlockEvent {
  kind: 'completion-block';
  /** The Run (session) id this block came from. */
  id: string;
  issueId: number | null;
  issue: string | null;
  outcome: RunOutcome;
  whatChanged: string | null;
  tryIt: string | null;
  verified: string | null;
  bookkeeping: string | null;
  docDrift: string | null;
  /**
   * The free-form report body for a blocked / needs-verification / unknown Run
   * (the reason, the verification steps, the unparsed text). Whitelisted like
   * the section fields — it is the parser's `detail`, never raw Pane scroll — so
   * the caller receives a blocked Run's substance, not just its header.
   */
  detail: string | null;
}

/**
 * Build one completion-block event from a Run's parsed record. This reads ONLY
 * the whitelisted structured fields of `result.record`; `result.rawPaneOutput`
 * is never touched, so raw scroll cannot leak into the rendered text.
 */
export function toCompletionEvent(result: RunResult): CompletionBlockEvent {
  const r = result.record;
  return {
    kind: 'completion-block',
    id: result.id,
    issueId: r.issueId,
    issue: r.issue,
    outcome: r.outcome,
    whatChanged: r.whatChanged,
    tryIt: r.tryIt,
    verified: r.verified,
    bookkeeping: r.bookkeeping,
    docDrift: r.docDrift,
    detail: r.detail,
  };
}

/**
 * Render one Completion block event as the compact plain-text message fed into
 * the notification/Run-log narrative path as a Run finishes. Built only from
 * the whitelisted fields, so — like the contract itself — it can never carry
 * raw Pane scroll.
 */
export function renderCompletionEvent(event: CompletionBlockEvent): string {
  const idLabel = event.issueId !== null ? String(event.issueId).padStart(2, '0') : '—';
  const lines: string[] = [
    `Completion block for issue ${idLabel} (${event.outcome})` +
      (event.issue ? ` — ${event.issue}` : ''),
  ];
  const field = (label: string, value: string | null): void => {
    if (value !== null && value !== '') lines.push(`${label}: ${value}`);
  };
  field('What changed', event.whatChanged);
  field('Try it', event.tryIt);
  field('Verified', event.verified);
  field('Bookkeeping', event.bookkeeping);
  field('Doc drift', event.docDrift);
  // The report body for a blocked / needs-verification / unknown Run: without
  // it the reader would see only the header line above.
  field('Detail', event.detail);
  return lines.join('\n');
}
