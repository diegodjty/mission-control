/**
 * E2E — session-end actions (issue 199): fail files a prefilled issue draft,
 * green offers the one-click done-flip. Real modules against a real temp
 * workbench, no Electron/IPC/LLM — same shape as `checklist-guides.e2e.test.ts`
 * (issue 156's flip) and `qa-steps-emission.e2e.test.ts` (issue 197's Guided
 * QA Receipt): the fs edges (`qa-session-store`, `issue-file-store`,
 * `workbench-git`) and pure decision modules (`qa-session-model`,
 * `qa-followup-model`, `checklist-model`) wired exactly as the IPC handlers
 * in `main/index.ts` compose them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readIssueText, writeIssueText } from '../src/main/issue-file-store';
import { commitWorkbenchProject } from '../src/main/workbench-git';
import { readBacklogAt } from '../src/main/backlog-reader';
import { recordDoneFlip, recordFiledIssue, recordQaStepVerdict } from '../src/main/qa-session-store';
import { markVerifiedDoneText } from '../src/shared/checklist-model';
import { qaPassFileName } from '../src/shared/qa-session-model';
import { buildQaDraftIssue, qaDraftBody, qaDraftTitle } from '../src/shared/qa-followup-model';
import { nextIssueNumber, padIssueNumber, quickFixFileName } from '../src/shared/launcher-model';
import { resolveQaSteps } from '../src/shared/qa-steps-model';
import { git, seedWorkbenchSandbox, type WorkbenchSandbox } from './sandbox';

const FILE_NAME = '90-guided-qa-session.md';
const ISSUE_TEXT = `---
status: wip
depends_on: []
hitl: true
---

# 90 — guided-qa-session

Scripted parked HITL issue for the session-end-actions e2e harness.

## QA Steps

- Action: Open the launcher and click New Project.
  Expected: A project picker dialog appears.
  Command: npm run dev
- Action: Confirm the created project appears in the list.
  Expected: The new project card is visible.
`;

let wb: WorkbenchSandbox;

afterEach(async () => {
  await rm(wb.scratch, { recursive: true, force: true });
});

describe('fail → prefilled draft (issue 199)', () => {
  it('filing lands the next-numbered standalone open issue and records it against the failed step', async () => {
    wb = await seedWorkbenchSandbox();
    const qaRoot = join(wb.issuesRoot, 'qa');
    await writeFile(join(wb.issuesRoot, FILE_NAME), ISSUE_TEXT);
    await git(wb.projectRoot, 'add', '.');
    await git(wb.projectRoot, 'commit', '-m', 'seed: parked Guided QA issue');

    const backlog = await readBacklogAt(wb.issuesRoot);
    const seeded = backlog.issues.find((i) => i.fileName === FILE_NAME);
    const qaSteps = resolveQaSteps(null, seeded?.body ?? null);
    expect(qaSteps?.kind).toBe('steps');
    if (qaSteps?.kind !== 'steps') throw new Error('unreachable');

    // Record the human's fail verdict + note on step 0 — the same call the
    // Map's QaStepVerdictControl makes.
    const failedPass = await recordQaStepVerdict(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      0,
      { verdict: 'fail', note: 'The dialog never appeared — the button did nothing.' },
      '2026-07-23T12:00:00.000Z',
    );
    expect(failedPass.verdict).toBe('failed');
    expect(failedPass.results[0].filedIssue).toBeNull();

    // Build the prefilled draft exactly as the Map's openDraftForStep does.
    const step = qaSteps.steps[0];
    const title = qaDraftTitle(step);
    const body = qaDraftBody({
      step,
      note: failedPass.results[0].note,
      sourceIssueFileName: FILE_NAME,
      qaPassFileName: qaPassFileName(FILE_NAME, failedPass.pass),
      receiptFileName: null,
    });
    expect(body).toContain(step.expected);
    expect(body).toContain('The dialog never appeared — the button did nothing.');
    expect(body).toContain(`qa/${qaPassFileName(FILE_NAME, failedPass.pass)}`);
    expect(body).toContain(FILE_NAME);

    // File it — the SAME numbering/atomic-write shape QuickFixCreate (issue
    // 81) uses, into a STANDALONE issue (no `## Parent`).
    const existing = await readdir(wb.issuesRoot);
    const id = nextIssueNumber(existing);
    const fileName = quickFixFileName(id, title);
    const content = buildQaDraftIssue({ id, title, body });
    await writeFile(join(wb.issuesRoot, fileName), content, { encoding: 'utf8', flag: 'wx' });
    const commitOutcome = await commitWorkbenchProject(
      wb.projectRoot,
      `proj: issue ${padIssueNumber(id)} filed from QA fail`,
    );
    expect(commitOutcome.error).toBeNull();

    const filedPass = await recordFiledIssue(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      0,
      id,
      '2026-07-23T12:05:00.000Z',
    );
    expect(filedPass.results[0].filedIssue).toBe(id);
    // Filing a draft is bookkeeping only — never a verdict change.
    expect(filedPass.verdict).toBe('failed');

    // The new issue landed as the next-numbered, standalone (no Parent),
    // open issue — exactly what the afk-issue-runner skill picks up as
    // fallthrough work.
    const after = await readBacklogAt(wb.issuesRoot);
    const draft = after.issues.find((i) => i.fileName === fileName);
    expect(draft).toBeDefined();
    expect(draft?.status).toBe('open');
    expect(draft?.standalone).toBe(true);
    expect(draft?.title).toContain(title);

    const log = await git(wb.projectRoot, 'log', '--oneline', '-n', '3');
    expect(log).toMatch(/filed from QA fail/);
  });
});

describe('green → one-click done-flip (issue 199)', () => {
  it('an all-pass session flips the source issue to done and records the flip on the QA pass, committed', async () => {
    wb = await seedWorkbenchSandbox();
    const qaRoot = join(wb.issuesRoot, 'qa');
    await writeFile(join(wb.issuesRoot, FILE_NAME), ISSUE_TEXT);
    await git(wb.projectRoot, 'add', '.');
    await git(wb.projectRoot, 'commit', '-m', 'seed: parked Guided QA issue');

    const backlog = await readBacklogAt(wb.issuesRoot);
    const seeded = backlog.issues.find((i) => i.fileName === FILE_NAME);
    const qaSteps = resolveQaSteps(null, seeded?.body ?? null);
    if (qaSteps?.kind !== 'steps') throw new Error('unreachable');

    await recordQaStepVerdict(qaRoot, FILE_NAME, qaSteps.steps.length, 0, { verdict: 'pass' }, '2026-07-23T12:00:00.000Z');
    const greenPass = await recordQaStepVerdict(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      1,
      { verdict: 'pass' },
      '2026-07-23T12:01:00.000Z',
    );
    expect(greenPass.verdict).toBe('green');
    expect(greenPass.doneFlipped).toBe(false);

    // The flip itself: the SAME parser-validated write path issue 89's
    // editor (and issue 156/195's checklist flip) already use.
    const read = await readIssueText(wb.issuesRoot, FILE_NAME);
    expect(read.content).not.toBeNull();
    const updated = markVerifiedDoneText(read.content ?? '', '2026-07-23');
    expect(updated).not.toBeNull();
    const write = await writeIssueText(wb.issuesRoot, FILE_NAME, updated ?? '');
    expect(write.ok).toBe(true);
    const commitOutcome = await commitWorkbenchProject(wb.projectRoot, 'proj: issue 90 edited');
    expect(commitOutcome.error).toBeNull();

    // Bookkeeping: record that the flip happened, AFTER the write landed.
    const flippedPass = await recordDoneFlip(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      '2026-07-23T12:02:00.000Z',
    );
    expect(flippedPass.doneFlipped).toBe(true);
    expect(flippedPass.verdict).toBe('green');

    const after = await readBacklogAt(wb.issuesRoot);
    const flipped = after.issues.find((i) => i.fileName === FILE_NAME);
    expect(flipped?.status).toBe('done');

    const log = await git(wb.projectRoot, 'log', '--oneline', '-n', '3');
    expect(log).toMatch(/issue 90 edited/);
    const diff = await git(wb.projectRoot, 'show', 'HEAD', '--', `issues/${FILE_NAME}`);
    expect(diff).toMatch(/\+status: done/);
  });
});

describe('declining leaves everything consistent (issue 199)', () => {
  it('a fail with no draft filed, and a green session with no flip confirmed, leave the QA pass, backlog, and issue file untouched', async () => {
    wb = await seedWorkbenchSandbox();
    const qaRoot = join(wb.issuesRoot, 'qa');
    const beforeNames = new Set(await readdir(wb.issuesRoot));
    await writeFile(join(wb.issuesRoot, FILE_NAME), ISSUE_TEXT);
    await git(wb.projectRoot, 'add', '.');
    await git(wb.projectRoot, 'commit', '-m', 'seed: parked Guided QA issue');

    const before = await readIssueText(wb.issuesRoot, FILE_NAME);
    const backlog = await readBacklogAt(wb.issuesRoot);
    const seeded = backlog.issues.find((i) => i.fileName === FILE_NAME);
    const qaSteps = resolveQaSteps(null, seeded?.body ?? null);
    if (qaSteps?.kind !== 'steps') throw new Error('unreachable');

    // Fail step 0, but never call recordFiledIssue/fileQaDraftIssue.
    const failedPass = await recordQaStepVerdict(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      0,
      { verdict: 'fail', note: 'declined to file' },
      '2026-07-23T12:00:00.000Z',
    );
    expect(failedPass.results[0].filedIssue).toBeNull();
    // No new issue file (draft) appeared beyond the seeded fixture + FILE_NAME.
    const namesAfterFail = (await readdir(wb.issuesRoot)).filter((n) => n !== 'qa');
    expect(new Set(namesAfterFail)).toEqual(new Set([...beforeNames, FILE_NAME]));

    // Re-QA green, but never call the flip.
    await recordQaStepVerdict(qaRoot, FILE_NAME, qaSteps.steps.length, 0, { verdict: 'pass' }, '2026-07-23T12:05:00.000Z');
    const greenPass = await recordQaStepVerdict(
      qaRoot,
      FILE_NAME,
      qaSteps.steps.length,
      1,
      { verdict: 'pass' },
      '2026-07-23T12:06:00.000Z',
    );
    expect(greenPass.verdict).toBe('green');
    expect(greenPass.doneFlipped).toBe(false);

    // The issue file and backlog status are untouched — declining wrote
    // nothing outside the QA pass file itself.
    const after = await readIssueText(wb.issuesRoot, FILE_NAME);
    expect(after.content).toBe(before.content);
    const afterBacklog = await readBacklogAt(wb.issuesRoot);
    expect(afterBacklog.issues.find((i) => i.fileName === FILE_NAME)?.status).toBe('wip');
  });
});
