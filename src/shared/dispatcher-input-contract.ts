/**
 * Dispatcher input-contract assembler (PURE) — minimal slice.
 *
 * The Dispatcher's ENTIRE input is a **seed** (the backlog + PRD/CONTEXT) plus a
 * **stream** of structured events — for the tracer-bullet spine, just the
 * Completion blocks each Run emits. The defining rule (PRD "Input contract",
 * ADR-0001/0009): **raw Pane output is NEVER part of the contract.** The
 * Dispatcher reasons over each Run's *summary*, never its implementation
 * transcript, which is what keeps it lean across a long drain.
 *
 * That exclusion is the property this module exists to guarantee — and the one
 * its unit test pins. The assembler is handed each finished Run's structured
 * `CompletionRecord` (from the pure `completion-parser`) and, to model the
 * temptation directly, optionally its raw Pane scroll; it builds the stream from
 * a WHITELIST of the record's structured fields and never reads the raw scroll.
 * Later slices thicken the stream with lifecycle events and doc-drift flags
 * (issues 37–39) and the seed's rolling synthesis (ADR-0009); the exclusion rule
 * stays the same.
 *
 * PURE: no I/O, no Electron, no LLM. Unit-testable in isolation and safe to
 * share across main/renderer.
 */
import type { Backlog } from './backlog-model';
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

/** One issue in the seed: id/status/title only — never its body or Pane scroll. */
export interface SeedIssue {
  id: number;
  status: string;
  title: string;
}

/** The seed the Dispatcher starts from: the backlog + PRD/CONTEXT references. */
export interface DispatcherSeed {
  /** The active PRD path from the backlog's CONFIG, or null. */
  activePrd: string | null;
  /** One line per issue (id/status/title). No bodies — those live on disk. */
  issues: SeedIssue[];
  /** The PRD text, when the caller supplies it (else the session reads it on disk). */
  prd: string | null;
  /** The CONTEXT.md text, when supplied (else read on disk). */
  context: string | null;
}

/**
 * One event in the Dispatcher's stream. For the spine it is only a Completion
 * block; the union leaves room for lifecycle events / doc-drift flags (37–39).
 * Every field is a WHITELISTED structured field from the parsed record — there
 * is deliberately no field that could carry raw Pane scroll.
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
   * the Dispatcher receives a blocked Run's substance, not just its header.
   */
  detail: string | null;
}

export type DispatcherEvent = CompletionBlockEvent;

/** The assembled input contract: seed + filtered event stream. */
export interface DispatcherInputContract {
  seed: DispatcherSeed;
  stream: DispatcherEvent[];
}

export interface AssembleInput {
  /** The active Project's backlog (seed). Null before it loads. */
  backlog: Backlog | null;
  /** The PRD text, when available. */
  prd?: string | null;
  /** The CONTEXT.md text, when available. */
  context?: string | null;
  /** The finished Runs whose Completion blocks form the stream. */
  results: RunResult[];
}

/** Project one issue into its seed line — no body, no Pane scroll. */
function toSeedIssue(issue: { id: number; status: string; title: string }): SeedIssue {
  return { id: issue.id, status: issue.status, title: issue.title };
}

/**
 * Build one stream event from a Run's parsed record. This reads ONLY the
 * whitelisted structured fields of `result.record`; `result.rawPaneOutput` is
 * never touched, so raw scroll cannot leak into the contract.
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
 * Assemble the Dispatcher's input contract from the seed inputs and the finished
 * Runs. The stream is built strictly from each Run's structured Completion
 * record — never its raw Pane output.
 */
export function assembleInputContract(input: AssembleInput): DispatcherInputContract {
  const seed: DispatcherSeed = {
    activePrd: input.backlog?.activePrd ?? null,
    issues: (input.backlog?.issues ?? []).map(toSeedIssue),
    prd: input.prd ?? null,
    context: input.context ?? null,
  };
  const stream = input.results.map(toCompletionEvent);
  return { seed, stream };
}

/**
 * Render one Completion block event as the compact plain-text message fed into
 * the Dispatcher session as a Run finishes. Built only from the whitelisted
 * fields, so — like the contract itself — it can never carry raw Pane scroll.
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
  // it the Dispatcher would see only the header line above.
  field('Detail', event.detail);
  return lines.join('\n');
}
