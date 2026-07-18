/**
 * Curator-report seen store — "opened it" persistence for the curator-report
 * attention items (issue 151).
 *
 * Lives in the app's **userData** directory, NOT in any workbench: opening a
 * report in MC must never create a workbench commit. One JSON file
 * (`curator-report-seen.json`) lists the report file names the human has
 * already opened; unseen ones keep surfacing, seen ones never resurface
 * (survives restarts). The parse/serialize/mark semantics live in the pure
 * `shared/attention-hub-model`; this file is only the fs edge.
 *
 * Never throws: a missing/corrupt file loads as the empty list (everything
 * unseen — the safe direction) and a failed persist keeps the in-memory list
 * current for the running app; only a restart would re-show.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markReportSeen, parseSeenReports, serializeSeenReports } from '../shared/attention-hub-model';

const FILE_NAME = 'curator-report-seen.json';

export class CuratorReportSeenStore {
  private readonly filePath: string;
  private readonly dir: string;
  private names: string[] = [];

  constructor(userDataDir: string) {
    this.dir = userDataDir;
    this.filePath = join(userDataDir, FILE_NAME);
  }

  /** Load the persisted seen list; call once before the watcher starts. */
  async load(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null);
    this.names = parseSeenReports(content);
  }

  /** The seen report file names, as a set the pure model can query. */
  get(): ReadonlySet<string> {
    return new Set(this.names);
  }

  /**
   * A report was opened: mark it seen and persist. A no-op (no write) when it
   * was already seen. Returns whether the set actually changed.
   */
  async markSeen(name: string): Promise<boolean> {
    const next = markReportSeen(this.names, name);
    if (next.length === this.names.length) return false;
    this.names = next;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.filePath, serializeSeenReports(this.names), 'utf8');
    } catch {
      // Persist failed (disk/permissions): the in-memory list still governs
      // this session; the entry would simply re-show after a restart.
    }
    return true;
  }
}
