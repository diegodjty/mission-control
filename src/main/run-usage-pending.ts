/**
 * Pending Run usage (issue 143, hardened by issue 177) — bridges a Run's
 * process exit (which knows its usage) and its Receipt landing (which never
 * carries usage itself, ADR-0013), whichever order they occur in, keyed by
 * Project + issue. Electron-free so it is exercised directly against a real
 * `RunLogStore` in unit and e2e tests, like the store it sits beside.
 */
import type { RunLogRecord } from '../shared/ipc-contract';
import type { RunUsage } from '../shared/run-telemetry';
import { normalizeProjectKey } from '../shared/project-registry';
import type { RunLogStore } from './run-log-store';

/** One-shot stash: a Run's usage waits here until its Receipt lands (or vice versa). */
export class PendingRunUsageStash {
  private readonly map = new Map<string, RunUsage>();

  private key(projectPath: string, issueId: number): string {
    return `${normalizeProjectKey(projectPath)}::${issueId}`;
  }

  set(projectPath: string, issueId: number, usage: RunUsage): void {
    this.map.set(this.key(projectPath, issueId), usage);
  }

  /** Consume (read + delete) any usage stashed for this Run, if present. */
  take(projectPath: string, issueId: number): RunUsage | undefined {
    const k = this.key(projectPath, issueId);
    const usage = this.map.get(k);
    if (usage !== undefined) this.map.delete(k);
    return usage;
  }
}

/**
 * Stamp a Run's usage into its persisted Run-log record: find the latest
 * record for this issue that has none yet, and re-append a patched copy (the
 * store collapses to the latest per id, same as a Receipt re-capture). If no
 * such record exists yet, stash the usage — the Receipt watch consumes it the
 * moment the Receipt lands. Returns the patched record when one was written,
 * else `null` (usage only stashed, nothing to broadcast yet).
 */
export async function applyRunUsage(
  runLogStore: RunLogStore,
  stash: PendingRunUsageStash,
  projectPath: string,
  issueId: number,
  usage: RunUsage,
): Promise<RunLogRecord | null> {
  const records = await runLogStore.read(projectPath).catch(() => []);
  const latest = records.find((r) => r.issueId === issueId && r.usage == null);
  if (!latest) {
    stash.set(projectPath, issueId, usage);
    return null;
  }
  const patched = { ...latest, usage };
  await runLogStore.append(projectPath, patched).catch(() => {});
  return patched;
}

/**
 * Merge a freshly-ingested Receipt record with usage this main process
 * already knows about, so a later re-ingest — the ReceiptWatcher's stability
 * double-read, a second Window's independently-seeded watch, an MC restart
 * re-scan — never downgrades a populated `usage` back to null (issue 177).
 *
 * `pending` is the one-shot stash consumed on a Run's exit (the common case —
 * a Worker's process usually reports usage before or shortly after its
 * Receipt lands). When it's gone (already applied by an earlier ingest, or
 * this genuinely is a re-scan with no live process behind it), fall back to
 * whatever `usage` is already durably persisted under this exact Receipt id —
 * Receipts never carry usage themselves (ADR-0013), so an existing record's
 * `usage` is always main's own earlier stamp, never a stale producer read.
 */
export async function stickyIngestUsage(
  runLogStore: RunLogStore,
  projectPath: string,
  record: RunLogRecord,
  pending: RunUsage | undefined,
): Promise<RunLogRecord> {
  if (pending) return { ...record, usage: pending };
  const records = await runLogStore.read(projectPath).catch(() => []);
  const existing = records.find((r) => r.id === record.id);
  return existing?.usage ? { ...record, usage: existing.usage } : record;
}
