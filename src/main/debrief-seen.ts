/**
 * Debrief-seen store — "offered it" persistence for the drain-end Debrief
 * affordance (issue 152).
 *
 * Lives in the app's **userData** directory, NOT in any workbench — offering
 * the affordance in MC must never create a workbench commit. One JSON file
 * (`debrief-seen.json`) lists the journal-entry keys (`<project>:<fileName>`)
 * already offered; an offered entry never re-offers, even after a refresh or
 * restart. The parse/serialize/mark semantics live in the pure
 * `shared/attention-hub-model`; this file is only the fs edge.
 *
 * Never throws: a missing/corrupt file loads as the empty list (everything
 * unseen — the safe direction) and a failed persist keeps the in-memory list
 * current for the running app; only a restart would re-offer.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  markDebriefSeen,
  parseSeenDebriefs,
  serializeSeenDebriefs,
  shouldOfferDebrief,
} from '../shared/attention-hub-model';

const FILE_NAME = 'debrief-seen.json';

export class DebriefSeenStore {
  private readonly filePath: string;
  private readonly dir: string;
  private keys: string[] = [];

  constructor(userDataDir: string) {
    this.dir = userDataDir;
    this.filePath = join(userDataDir, FILE_NAME);
  }

  /** Load the persisted seen list; call once before any drain can end. */
  async load(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null);
    this.keys = parseSeenDebriefs(content);
  }

  /**
   * A drain's journal entry landed: decide whether to offer the Debrief
   * affordance for it and, if so, mark it seen (persisted) in the same call —
   * the decision and the mark are atomic, so the entry can never be offered
   * twice even across a rapid re-check. A blank/already-seen key returns
   * false and never writes.
   */
  async offerOnce(key: string): Promise<boolean> {
    const offer = shouldOfferDebrief(key, new Set(this.keys));
    if (!offer) return false;
    this.keys = markDebriefSeen(this.keys, key);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.filePath, serializeSeenDebriefs(this.keys), 'utf8');
    } catch {
      // Persist failed (disk/permissions): the in-memory list still governs
      // this session; the entry would simply re-offer after a restart.
    }
    return true;
  }
}
