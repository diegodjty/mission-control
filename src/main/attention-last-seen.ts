/**
 * Attention last-seen store — the briefing's "when did I last look?" stamps
 * (issue 80, ADR-0016).
 *
 * Lives in the app's **userData** directory, NOT in any workbench: reading
 * the Inbox must never create workbench commits, so this app-level fact is
 * kept app-level. One JSON file (`attention-last-seen.json`) maps workbench
 * project directory name → ISO-8601 stamp of the last time this app's Inbox
 * was viewed; the attention watcher's `lastSeenFor` hook reads it (in
 * memory, synchronously) and the pure attention model filters journal
 * entries against it.
 *
 * Never throws: a missing/corrupt file loads as the empty map (everything
 * unseen — the safe direction) and a failed persist keeps the in-memory
 * stamps so the running app stays correct; only a restart would re-show.
 * The stamp semantics (parse/serialize/advance) live in the pure
 * `shared/attention-hub-model`; this file is only the fs edge.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advanceLastSeen, parseLastSeen, serializeLastSeen } from '../shared/attention-hub-model';

const FILE_NAME = 'attention-last-seen.json';

export class AttentionLastSeenStore {
  private readonly filePath: string;
  private readonly dir: string;
  private stamps: Record<string, string> = {};

  constructor(userDataDir: string) {
    this.dir = userDataDir;
    this.filePath = join(userDataDir, FILE_NAME);
  }

  /** Load the persisted stamps; call once before the watcher starts. */
  async load(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null);
    this.stamps = parseLastSeen(content);
  }

  /** The stamp for one project, or null when this app has never looked. */
  get(project: string): string | null {
    return this.stamps[project] ?? null;
  }

  /**
   * The Inbox was viewed: advance every given project's stamp to `nowIso`
   * (never backwards) and persist. Returns the resulting map either way — a
   * failed write keeps the in-memory stamps current for this session.
   */
  async markAll(projects: readonly string[], nowIso: string): Promise<Record<string, string>> {
    this.stamps = advanceLastSeen(this.stamps, projects, nowIso);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.filePath, serializeLastSeen(this.stamps), 'utf8');
    } catch {
      // Persist failed (disk/permissions): the in-memory stamps still govern
      // this session; the entries would simply re-show after a restart.
    }
    return { ...this.stamps };
  }
}
