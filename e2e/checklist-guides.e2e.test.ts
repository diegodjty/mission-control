/**
 * E2E — interactive HITL checklist (issue 156). Real modules against a real
 * temp git workbench, no Electron/IPC/LLM: a parked HITL issue's Receipt
 * carries a 3-item checklist → ticking all three items persists through the
 * real `ChecklistStateStore` → "Mark verified & done" flips the issue via the
 * SAME parser-validated fs edge the Map's Edit affordance uses
 * (`readIssueText`/`writeIssueText`, issue 89) → the flip is committed via
 * the real workbench-git path. Covers the issue's acceptance criterion e
 * ("park an HITL issue with a 3-item checklist → tick all three → issue
 * flips done and the flip is committed").
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIssueText, writeIssueText } from '../src/main/issue-file-store';
import { commitWorkbenchProject } from '../src/main/workbench-git';
import { readBacklogAt } from '../src/main/backlog-reader';
import { ChecklistStateStore } from '../src/main/checklist-state-store';
import { parseReceipt } from '../src/shared/receipt-parser';
import { parseChecklist, checklistSourceText, markVerifiedDoneText } from '../src/shared/checklist-model';
import { allChecked } from '../src/shared/checklist-state-model';
import { git, seedWorkbenchSandbox, type WorkbenchSandbox } from './sandbox';

const FILE_NAME = '90-checklist-hitl.md';
const ISSUE_TEXT = `---
status: wip
depends_on: []
hitl: true
---

# 90 — checklist-hitl

Scripted parked HITL issue for the e2e checklist harness.
`;

const RECEIPT_TEXT = `---
issue: 90
slug: checklist-hitl
outcome: needs-verification
finished: 2026-07-18T12:00:00Z
---
## Ready for manual verification — issue 90 — checklist-hitl

**Verification steps**

- [ ] Open the Map and select the parked issue.
- [ ] Tick each checklist step as you complete it.
- [ ] Confirm "Mark verified & done" appears once all three are checked.
`;

let wb: WorkbenchSandbox;
let userDataDir: string;

afterEach(async () => {
  await rm(wb.scratch, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
});

describe('interactive HITL checklist — park, tick all three, flip done (issue 156)', () => {
  it('ticking every item then Mark verified & done flips the issue to done, committed', async () => {
    wb = await seedWorkbenchSandbox();
    userDataDir = await mkdtemp(join(tmpdir(), 'mc-checklist-e2e-'));

    // Seed the parked HITL issue + its Receipt (a fake Worker's park), then
    // commit — the workbench state a human would find waiting for them.
    await writeFile(join(wb.issuesRoot, FILE_NAME), ISSUE_TEXT);
    await mkdir(wb.completionsRoot, { recursive: true });
    await writeFile(join(wb.completionsRoot, 'checklist-hitl.md'), RECEIPT_TEXT);
    await git(wb.projectRoot, 'add', '.');
    await git(wb.projectRoot, 'commit', '-m', 'seed: parked HITL checklist issue');

    // The backlog reads it as wip + hitl — the Map's gate for rendering a
    // checklist at all.
    const before = await readBacklogAt(wb.issuesRoot);
    const seeded = before.issues.find((i) => i.fileName === FILE_NAME);
    expect(seeded?.status).toBe('wip');
    expect(seeded?.hitl).toBe(true);

    // Parse the checklist from the Receipt's detail body (the parser's
    // primary source, per the issue) — 3 ordered, unchecked items.
    const receipt = parseReceipt(RECEIPT_TEXT);
    expect(receipt.outcome).toBe('needs-verification');
    const source = checklistSourceText(receipt.detail, seeded?.body ?? null);
    const items = parseChecklist(source);
    expect(items).toHaveLength(3);
    expect(items.every((item) => !item.checked)).toBe(true);

    // Tick all three through the REAL persistence store (userData, keyed by
    // project + issue file) — the same store the main-process IPC handlers
    // wrap.
    const store = new ChecklistStateStore(userDataDir);
    await store.load();
    const projectKey = wb.projectRoot;
    let flags = store.get(projectKey, FILE_NAME, items.length);
    expect(flags).toEqual([false, false, false]);
    for (let i = 0; i < items.length; i++) {
      flags = await store.toggle(projectKey, FILE_NAME, i, items.length);
    }
    expect(flags).toEqual([true, true, true]);
    expect(allChecked(flags, items.length)).toBe(true);

    // ...and it survives a restart (a fresh store instance, same userData dir).
    const reopened = new ChecklistStateStore(userDataDir);
    await reopened.load();
    expect(reopened.get(projectKey, FILE_NAME, items.length)).toEqual([true, true, true]);

    // "Mark verified & done": re-read the file fresh, flip status: wip →
    // done with a dated sign-off note, save through the SAME parser-validated
    // edit path issue 89 exposes, then commit — never a silent flip.
    const read = await readIssueText(wb.issuesRoot, FILE_NAME);
    expect(read.content).not.toBeNull();
    const updated = markVerifiedDoneText(read.content ?? '', '2026-07-18');
    expect(updated).not.toBeNull();
    expect(updated).toMatch(/Verified and marked done by human sign-off on 2026-07-18/);

    const write = await writeIssueText(wb.issuesRoot, FILE_NAME, updated ?? '');
    expect(write.ok).toBe(true);

    const commitOutcome = await commitWorkbenchProject(wb.projectRoot, 'proj: issue 90 edited');
    expect(commitOutcome.error).toBeNull();
    expect(commitOutcome.committed).toBe(true);

    // The flip is on disk...
    const after = await readBacklogAt(wb.issuesRoot);
    const flipped = after.issues.find((i) => i.fileName === FILE_NAME);
    expect(flipped?.status).toBe('done');

    // ...and it is COMMITTED — the acceptance criterion's "the flip is
    // committed", not just written to the working tree.
    const log = await git(wb.projectRoot, 'log', '--oneline', '-n', '3');
    expect(log).toMatch(/issue 90 edited/);
    const diff = await git(wb.projectRoot, 'show', 'HEAD', '--', `issues/${FILE_NAME}`);
    expect(diff).toMatch(/\+status: done/);
  });
});
