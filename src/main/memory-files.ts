/**
 * Memory files (main process) — the file-I/O edge of the workbench memory
 * loop (issue 73, ADR-0015).
 *
 * Two thin operations over a workbench project's `memory/` directory:
 *
 *  - `readCoreMemory` — the curated `CORE.md` content a spawn injects into a
 *    Worker prompt / Dispatcher seed (missing/unreadable → null, so the spawn
 *    proceeds with nothing injected — a broken memory dir must never block a
 *    Run);
 *  - `writeDrainJournal` — ONE dated summary artifact per finished drain in
 *    `memory/journal/`, written as a single save so a watcher never ingests a
 *    half-written entry, named so a second drain the same day gets its own
 *    file (no clobber — `wx`, never overwrite).
 *
 * All decisions (the token cap, the labeling, the entry content, the file
 * name) live in the pure `shared/workbench-memory`; this file only touches
 * the filesystem. The workbench auto-commit for the journal rides the issue-72
 * commit path in the main process wiring, not here. Never throws.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildJournalEntry,
  journalFileName,
  type DrainJournalInput,
} from '../shared/workbench-memory';

/**
 * The project's `memory/CORE.md` content, or null when missing/unreadable —
 * a memory-less project simply injects nothing.
 */
export async function readCoreMemory(memoryRoot: string): Promise<string | null> {
  try {
    return await readFile(join(memoryRoot, 'CORE.md'), 'utf8');
  } catch {
    return null;
  }
}

export interface DrainJournalWriteOutcome {
  /** True when a journal entry landed on disk this call. */
  written: boolean;
  /** The absolute path of the entry, when written. */
  path: string | null;
  /** The entry's file name (for the workbench commit message), when written. */
  fileName: string | null;
  /** The failure, when the write was attempted and failed. Never thrown. */
  error: string | null;
}

/**
 * Write one drain's journal entry into `<memoryRoot>/journal/`. The entry is
 * built by the pure builder, named after the drain-end date (`-2`, `-3`, …
 * when the day already has entries), and written as ONE exclusive save
 * (`wx` — an existing file is never clobbered; a concurrent-name race retries
 * with the next free name). Errors are reported, never thrown.
 */
export async function writeDrainJournal(
  input: DrainJournalInput & { memoryRoot: string },
): Promise<DrainJournalWriteOutcome> {
  try {
    const journalRoot = join(input.memoryRoot, 'journal');
    await mkdir(journalRoot, { recursive: true });
    const content = buildJournalEntry(input);
    // A same-name race (two writers picking one free name) surfaces as EEXIST
    // thanks to `wx`; re-listing and retrying keeps "no clobber" absolute.
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await readdir(journalRoot);
      const fileName = journalFileName(input.endedAt, existing);
      const path = join(journalRoot, fileName);
      try {
        await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
        return { written: true, path, fileName, error: null };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    return {
      written: false,
      path: null,
      fileName: null,
      error: 'could not find a free journal file name',
    };
  } catch (err) {
    return {
      written: false,
      path: null,
      fileName: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
