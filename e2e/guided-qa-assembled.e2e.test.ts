/**
 * E2E — the ASSEMBLED Guided QA flow through the drain harness (issue 200).
 *
 * Issues 196-199 each landed one seam of Guided QA (schema/parser/render,
 * Worker emission, verdicts + QA receipt, session-end actions) with its own
 * e2e coverage of that seam in isolation. This suite is the "every slice
 * green but the assembled feature broken" check the batch walkthrough (201)
 * exists to catch, caught by machine first: it chains the seams together —
 * a REAL fake-Worker drain producing a `## QA Steps` Receipt, the attention
 * surface noticing the park, the detail source resolving Receipt-over-body,
 * a fail draft filed and linked, a simulated relaunch resuming from the
 * `qa/` pass file alone, a second pass going green, and the one-click
 * done-flip — all against one real git workbench sandbox, no LLM anywhere.
 *
 * Flows 2 (body-only precedence) and 6 (legacy checklist, no QA Steps block
 * anywhere) stand alone, since neither one is ever drained (per issue 195, a
 * HITL issue is never picked up by a drain Run) — chaining them onto the
 * assembled scenario above would misrepresent how they actually arise.
 *
 * Where the harness cannot express a step (a live OS clipboard, real
 * renderer DOM), the gap is declared `manual-only` at the bottom — never a
 * silent omission, per the issue.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIssueText, writeIssueText } from '../src/main/issue-file-store';
import { commitWorkbenchProject } from '../src/main/workbench-git';
import { readBacklogAt } from '../src/main/backlog-reader';
import { ChecklistStateStore } from '../src/main/checklist-state-store';
import {
  listQaPasses,
  loadQaSession,
  recordDoneFlip,
  recordFiledIssue,
  recordQaStepVerdict,
  startNewQaPass,
} from '../src/main/qa-session-store';
import { parseReceipt } from '../src/shared/receipt-parser';
import { deriveAttention } from '../src/shared/attention-hub-model';
import { parseChecklist, checklistSourceText, markVerifiedDoneText } from '../src/shared/checklist-model';
import { parseQaPass, qaPassFileName } from '../src/shared/qa-session-model';
import { resolveQaSteps } from '../src/shared/qa-steps-model';
import { buildQaDraftIssue, qaDraftBody, qaDraftTitle } from '../src/shared/qa-followup-model';
import { nextIssueNumber, padIssueNumber, quickFixFileName } from '../src/shared/launcher-model';
import {
  git,
  seedSandbox,
  seedWorkbenchSandbox,
  workbenchIssue,
  type Sandbox,
  type WorkbenchSandbox,
} from './sandbox';
import { runFakeWorker } from './fake-worker';

let wb: WorkbenchSandbox | null = null;
let legacy: Sandbox | null = null;
let userDataDir: string | null = null;

afterEach(async () => {
  if (wb) await rm(wb.scratch, { recursive: true, force: true });
  if (legacy) await rm(legacy.scratch, { recursive: true, force: true });
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  wb = null;
  legacy = null;
  userDataDir = null;
});

describe('assembled Guided QA — drain → session → actions → resume → green (issue 200)', () => {
  it('drains to a QA-Steps park, resolves the session, files a fail draft, resumes cold, then goes green and flips the source issue — all against one real workbench sandbox', async () => {
    wb = await seedWorkbenchSandbox();
    const issue = workbenchIssue(5); // 05-manual-check — HITL, repo `a`
    const fileName = `${issue.slug}.md`;
    const qaRoot = join(wb.issuesRoot, 'qa');

    // --- Flow 1: emission -> session -----------------------------------
    // A real fake-Worker drain, in workbench mode: claims in the WORKBENCH
    // issues root, does its code work in repo `a`, parks needs-verification
    // with a well-formed `## QA Steps` Receipt (issue 197's emission side).
    const trace = await runFakeWorker({
      repo: wb.repoA,
      issue,
      exit: 'needs-verification',
      qaSteps: true,
      workbench: { issuesRoot: wb.issuesRoot, completionsRoot: wb.completionsRoot },
    });
    expect(trace.receiptPath).not.toBeNull();
    await commitWorkbenchProject(wb.projectRoot, 'proj: issue 05 parked (needs-verification)');

    const receiptRaw = await readFile(trace.receiptPath!, 'utf8');
    const record = parseReceipt(receiptRaw);
    expect(record.outcome).toBe('needs-verification');

    let backlog = await readBacklogAt(wb.issuesRoot);
    let seeded = backlog.issues.find((i) => i.fileName === fileName);
    expect(seeded?.status).toBe('wip');
    expect(seeded?.hitl).toBe(true);

    // The park surfaces as attention — the SAME derivation the Inbox/rail use.
    const attention = deriveAttention({
      project: 'proj',
      backlog,
      receipts: [record],
      coreProposedPresent: false,
      humanSetup: null,
      journal: [],
      lastSeen: null,
    });
    const park = attention.items.find((i) => i.kind === 'hitl-park' && i.issueId === issue.id);
    expect(park).toBeDefined();

    // The detail source resolves Receipt-over-body (issue 196's precedence)
    // into a structured session, not the legacy checklist.
    const qaSteps = resolveQaSteps(record.detail, seeded?.body ?? null);
    expect(qaSteps?.kind).toBe('steps');
    if (qaSteps?.kind !== 'steps') throw new Error('unreachable');
    expect(qaSteps.steps.length).toBe(2);
    const stepCount = qaSteps.steps.length;

    // Record the FIRST step's verdict only — the session is still
    // `in-progress` (step 1 is unset; a single pass doesn't decide it).
    const partial = await recordQaStepVerdict(
      qaRoot,
      fileName,
      stepCount,
      0,
      { verdict: 'pass' },
      '2026-07-23T11:59:00.000Z',
    );
    expect(partial.verdict).toBe('in-progress');

    // --- Flow 4: resume from the qa/ pass file alone --------------------
    // Simulate the app being torn down and rebuilt: nothing but a fresh call
    // against the same qaRoot, no in-memory handle carried over from above.
    const resumed = await loadQaSession(qaRoot, fileName, stepCount, '2026-07-23T12:00:00.000Z');
    expect(resumed.pass).toBe(1);
    expect(resumed.verdict).toBe('in-progress');
    expect(resumed.results[0].verdict).toBe('pass');
    expect(resumed.results[1].verdict).toBe('unset');

    // --- Flow 3: fail -> prefilled draft, filed and linked --------------
    // The second step fails — a single fail decides the whole session,
    // regardless of the earlier pass.
    const failedPass = await recordQaStepVerdict(
      qaRoot,
      fileName,
      stepCount,
      1,
      { verdict: 'fail', note: 'The dialog never appeared — nothing happened on click.' },
      '2026-07-23T12:01:00.000Z',
    );
    expect(failedPass.verdict).toBe('failed');
    expect(failedPass.results[1].filedIssue).toBeNull();

    const step = qaSteps.steps[1];
    const draftTitle = qaDraftTitle(step);
    const draftBody = qaDraftBody({
      step,
      note: failedPass.results[1].note,
      sourceIssueFileName: fileName,
      qaPassFileName: qaPassFileName(fileName, failedPass.pass),
      receiptFileName: `${issue.slug}.md`,
    });
    expect(draftBody).toContain(step.expected);
    expect(draftBody).toContain('nothing happened on click');
    expect(draftBody).toContain(fileName);

    const existingBeforeDraft = await readdir(wb.issuesRoot);
    const draftId = nextIssueNumber(existingBeforeDraft);
    const draftFileName = quickFixFileName(draftId, draftTitle);
    await writeFile(
      join(wb.issuesRoot, draftFileName),
      buildQaDraftIssue({ id: draftId, title: draftTitle, body: draftBody }),
      { encoding: 'utf8', flag: 'wx' },
    );
    const draftCommit = await commitWorkbenchProject(
      wb.projectRoot,
      `proj: issue ${padIssueNumber(draftId)} filed from QA fail`,
    );
    expect(draftCommit.error).toBeNull();

    const filedPass = await recordFiledIssue(qaRoot, fileName, stepCount, 1, draftId, '2026-07-23T12:05:00.000Z');
    expect(filedPass.results[1].filedIssue).toBe(draftId);
    // Filing is bookkeeping only — the fail verdict itself doesn't change.
    expect(filedPass.verdict).toBe('failed');

    backlog = await readBacklogAt(wb.issuesRoot);
    const draft = backlog.issues.find((i) => i.fileName === draftFileName);
    expect(draft?.status).toBe('open');
    expect(draft?.standalone).toBe(true);

    // --- Flow 5: green path -> one-click done-flip ----------------------
    // The prior pass is decided (failed) — re-QA explicitly starts pass 2,
    // never touching pass 1's file.
    const pass2 = await startNewQaPass(qaRoot, fileName, stepCount, '2026-07-23T12:10:00.000Z');
    expect(pass2.pass).toBe(2);
    await recordQaStepVerdict(qaRoot, fileName, stepCount, 0, { verdict: 'pass' }, '2026-07-23T12:11:00.000Z');
    const greenPass = await recordQaStepVerdict(
      qaRoot,
      fileName,
      stepCount,
      1,
      { verdict: 'pass' },
      '2026-07-23T12:12:00.000Z',
    );
    expect(greenPass.pass).toBe(2);
    expect(greenPass.verdict).toBe('green');
    expect(greenPass.doneFlipped).toBe(false);

    // The flip: the same parser-validated write path issue 89's editor uses.
    const read = await readIssueText(wb.issuesRoot, fileName);
    expect(read.content).not.toBeNull();
    const updated = markVerifiedDoneText(read.content ?? '', '2026-07-23');
    expect(updated).not.toBeNull();
    const write = await writeIssueText(wb.issuesRoot, fileName, updated ?? '');
    expect(write.ok).toBe(true);
    const flipCommit = await commitWorkbenchProject(wb.projectRoot, `proj: issue ${padIssueNumber(issue.id)} edited`);
    expect(flipCommit.error).toBeNull();

    const flippedPass = await recordDoneFlip(qaRoot, fileName, stepCount, '2026-07-23T12:13:00.000Z');
    expect(flippedPass.doneFlipped).toBe(true);
    expect(flippedPass.verdict).toBe('green');

    backlog = await readBacklogAt(wb.issuesRoot);
    seeded = backlog.issues.find((i) => i.fileName === fileName);
    expect(seeded?.status).toBe('done');

    const log = await git(wb.projectRoot, 'log', '--oneline', '-n', '5');
    expect(log).toMatch(new RegExp(`issue ${padIssueNumber(issue.id)} edited`));

    // qa/ holds BOTH pass files, and pass 1 is untouched by the re-QA/flip.
    const passes = await listQaPasses(qaRoot, fileName);
    expect(passes.map((p) => p.pass).sort()).toEqual([1, 2]);
    const pass1OnDisk = parseQaPass(
      await readFile(join(qaRoot, qaPassFileName(fileName, 1)), 'utf8'),
    );
    expect(pass1OnDisk?.verdict).toBe('failed');
    expect(pass1OnDisk?.results[0].verdict).toBe('pass');
    expect(pass1OnDisk?.results[1].filedIssue).toBe(draftId);
    expect(pass1OnDisk?.doneFlipped).toBe(false);
  });
});

describe('body-only precedence — never drained (issue 200, flow 2)', () => {
  it('a HITL issue with a QA Steps block in its body and no Receipt still resolves a structured session, surfaced as hitl-ready (not hitl-park)', async () => {
    legacy = await seedSandbox();
    const { repo, issuesDir } = legacy;
    const fileName = '09-never-drained-hitl.md';
    const body = [
      '## QA Steps',
      '',
      '- Action: Open the launcher and click New Project.',
      '  Expected: A project picker dialog appears.',
      '  Command: npm run dev',
      '',
      '- Action: Confirm the created project appears in the list.',
      '  Expected: The new project card is visible.',
      '',
    ].join('\n');
    await writeFile(
      join(issuesDir, fileName),
      `---\nstatus: open\ndepends_on: []\nhitl: true\n---\n\n# 9 — never-drained-hitl\n\n${body}`,
    );
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'seed: body-only QA Steps HITL issue');

    const backlog = await readBacklogAt(issuesDir);
    const issue = backlog.issues.find((i) => i.fileName === fileName);
    expect(issue?.hitl).toBe(true);
    expect(issue?.status).toBe('open');

    // No Receipt anywhere for this issue — per issue 195, a HITL issue is
    // never picked up by a drain Run, so this is the only shape it ever has.
    const result = resolveQaSteps(null, issue?.body ?? null);
    expect(result?.kind).toBe('steps');
    if (result?.kind === 'steps') {
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].command).toBe('npm run dev');
    }

    const attention = deriveAttention({
      project: 'sandbox',
      backlog,
      receipts: [],
      coreProposedPresent: false,
      humanSetup: null,
      journal: [],
      lastSeen: null,
    });
    // Ready (never parked — there is no Run/Receipt at all), not hitl-park.
    expect(attention.items.some((i) => i.kind === 'hitl-ready' && i.issueId === 9)).toBe(true);
    expect(attention.items.some((i) => i.kind === 'hitl-park' && i.issueId === 9)).toBe(false);
  });
});

describe('legacy mode — no QA Steps block anywhere (issue 200, flow 6)', () => {
  it('a parked issue whose Receipt carries no QA Steps block renders the 156 checklist, and ticking it never creates anything under qa/ nor offers a flip', async () => {
    wb = await seedWorkbenchSandbox();
    userDataDir = await mkdtemp(join(tmpdir(), 'mc-guided-qa-e2e-'));
    const fileName = '90-legacy-checklist-hitl.md';
    const issueText = `---\nstatus: wip\ndepends_on: []\nhitl: true\n---\n\n# 90 — legacy-checklist-hitl\n\nScripted parked HITL issue with no QA Steps block.\n`;
    const receiptText = `---\nissue: 90\nslug: legacy-checklist-hitl\noutcome: needs-verification\nfinished: 2026-07-23T12:00:00Z\n---\n## Ready for manual verification — issue 90 — legacy-checklist-hitl\n\n**Verification steps**\n\n- [ ] Open the Map and select the parked issue.\n- [ ] Tick each checklist step as you complete it.\n- [ ] Confirm "Mark verified & done" appears once all steps are checked.\n`;

    await writeFile(join(wb.issuesRoot, fileName), issueText);
    await mkdir(wb.completionsRoot, { recursive: true });
    await writeFile(join(wb.completionsRoot, 'legacy-checklist-hitl.md'), receiptText);
    await git(wb.projectRoot, 'add', '.');
    await git(wb.projectRoot, 'commit', '-m', 'seed: legacy (no QA Steps) parked HITL issue');

    const backlog = await readBacklogAt(wb.issuesRoot);
    const seeded = backlog.issues.find((i) => i.fileName === fileName);
    const receipt = parseReceipt(receiptText);

    // No `## QA Steps` heading anywhere -> resolveQaSteps reports null, so
    // the Map falls back to the 156 checklist, unaffected by Guided QA.
    expect(resolveQaSteps(receipt.detail, seeded?.body ?? null)).toBeNull();

    const source = checklistSourceText(receipt.detail, seeded?.body ?? null);
    const items = parseChecklist(source);
    expect(items).toHaveLength(3);

    const store = new ChecklistStateStore(userDataDir);
    await store.load();
    for (let i = 0; i < items.length; i++) {
      await store.toggle(wb.projectRoot, fileName, i, items.length);
    }
    expect(store.get(wb.projectRoot, fileName, items.length)).toEqual([true, true, true]);

    // Legacy mode never touches qa/ — no session file appears there at all.
    let qaDirEntries: string[] = [];
    try {
      qaDirEntries = await readdir(join(wb.issuesRoot, 'qa'));
    } catch {
      qaDirEntries = [];
    }
    expect(qaDirEntries).toEqual([]);

    // ...and it offers no flip: the issue stays exactly wip until the human
    // takes the separate, explicit "Mark verified & done" checklist action.
    const after = await readBacklogAt(wb.issuesRoot);
    expect(after.issues.find((i) => i.fileName === fileName)?.status).toBe('wip');
  });
});

describe('manual-only — needs a live clipboard or the real renderer DOM (declared, not silently skipped)', () => {
  it.skip('manual-only: a QA step whose action is "copy X to the clipboard" is verified by actually reading the OS clipboard — reason: the harness has no clipboard to read/write; the step still parses/renders/records a verdict exactly like any other step, exercised above', () => {});
  it.skip('manual-only: the Map\'s Guided QA detail panel visually swaps in over the 156 checklist, and its pass/fail buttons + note textarea + draft/flip confirm dialogs render and wire clicks to the handlers exercised above — reason: renderer DOM; the precedence, verdicts, draft/flip fs edges, and resume are asserted at module level in the scenarios above', () => {});
});
