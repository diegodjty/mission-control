/**
 * Timeout-salvage store (main, issue 170) — the fs edge for pending
 * timeout-salvage records (`shared/timeout-salvage.ts`'s pure parse/
 * serialize/upsert/remove).
 *
 * Persisted as one JSON file, `.timeout-salvage.json`, sitting beside a
 * workbench project's Receipts under `completions/` — deliberately INSIDE the
 * directory the AttentionWatcher (`attention-watcher.ts`) already recursively
 * watches, so writing a record here re-derives and broadcasts the Attention
 * surface with no extra watcher wiring. It is never mistaken for a Receipt:
 * `readMarkdownFiles`/`parseReceipt` (attention-reader.ts) only ever look at
 * `.md` files.
 *
 * Read-modify-write, single file, no locking: the only writers are (a) the
 * Headless Session Manager's timeout-kill exit path and (b) the salvage
 * resolve actions (complete-from-worktree / discard-and-requeue) — both are
 * per-issue, human/timer-triggered, and rare enough that a lost race is not a
 * practical concern (mirrors `curator-report-seen.ts`'s same best-effort
 * persistence contract).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseTimeoutSalvageRecords,
  removeTimeoutSalvageRecord,
  serializeTimeoutSalvageRecords,
  upsertTimeoutSalvageRecord,
  type TimeoutSalvageRecord,
} from '../shared/timeout-salvage';

export const TIMEOUT_SALVAGE_FILE_NAME = '.timeout-salvage.json';

function filePathFor(completionsRoot: string): string {
  return join(completionsRoot, TIMEOUT_SALVAGE_FILE_NAME);
}

async function readAll(completionsRoot: string): Promise<TimeoutSalvageRecord[]> {
  const content = await readFile(filePathFor(completionsRoot), 'utf8').catch(() => null);
  return parseTimeoutSalvageRecords(content);
}

async function writeAll(
  completionsRoot: string,
  records: readonly TimeoutSalvageRecord[],
): Promise<void> {
  await mkdir(completionsRoot, { recursive: true });
  await writeFile(filePathFor(completionsRoot), serializeTimeoutSalvageRecords(records), 'utf8');
}

/**
 * Record a Run just killed for exceeding `run_timeout`. Best-effort: a persist
 * failure (disk/permissions) is swallowed — the strand is real regardless, but
 * with no distinct signal until the next successful write (never worse than
 * issue 141's prior silent behavior).
 */
export async function recordTimeoutSalvage(
  completionsRoot: string,
  record: TimeoutSalvageRecord,
): Promise<void> {
  try {
    const records = upsertTimeoutSalvageRecord(await readAll(completionsRoot), record);
    await writeAll(completionsRoot, records);
  } catch {
    // Best-effort persistence — see file header.
  }
}

/** Resolve (clear) one project+issue's pending record — salvaged or discarded. */
export async function resolveTimeoutSalvage(
  completionsRoot: string,
  project: string,
  issueId: number,
): Promise<void> {
  try {
    const records = removeTimeoutSalvageRecord(await readAll(completionsRoot), project, issueId);
    await writeAll(completionsRoot, records);
  } catch {
    // Best-effort persistence — see file header.
  }
}

/** The pending record for one project+issue, or null when none/unreadable. */
export async function readTimeoutSalvageRecord(
  completionsRoot: string,
  project: string,
  issueId: number,
): Promise<TimeoutSalvageRecord | null> {
  const records = await readAll(completionsRoot);
  return records.find((r) => r.project === project && r.issueId === issueId) ?? null;
}
