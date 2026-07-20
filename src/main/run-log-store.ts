/**
 * Run log store (ADAPTER).
 *
 * Durable, per-Project on-disk persistence + retrieval of Completion-block
 * records (ADR-0009: the Run log is the Dispatcher's complete, durable history,
 * re-readable on demand). Each Project's records live in their own append-only
 * JSONL file under a base directory (Electron `userData` in production, a
 * throwaway scratch dir in the integration test), keyed by a hash of the
 * normalised repo path — so two Projects can never see each other's records and
 * the log survives closing every Pane, the Dispatcher, or the whole app.
 *
 * Append-only is deliberate: a crash mid-write can at worst leave one trailing
 * partial line, which `read` skips rather than letting it poison the whole log.
 * A record is keyed by its `id` (the Run's PTY session id); a later append with
 * the same id supersedes the earlier one (a re-capture as a streaming block
 * finishes), and `read` collapses to the latest per id. This is a thin I/O edge
 * verified by integration test, not a unit — the parsing/shaping is the pure
 * `completion-parser`'s job.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeProjectKey } from '../shared/project-registry';
import type { RunLogRecord } from '../shared/ipc-contract';

export class RunLogStore {
  constructor(private readonly baseDir: string) {}

  /** The on-disk JSONL file backing a given Project's Run log. */
  private fileFor(projectPath: string): string {
    // Hash the normalised path so the filename is filesystem-safe and stable
    // across runs; per-Project isolation falls straight out of a distinct key.
    const key = createHash('sha256')
      .update(normalizeProjectKey(projectPath))
      .digest('hex')
      .slice(0, 40);
    return join(this.baseDir, 'run-logs', `${key}.jsonl`);
  }

  /** Persist a Completion-block record for a Project. Returns the record. */
  async append(projectPath: string, record: RunLogRecord): Promise<RunLogRecord> {
    const file = this.fileFor(projectPath);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /**
   * Read a Project's Run log, newest first. Collapses to the latest record per
   * `id` (a re-capture supersedes its earlier version), and tolerates a missing
   * file (→ []) or a malformed trailing line (skipped).
   */
  async read(projectPath: string): Promise<RunLogRecord[]> {
    const file = this.fileFor(projectPath);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const byId = new Map<string, RunLogRecord>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as RunLogRecord;
        if (rec && typeof rec.id === 'string') {
          // Records persisted before issue 143 added `usage` have no key at all
          // on disk, not `usage: null` — normalize so consumers can rely on the
          // declared `RunUsage | null` type.
          if (rec.usage === undefined) rec.usage = null;
          byId.set(rec.id, rec);
        }
      } catch {
        // A partial/corrupt line (e.g. a crash mid-append): skip it rather than
        // failing the whole read.
      }
    }

    return [...byId.values()].sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
    );
  }
}
