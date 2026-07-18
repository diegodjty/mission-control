/**
 * HITL checklist check-state store — issue 156.
 *
 * Lives in the app's **userData** directory, NOT in any workbench: ticking a
 * QA checkbox must never create a workbench commit (this is ephemeral
 * working state, like the Run log). One JSON file
 * (`checklist-state.json`) maps `${projectKey}::${fileName}` → the checked
 * flags for that issue's checklist, in order — so a toggle survives an app
 * restart and a project switch (the acceptance criteria's persistence bar).
 *
 * Never throws: a missing/corrupt file loads as the empty map (everything
 * unchecked — the safe direction) and a failed persist keeps the in-memory
 * flags so the running app stays correct; only a restart would re-show.
 * The state shape and parse/serialize/toggle logic live in the pure
 * `shared/checklist-state-model`; this file is only the fs edge.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkedFlagsFor,
  checklistStateKey,
  parseChecklistState,
  serializeChecklistState,
  toggleChecklistItem,
  type ChecklistStateMap,
} from '../shared/checklist-state-model';

const FILE_NAME = 'checklist-state.json';

export class ChecklistStateStore {
  private readonly filePath: string;
  private readonly dir: string;
  private state: ChecklistStateMap = {};

  constructor(userDataDir: string) {
    this.dir = userDataDir;
    this.filePath = join(userDataDir, FILE_NAME);
  }

  /** Load the persisted state; call once before any get/toggle. */
  async load(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null);
    this.state = parseChecklistState(content);
  }

  /** The checked flags for one issue's checklist, aligned to `itemCount`. */
  get(projectKey: string, fileName: string, itemCount: number): boolean[] {
    return checkedFlagsFor(this.state, checklistStateKey(projectKey, fileName), itemCount);
  }

  /**
   * Toggle one item and persist. Returns the resulting (aligned) flags
   * either way — a failed write keeps the in-memory flags current for this
   * session (the entry would simply re-show after a restart).
   */
  async toggle(
    projectKey: string,
    fileName: string,
    index: number,
    itemCount: number,
  ): Promise<boolean[]> {
    const key = checklistStateKey(projectKey, fileName);
    this.state = toggleChecklistItem(this.state, key, index, itemCount);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.filePath, serializeChecklistState(this.state), 'utf8');
    } catch {
      // Persist failed (disk/permissions): the in-memory flags still govern
      // this session; the toggle would simply re-show after a restart.
    }
    return checkedFlagsFor(this.state, key, itemCount);
  }
}
