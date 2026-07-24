/**
 * Receipt ingest (PURE) — the decisions behind the Receipt capture edge
 * (issue 56, ADR-0013).
 *
 * The watcher adapter (`main/receipt-watcher`) sees raw filesystem events under
 * `issues/completions/`; this module holds every decision that can be made
 * without I/O so it is unit-testable in isolation:
 *
 *   - `isReceiptPath`          — is this watch event a Receipt file at all?
 *   - `toReceiptRunLogRecord`  — Receipt text → the SAME `RunLogRecord` shape
 *                                the scroll-capture path produced (issue 34),
 *                                so a Receipt enters the existing Run-log /
 *                                Dispatcher-feed pipeline with no bespoke path.
 *   - `shouldIngest`           — the dedupe gate (ADR-0013: key on issue +
 *                                `finished`) that keeps an MC restart or a
 *                                watcher re-scan from double-feeding the
 *                                Dispatcher, while letting a re-run (new
 *                                `finished` stamp) through as a NEW event.
 *   - `contentFingerprint`     — a cheap stable hash so an unchanged re-write
 *                                is a no-op but a changed body with the same
 *                                stamp can supersede its earlier version.
 *
 * Record identity: `receipt:<NN-slug>:<finished>`. The `NN-slug` stem comes
 * from the Receipt's file name (the producer contract names the file for the
 * issue), so identity survives a Receipt whose frontmatter is missing or
 * broken; `finished` distinguishes re-runs of the same issue. The same id is
 * what the Run-log store collapses on and the renderer feed dedupes on, so a
 * superseded ingest replaces its card instead of adding a duplicate.
 *
 * PURE: no file/network/Electron I/O.
 */
import { parseReceipt } from './receipt-parser';
import type { RunLogRecord } from './ipc-contract';

/**
 * Whether a watch event's relative path (as reported by a recursive watch of
 * an `issues/` dir) denotes a Receipt: a `.md` file DIRECTLY under
 * `completions/`. Dotfiles (editor swap/tmp files) and the backlog's own
 * root-level issue files are not Receipts.
 */
export function isReceiptPath(relPath: string | null): boolean {
  if (!relPath) return false;
  const match = /^completions[/\\]([^/\\]+)$/.exec(relPath);
  if (!match) return false;
  const name = match[1];
  return name.endsWith('.md') && !name.startsWith('.');
}

/**
 * A cheap, stable fingerprint of a Receipt's text (FNV-1a, hex). Not
 * cryptographic — it only needs to tell "same bytes re-scanned" from "the file
 * actually changed".
 */
export function contentFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * The dedupe gate (ADR-0013). `seen` maps a record id (issue + finished) to the
 * fingerprint of the content already ingested under that id — or to `null` for
 * ids seeded from the persisted Run log on restart, whose original bytes are
 * unknown and which must NEVER re-feed. A brand-new id ingests; a known id
 * re-ingests only when its content genuinely changed (superseding the earlier
 * version under the same id).
 */
export function shouldIngest(
  seen: ReadonlyMap<string, string | null>,
  id: string,
  fingerprint: string,
): boolean {
  if (!seen.has(id)) return true;
  const prior = seen.get(id);
  if (prior === null) return false;
  return prior !== fingerprint;
}

/** The `NN-slug` stem of a Receipt file name (`NN-slug.md`). */
function stemOf(fileName: string): string {
  return fileName.replace(/\.md$/, '');
}

/**
 * Turn a Receipt file's text into the `RunLogRecord` the existing capture
 * pipeline consumes. Parsing is the pure receipt-parser's job (issue 55,
 * frontmatter-first); this adds the capture metadata: a stable id keyed on
 * issue + `finished`, the `NN-slug` from the file name (identity survives a
 * frontmatter-less Receipt), and the capture timestamp. `title` is null — the
 * card header falls back to the block's own descriptor/slug.
 */
export function toReceiptRunLogRecord(
  text: string,
  fileName: string,
  capturedAt: string,
): RunLogRecord {
  const parsed = parseReceipt(text);
  const stem = stemOf(fileName);
  const idFromName = /^(\d+)-/.exec(stem);
  return {
    issue: parsed.issue,
    issueId: parsed.issueId ?? (idFromName ? Number(idFromName[1]) : null),
    whatChanged: parsed.whatChanged,
    tryIt: parsed.tryIt,
    verified: parsed.verified,
    bookkeeping: parsed.bookkeeping,
    docDrift: parsed.docDrift,
    detail: parsed.detail,
    outcome: parsed.outcome,
    id: `receipt:${stem}:${parsed.finished ?? 'undated'}`,
    capturedAt,
    slug: stem,
    title: null,
    // Telemetry channel (issue 210, ADR-0013 amendment): a Receipt from a CLI
    // drain now carries producer-computed usage in its frontmatter (the AFK
    // usage hook writes it from the transcript, since MC never spawned the Run
    // and the issue-143 in-app bridge can't fire for it). `null` when the hook
    // didn't run — an in-app headless Run then still gets its usage patched in
    // by main once its process exits (the bridge, unchanged).
    usage: parsed.usage,
  };
}
