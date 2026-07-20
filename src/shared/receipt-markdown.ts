/**
 * Receipt markdown reconstruction (PURE) — issue 180.
 *
 * The Receipts tab renders a finished Run's Receipt through the shared rich
 * viewer (issue 179), including its "How it works" mermaid diagram live. The
 * persisted `RunLogRecord` (run-log-store / receipt-ingest) keeps only the
 * parsed section fields, not the Receipt file's raw bytes — the "How it
 * works" heading isn't itself a recognised section (`completion-parser`'s
 * `SectionKey` union stops at Doc drift), so its body — prose plus the
 * ```mermaid fence — rides inside the `docDrift` field verbatim. Rebuilding a
 * markdown document from the record's fields therefore reproduces the
 * mermaid fence intact; no new IPC/raw-file read is needed.
 *
 * PURE: no file/network/Electron I/O, so it is unit-testable in isolation and
 * safe to share across main/renderer.
 */
import type { RunLogRecord } from './ipc-contract';

const OUTCOME_HEADING: Record<RunLogRecord['outcome'], string> = {
  completed: 'Completed issue',
  'needs-verification': 'Ready for manual verification — issue',
  blocked: 'Blocked — issue',
  unknown: 'Run — issue',
};

/** The `NN — slug` (or best-effort partial) descriptor for a record. */
function descriptor(record: RunLogRecord): string {
  const slug = record.slug ?? undefined;
  if (record.issueId !== null && slug) return `${record.issueId} — ${slug}`;
  if (record.issueId !== null) return String(record.issueId);
  if (record.issue) return record.issue;
  return slug ?? 'Run';
}

/**
 * Reconstruct the Receipt's markdown body from a `RunLogRecord`'s parsed
 * fields, in the same section order the afk-issue-runner skill emits them
 * (What changed / Try it yourself / Verified / Bookkeeping / Doc drift, the
 * last of which carries "How it works" and its mermaid diagram). Non-completed
 * outcomes (needs-verification / blocked / unknown) have no named sections —
 * their substance lives in `detail`.
 */
export function receiptMarkdown(record: RunLogRecord): string {
  const heading = `## ${OUTCOME_HEADING[record.outcome]} ${descriptor(record)}`;
  const parts: string[] = [heading];

  const section = (label: string, body: string | null): void => {
    if (body !== null && body.trim() !== '') parts.push(`**${label}.** ${body}`);
  };

  if (record.outcome === 'completed') {
    section('What changed', record.whatChanged);
    section('Try it yourself', record.tryIt);
    section('Verified', record.verified);
    section('Bookkeeping', record.bookkeeping);
    section('Doc drift', record.docDrift);
  } else if (record.detail !== null && record.detail.trim() !== '') {
    parts.push(record.detail);
  }

  return parts.join('\n\n');
}
