/**
 * E2E guides harness (issue 85, ADR-0016) — the "MC guides" batch's seams,
 * machine-before-human: real modules against real infrastructure (temp git
 * workbenches, real fs watchers, real timers, the real hook script), scripted
 * fake Workers, no LLM anywhere. Runs beside the legacy and workbench
 * harnesses in the same `npm run test:e2e`.
 *
 * Scenarios map 1:1 to issue 85's list:
 *   a. Attention pipeline — TWO temp workbench projects, neither "open"
 *      anywhere: an HITL park (linger fake Worker), a CORE.proposed.md, a
 *      blocked Receipt, and a gating HUMAN-SETUP box all surface as aggregated
 *      items with stable ids; the mark-seen → briefing-drop cycle (issue 80's
 *      hook) runs; resolving each artifact clears its item; a REGISTRY EDIT
 *      reconciles the watch set live on the same instance (reverting issue
 *      79's watch-reconcile turns that case red); and the watcher wrote
 *      NOTHING to either workbench (asserted via git).
 *   b. Quick fix — the Launcher's issue-writer at module level: sentence in →
 *      a well-formed standalone issue (round-tripped through the real backlog
 *      model), the correct next number (twice), auto-committed via the real
 *      workbench-commit path → a fake-Worker Run completes it → Receipt in the
 *      ONE completions root + exactly one completion card through the real
 *      pump.
 *   c. Onboarding — `createWorkbenchProject` against a temp workbench:
 *      project skeleton + registry entries + ONE boring commit; the new
 *      project resolves by BOTH handles (workbench dir and member-repo path,
 *      nested cwd included); collisions are refused with every problem named
 *      and write nothing; dryRun writes nothing.
 *   d. Planning preview — the watched-set derivation + recency ordering
 *      against REAL file churn (workbench PRDs/issues, repo CONTEXT.md and a
 *      docs/adr/ that appears after the watch attached); Receipts/memory
 *      churn never re-push. The Pane/skill-typing half is declared
 *      manual-only, per the issue.
 *   e. Hook script — issue 84's `~/Workbench/tools/session-warm-start.sh`
 *      (present in the workbench even before the human applies the settings
 *      change) run against fixture registries: registered (argv, nested cwd,
 *      and stdin-JSON payload), unregistered, inactive, malformed/missing
 *      registry, whitespace-only CORE, and the ~1.5k-token cap with its
 *      explicit truncation marker. Silence and exit 0 in every failure mode.
 *
 * Live-shell / real-claude residue is declared `manual-only` at the bottom
 * (as named, skipped specs) — zero silent gaps. Run this suite BEFORE
 * walkthrough 86.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AttentionWatcher } from '../src/main/attention-watcher';
import { AttentionLastSeenStore } from '../src/main/attention-last-seen';
import { PlanningWatcher } from '../src/main/planning-watcher';
import { createWorkbenchProject } from '../src/main/onboarding';
import { commitWorkbenchProject } from '../src/main/workbench-git';
import { readBacklogAt } from '../src/main/backlog-reader';
import { ReceiptWatcher } from '../src/main/receipt-watcher';
import { resolveOpenedProject } from '../src/shared/project-identity';
import { splitInbox } from '../src/shared/inbox-model';
import {
  buildQuickFixIssue,
  nextIssueNumber,
  padIssueNumber,
  projectStateLine,
  quickFixFileName,
} from '../src/shared/launcher-model';
import {
  renderCompletionEvent,
  toCompletionEvent,
} from '../src/shared/dispatcher-input-contract';
import { createDispatcherPump } from '../src/shared/dispatcher-pump';
import { narrativeKeyFor } from '../src/shared/dispatcher-narrative';
import { parseReceipt } from '../src/shared/receipt-parser';
import type { PlanningDoc } from '../src/shared/planning-model';
import type { AttentionSnapshot, RunLogRecord } from '../src/shared/ipc-contract';
import {
  FakePty,
  WORKBENCH_CORE_FACT,
  git,
  issueFileContent,
  seedWorkbenchSandbox,
  sleep,
  waitFor,
  type SandboxIssue,
  type WorkbenchSandbox,
} from './sandbox';
import { runFakeWorker } from './fake-worker';

const exec = promisify(execFile);

/** Watcher debounce for the scenarios below (real timers, kept short). */
const DEBOUNCE = 40;

let wb: WorkbenchSandbox;

beforeEach(async () => {
  wb = await seedWorkbenchSandbox();
});

afterEach(async () => {
  await rm(wb.scratch, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Scenario (a) fixture — a SECOND temp workbench with two projects, neither of
// which is "open" in any Window (there is no Window at all): the background
// attention watch alone drives everything.
// -----------------------------------------------------------------------------

const ALPHA_HITL: SandboxIssue = {
  id: 5,
  slug: '05-manual-check',
  title: 'Manual check (HITL)',
  status: 'open',
  dependsOn: [],
  hitl: true,
};
const ALPHA_BLOCKED: SandboxIssue = {
  id: 7,
  slug: '07-flaky-build',
  title: 'Flaky build',
  status: 'open',
  dependsOn: [],
  hitl: false,
};
const BETA_GATED: SandboxIssue = {
  id: 2,
  slug: '02-token-consumer',
  title: 'Token consumer',
  status: 'open',
  dependsOn: [],
  hitl: false,
};

/** The registry content — `betaActive` drives the live-reconcile case. */
function attentionRegistry(betaActive: boolean): string {
  return (
    `# Registry\n\n` +
    `- repo: /fake/repos/alpha\n  project: alpha\n  status: active\n` +
    `- repo: /fake/repos/beta\n  project: beta\n  status: ${betaActive ? 'active' : 'inactive'}\n`
  );
}

interface AttentionFixture {
  /** The two-project workbench git root. */
  root: string;
  /** A plain scratch dir the fake Workers use as their code cwd. */
  work: string;
}

async function seedAttentionWorkbench(scratch: string): Promise<AttentionFixture> {
  const root = join(scratch, 'attention-workbench');
  for (const project of ['alpha', 'beta']) {
    await mkdir(join(root, project, 'issues'), { recursive: true });
    await mkdir(join(root, project, 'memory', 'journal'), { recursive: true });
    await writeFile(join(root, project, 'memory', 'CORE.md'), `- ${project} core fact\n`);
  }
  await writeFile(
    join(root, 'alpha', 'issues', `${ALPHA_HITL.slug}.md`),
    issueFileContent(ALPHA_HITL, 'open'),
  );
  await writeFile(
    join(root, 'alpha', 'issues', `${ALPHA_BLOCKED.slug}.md`),
    issueFileContent(ALPHA_BLOCKED, 'open'),
  );
  await writeFile(
    join(root, 'beta', 'issues', `${BETA_GATED.slug}.md`),
    issueFileContent(BETA_GATED, 'open'),
  );
  await writeFile(join(root, 'registry.md'), attentionRegistry(true));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'e2e@example.com');
  await git(root, 'config', 'user.name', 'MC Guides E2E');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial: seeded attention workbench');
  const work = join(scratch, 'attention-work');
  await mkdir(work, { recursive: true });
  return { root, work };
}

describe('e2e guides harness — real modules over the guides-batch seams', () => {
  // ---------------------------------------------------------------------------
  // Scenario a — the attention pipeline end to end: plant → items with stable
  // ids → mark-seen drops the briefing → resolve → items disappear → registry
  // edit reconciles the watch live → zero workbench writes.
  // ---------------------------------------------------------------------------
  it('Scenario a: attention pipeline — planted artifacts in two unopened projects surface, resolve, and reconcile on registry edits; the watcher writes nothing', async () => {
    const fx = await seedAttentionWorkbench(wb.scratch);
    const alphaPaths = {
      issuesRoot: join(fx.root, 'alpha', 'issues'),
      completionsRoot: join(fx.root, 'alpha', 'completions'),
    };

    // The briefing's last-seen stamps live in app userData — OUTSIDE any
    // workbench (ADR-0016: reading the Inbox must never create commits).
    const userData = join(wb.scratch, 'userdata');
    const store = new AttentionLastSeenStore(userData);
    await store.load();

    const pushes: AttentionSnapshot[] = [];
    const watcher = new AttentionWatcher({
      workbenchRoot: fx.root,
      debounceMs: DEBOUNCE,
      onChange: (s) => pushes.push(s),
      lastSeenFor: (project) => store.get(project),
    });
    const ids = (): string[] => watcher.snapshot.items.map((i) => i.id);

    try {
      watcher.start();
      await waitFor(() => watcher.size === 2, 'both project watches attached');
      expect(watcher.watchedProjects).toEqual(['alpha', 'beta']);
      await sleep(DEBOUNCE * 3); // let the initial (empty) derives settle

      // Plant all four attention kinds + a journal entry. The HITL park comes
      // from a REAL fake Worker in linger mode: it writes its park (wip flip +
      // needs-verification Receipt) and keeps its session alive, exactly like
      // a claude Pane sitting at its prompt.
      const park = await runFakeWorker({
        repo: fx.work,
        issue: ALPHA_HITL,
        exit: 'needs-verification',
        linger: true,
        workbench: alphaPaths,
      });
      expect(park.sessionAlive).toBe(true);
      await runFakeWorker({
        repo: fx.work,
        issue: ALPHA_BLOCKED,
        exit: 'blocked',
        linger: true,
        workbench: alphaPaths,
      });
      await writeFile(join(fx.root, 'beta', 'memory', 'CORE.proposed.md'), '# proposed CORE\n');
      await writeFile(
        join(fx.root, 'beta', 'HUMAN-SETUP.md'),
        '# Human setup\n\n- [ ] Create the fixture API token. Unblocks: 02.\n',
      );
      await writeFile(
        join(fx.root, 'alpha', 'memory', 'journal', '2026-07-04.md'),
        '# 2026-07-04 — drain\n\n- Ended: 2026-07-04T18:00:00Z\n- Reason: no eligible issue remains\n- 02-x: completed\n',
      );

      // All five items aggregate with STABLE ids, projects ascending, each
      // project's items in the pure model's order.
      await waitFor(() => ids().length === 5, 'all five attention items derived');
      const gate = watcher.snapshot.items.find((i) => i.kind === 'setup-gate');
      expect(gate).toBeDefined();
      expect(gate!.id).toMatch(/^beta:setup-gate:/);
      expect(gate!.issueId).toBe(2); // it names the OPEN issue it gates
      expect(ids()).toEqual([
        'alpha:hitl-park:5',
        'alpha:blocked-run:7',
        'alpha:briefing:2026-07-04.md',
        'beta:curator-proposal',
        gate!.id,
      ]);

      // Issue 80's Inbox split reads the same snapshot: briefing separate,
      // actionable items grouped per project.
      const view = splitInbox(watcher.snapshot.items);
      expect(view.briefing.map((i) => i.id)).toEqual(['alpha:briefing:2026-07-04.md']);
      expect(view.groups.map((g) => g.project)).toEqual(['alpha', 'beta']);

      // Stable across re-derivation: same inputs → same ids, same order.
      const before = ids();
      watcher.rederiveAll();
      await sleep(DEBOUNCE * 3);
      expect(ids()).toEqual(before);

      // Commit the TEST's plants: from here on, any workbench dirt or commit
      // would have to be the watcher's — and it makes none.
      await git(fx.root, 'add', '-A');
      await git(fx.root, 'commit', '-m', 'test: plant attention artifacts');

      // The mark-seen → briefing-drop cycle (issue 80's wired hook): advance
      // the stamps, re-derive with NO fs change, and the briefing drops while
      // every actionable item survives.
      await store.markAll(watcher.watchedProjects, new Date().toISOString());
      watcher.rederiveAll();
      await waitFor(
        () => !ids().includes('alpha:briefing:2026-07-04.md'),
        'briefing dropped after mark-seen',
      );
      expect(ids()).toEqual([
        'alpha:hitl-park:5',
        'alpha:blocked-run:7',
        'beta:curator-proposal',
        gate!.id,
      ]);

      // Resolve each artifact → its item disappears (gone means gone).
      await writeFile(
        join(fx.root, 'alpha', 'issues', `${ALPHA_HITL.slug}.md`),
        issueFileContent(ALPHA_HITL, 'done'),
      );
      await waitFor(() => !ids().includes('alpha:hitl-park:5'), 'the park item to clear');
      await writeFile(
        join(fx.root, 'alpha', 'issues', `${ALPHA_BLOCKED.slug}.md`),
        issueFileContent(ALPHA_BLOCKED, 'done'),
      );
      await waitFor(() => !ids().includes('alpha:blocked-run:7'), 'the blocked item to clear');
      await unlink(join(fx.root, 'beta', 'memory', 'CORE.proposed.md'));
      await waitFor(() => !ids().includes('beta:curator-proposal'), 'the proposal item to clear');
      await writeFile(
        join(fx.root, 'beta', 'HUMAN-SETUP.md'),
        '# Human setup\n\n- [x] Create the fixture API token. Unblocks: 02.\n',
      );
      await waitFor(() => ids().length === 0, 'all items resolved');
      await git(fx.root, 'add', '-A');
      await git(fx.root, 'commit', '-m', 'test: resolve attention artifacts');

      // The registry-change case (issue 79's watch-reconcile — reverting it
      // turns this red): DEACTIVATING beta detaches its watch on the same
      // instance, no restart…
      await writeFile(join(fx.root, 'registry.md'), attentionRegistry(false));
      await waitFor(
        () => watcher.watchedProjects.length === 1,
        'beta watch detached on registry edit',
      );
      expect(watcher.watchedProjects).toEqual(['alpha']);

      // …an unwatched project's artifacts derive nothing…
      await writeFile(join(fx.root, 'beta', 'memory', 'CORE.proposed.md'), '# proposed again\n');
      await sleep(DEBOUNCE * 4);
      expect(ids()).toEqual([]);

      // …and REACTIVATING attaches the watch, whose initial derivation picks
      // up what is already on disk.
      await writeFile(join(fx.root, 'registry.md'), attentionRegistry(true));
      await waitFor(
        () => ids().includes('beta:curator-proposal'),
        'the reactivated project item to surface',
      );
      expect(watcher.watchedProjects).toEqual(['alpha', 'beta']);
      await unlink(join(fx.root, 'beta', 'memory', 'CORE.proposed.md'));
      await waitFor(() => ids().length === 0, 'the reactivated item to clear');

      // READ-ONLY BY CONTRACT: the whole cycle left the workbench byte-
      // identical to the test's own writes — nothing dirty, and the log holds
      // exactly the seed + the two test commits (the watcher committed none).
      expect((await git(fx.root, 'status', '--porcelain')).trim()).toBe('');
      expect((await git(fx.root, 'log', '--reverse', '--pretty=%s')).trim().split('\n')).toEqual([
        'initial: seeded attention workbench',
        'test: plant attention artifacts',
        'test: resolve attention artifacts',
      ]);

      // The last-seen stamp landed in app userData, never in the workbench.
      expect(existsSync(join(userData, 'attention-last-seen.json'))).toBe(true);
      expect(existsSync(join(fx.root, 'attention-last-seen.json'))).toBe(false);
    } finally {
      watcher.close();
    }
    expect(watcher.size).toBe(0); // clean teardown — no watcher leaks
  });

  // ---------------------------------------------------------------------------
  // Scenario b — the Launcher's quick fix at module level: the same seam the
  // `quickfix:create` handler composes (readdir → nextIssueNumber → wx write →
  // workbench commit), then a scripted Worker Run completing the new issue
  // into a Receipt + one completion card.
  // ---------------------------------------------------------------------------
  it('Scenario b: quick fix — sentence → standalone issue with the correct next number, auto-committed; a fake-Worker Run completes it → Receipt + card', async () => {
    const watcher = new ReceiptWatcher({ debounceMs: DEBOUNCE, stabilityMs: 25 });
    try {
      const records: RunLogRecord[] = [];
      const seen = new Map<string, string | null>();
      watcher.watch('quickfix', [wb.projectRoot], seen, (r) => records.push(r));

      // The handler's write loop (main/index.ts, issue 81): re-list, take the
      // next number, `wx`-write (never clobber; EEXIST re-numbers), then the
      // issue-72 workbench auto-commit.
      const createQuickFix = async (sentence: string): Promise<{ id: number; fileName: string }> => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const existing = await readdir(wb.issuesRoot);
          const id = nextIssueNumber(existing);
          const fileName = quickFixFileName(id, sentence);
          try {
            await writeFile(
              join(wb.issuesRoot, fileName),
              buildQuickFixIssue({ id, sentence, date: '2026-07-05' }),
              { encoding: 'utf8', flag: 'wx' },
            );
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
          }
          const commit = await commitWorkbenchProject(
            wb.projectRoot,
            `proj: issue ${padIssueNumber(id)} quick fix`,
          );
          expect(commit.error).toBeNull();
          expect(commit.committed).toBe(true);
          return { id, fileName };
        }
        throw new Error('no free issue number after 5 attempts — a test bug');
      };

      const sentence = 'Add a --version flag to the CLI';
      const first = await createQuickFix(sentence);
      expect(first.id).toBe(9); // one past the seeded 01–08 backlog, gapless
      expect(first.fileName).toBe('09-add-a-version-flag-to-the.md');

      // Well-formed and STANDALONE: it round-trips through the REAL backlog
      // model exactly as afk-eligible fallthrough work.
      const backlog = await readBacklogAt(wb.issuesRoot);
      const issue = backlog.issues.find((i) => i.id === 9);
      expect(issue).toBeDefined();
      expect(issue!.status).toBe('open');
      expect(issue!.standalone).toBe(true);
      expect(issue!.parent).toBeNull();
      expect(issue!.dependsOn).toEqual([]);
      expect(issue!.hitl).toBe(false);
      expect(issue!.source).toContain('Launcher quick fix');
      expect(issue!.title).toContain(sentence);

      // Auto-committed: one boring workbench commit, scoped to the new file.
      expect((await git(wb.workbenchRoot, 'log', '-1', '--pretty=%s')).trim()).toBe(
        'proj: issue 09 quick fix',
      );
      const touched = (
        await git(wb.workbenchRoot, 'show', '--name-only', '--pretty=format:', 'HEAD')
      )
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(touched).toEqual(['proj/issues/09-add-a-version-flag-to-the.md']);

      // A second quick fix takes the NEXT number — numbers are history, never
      // reused — and lands its own commit, leaving the workbench clean.
      const second = await createQuickFix('Rename the config file');
      expect(second.id).toBe(10);
      expect((await git(wb.workbenchRoot, 'log', '-1', '--pretty=%s')).trim()).toBe(
        'proj: issue 10 quick fix',
      );
      expect((await git(wb.workbenchRoot, 'status', '--porcelain')).trim()).toBe('');

      // A scripted Worker Run completes the quick-fix issue: claim flip and
      // Receipt in the WORKBENCH, code work in the default repo.
      const quickIssue: SandboxIssue = {
        id: 9,
        slug: '09-add-a-version-flag-to-the',
        title: sentence,
        status: 'open',
        dependsOn: [],
        hitl: false,
      };
      const trace = await runFakeWorker({
        repo: wb.repoA,
        issue: quickIssue,
        exit: 'completed',
        workbench: { issuesRoot: wb.issuesRoot, completionsRoot: wb.completionsRoot },
      });
      expect(trace.cwd).toBe(wb.repoA);

      // The Receipt lands in the ONE workbench completions root and ingests
      // live (with the FSEvents-drop re-point fallback the other harnesses use).
      const ingested = (): boolean => records.some((r) => r.issueId === 9);
      for (let attempt = 0; attempt < 3 && !ingested(); attempt++) {
        try {
          await waitFor(ingested, 'quick-fix receipt ingested', 1500);
        } catch {
          watcher.watch(`quickfix-rescan-${attempt}`, [wb.projectRoot], seen, (r) =>
            records.push(r),
          );
        }
      }
      await waitFor(ingested, 'quick-fix receipt ingested (after re-point scans)', 2000);
      const rec = records.find((r) => r.issueId === 9)!;
      expect(rec.outcome).toBe('completed');
      const receiptPath = join(wb.completionsRoot, '09-add-a-version-flag-to-the.md');
      expect(existsSync(receiptPath)).toBe(true);
      expect(parseReceipt(await readFile(receiptPath, 'utf8')).outcomeSource).toBe('declared');

      // …and drives exactly ONE completion card through the real pump
      // (identity-keyed dedupe holds).
      const pty = new FakePty();
      pty.create('dispatcher');
      const pump = createDispatcherPump({ write: pty.write, canFlush: () => true });
      pump.attachSession('dispatcher');
      const card = renderCompletionEvent(toCompletionEvent({ id: rec.id, record: rec }));
      expect(pump.enqueue({ key: narrativeKeyFor(rec.id), text: card })).toBe(true);
      expect(pump.enqueue({ key: narrativeKeyFor(rec.id), text: card })).toBe(false);
      await waitFor(() => pump.pending() === 0, 'the completion card delivered');
      const messages = pty.submittedMessages('dispatcher');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Completion block for issue 09 (completed)');

      // Ground truth: the quick-fix issue is done, and Continue's truthful
      // state line reads the resulting backlog correctly (8 open: the seeded
      // 02–08 plus quick fix 10; 01 and 09 done; nothing parked).
      const after = await readBacklogAt(wb.issuesRoot);
      expect(after.issues.find((i) => i.id === 9)?.status).toBe('done');
      const counts = { open: 0, wip: 0, done: 0 };
      for (const i of after.issues) counts[i.status] += 1;
      const parked = after.issues.filter((i) => i.hitl && i.status === 'wip').length;
      expect(projectStateLine(counts, parked)).toBe('8 open');
    } finally {
      watcher.closeAll();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario c — onboarding: the wizard's setup function (main/onboarding.ts,
  // injection points and all) against the temp workbench.
  // ---------------------------------------------------------------------------
  it('Scenario c: onboarding — project + registry + ONE commit created; resolution works by both handles; collisions refused write nothing', async () => {
    // A fresh "home" so tilde contraction/expansion is exercised end to end.
    const home = join(wb.scratch, 'home');
    const newRepo = join(home, 'Developer', 'new-tool-repo');
    await mkdir(join(newRepo, 'src'), { recursive: true });
    await git(newRepo, 'init', '-b', 'main');
    await git(newRepo, 'config', 'user.email', 'e2e@example.com');
    await git(newRepo, 'config', 'user.name', 'MC Guides E2E');
    await git(newRepo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(newRepo, 'README.md'), '# new tool\n');
    await git(newRepo, 'add', '.');
    await git(newRepo, 'commit', '-m', 'initial: seed new-tool-repo');

    const registryPath = join(wb.workbenchRoot, 'registry.md');
    const registryBefore = await readFile(registryPath, 'utf8');
    const commitsBefore = Number((await git(wb.workbenchRoot, 'rev-list', '--count', 'HEAD')).trim());
    const input = {
      workbenchRoot: wb.workbenchRoot,
      homeDir: home,
      name: 'New Tool',
      repos: [{ key: 'tool', path: newRepo }],
    };

    // dryRun validates the plan and writes NOTHING.
    const dry = await createWorkbenchProject({ ...input, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dirName).toBe('new-tool');
    expect(existsSync(join(wb.workbenchRoot, 'new-tool'))).toBe(false);
    expect(await readFile(registryPath, 'utf8')).toBe(registryBefore);

    // The real create: the full ADR-0015 skeleton…
    const created = await createWorkbenchProject(input);
    expect(created.ok).toBe(true);
    expect(created.errors).toEqual([]);
    const projectRoot = join(wb.workbenchRoot, 'new-tool');
    expect(created.workbenchDir).toBe(projectRoot);
    for (const piece of [
      'CONFIG.md',
      'issues',
      'completions',
      join('memory', 'CORE.md'),
      join('memory', 'journal'),
      join('memory', 'topics'),
    ]) {
      expect(existsSync(join(projectRoot, piece)), `skeleton piece ${piece}`).toBe(true);
    }
    expect(await readFile(join(projectRoot, 'memory', 'CORE.md'), 'utf8')).toBe('');

    // …the registry entry (house tilde style, active, priors preserved)…
    const registryAfter = await readFile(registryPath, 'utf8');
    expect(registryAfter).toContain(wb.repoA); // prior entries untouched
    expect(registryAfter).toContain('project: new-tool');
    expect(registryAfter).toContain('~/Developer/new-tool-repo');

    // …and ONE boring commit scoped to the new project dir + registry.md.
    expect(Number((await git(wb.workbenchRoot, 'rev-list', '--count', 'HEAD')).trim())).toBe(
      commitsBefore + 1,
    );
    expect((await git(wb.workbenchRoot, 'log', '-1', '--pretty=%s')).trim()).toBe(
      'new-tool: project onboarded',
    );
    const touched = (
      await git(wb.workbenchRoot, 'show', '--name-only', '--pretty=format:', 'HEAD')
    )
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((p) => p.startsWith('new-tool/') || p === 'registry.md')).toBe(true);
    expect((await git(wb.workbenchRoot, 'status', '--porcelain')).trim()).toBe('');

    // Resolution works by BOTH handles — the workbench dir and the member
    // repo path (nested cwd included) — through the same identity layer the
    // open flow uses, with the tilde'd CONFIG/registry paths expanding back.
    const configContent = await readFile(join(projectRoot, 'CONFIG.md'), 'utf8');
    const locate = (openedPath: string) =>
      resolveOpenedProject(
        {
          openedPath,
          registryContent: registryAfter,
          workbenchRoot: wb.workbenchRoot,
          homeDir: home,
        },
        configContent,
      );
    const byDir = locate(projectRoot);
    expect(byDir.kind).toBe('workbench');
    expect(byDir.key).toBe(projectRoot);
    expect(byDir.issuesRoot).toBe(join(projectRoot, 'issues'));
    expect(byDir.defaultRepoPath).toBe(newRepo);
    expect(locate(newRepo).key).toBe(projectRoot);
    expect(locate(join(newRepo, 'src')).key).toBe(projectRoot);

    // Collisions refused, EVERY problem named at once: an existing project
    // name, a repo already registered to another project, and both together.
    const refusedName = await createWorkbenchProject({
      ...input,
      name: 'proj',
      repos: [{ key: 'x', path: join(home, 'not-yet-created') }],
    });
    expect(refusedName.ok).toBe(false);
    expect(refusedName.errors.join(' ')).toContain('proj');

    const refusedRepo = await createWorkbenchProject({
      ...input,
      name: 'Another Tool',
      repos: [{ key: 'a', path: wb.repoA }],
    });
    expect(refusedRepo.ok).toBe(false);
    expect(refusedRepo.errors.join(' ')).toContain('proj'); // names the owner

    const refusedAll = await createWorkbenchProject({
      ...input,
      name: 'proj',
      repos: [
        { key: 'dup', path: wb.repoB },
        { key: 'dup', path: wb.repoB },
      ],
    });
    expect(refusedAll.ok).toBe(false);
    expect(refusedAll.errors.length).toBeGreaterThanOrEqual(3); // name + key + path

    // Refusals wrote NOTHING: no dir, registry byte-identical, no commit.
    expect(existsSync(join(wb.workbenchRoot, 'another-tool'))).toBe(false);
    expect(await readFile(registryPath, 'utf8')).toBe(registryAfter);
    expect(Number((await git(wb.workbenchRoot, 'rev-list', '--count', 'HEAD')).trim())).toBe(
      commitsBefore + 1,
    );
    expect((await git(wb.workbenchRoot, 'status', '--porcelain')).trim()).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Scenario d — the Planning view's live preview data: watched-set derivation
  // + recency ordering against REAL file churn through the real watcher. The
  // Pane/skill-typing half is declared manual-only below, per the issue.
  // ---------------------------------------------------------------------------
  it('Scenario d: planning preview — the watched set derives from real churn, newest change first; Receipts/memory churn never re-push', async () => {
    const pw = new PlanningWatcher({ debounceMs: DEBOUNCE });
    const pushes: PlanningDoc[][] = [];
    const latest = (): PlanningDoc[] => pushes[pushes.length - 1] ?? [];
    try {
      pw.watch('win1', { workbenchDir: wb.projectRoot, repoPath: wb.repoA }, (docs) =>
        pushes.push(docs),
      );

      // The initial push arrives without any change: workbench top-level .md
      // (CONFIG) + the 8 issue files; repo-a has no CONTEXT.md or docs/adr yet;
      // completions/ and memory/ are never planning docs.
      await waitFor(() => pushes.length >= 1, 'the initial planning doc list');
      const initial = latest();
      expect(initial.map((d) => d.label)).toContain('CONFIG.md');
      expect(initial.filter((d) => d.group === 'issue')).toHaveLength(8);
      expect(initial.some((d) => d.label === 'CONTEXT.md')).toBe(false);
      expect(
        initial.some((d) => d.path.includes('/completions/') || d.path.includes('/memory/')),
      ).toBe(false);

      // A PRD being written floats to the top — the live-writing view.
      await writeFile(join(wb.projectRoot, 'PRD.md'), '# PRD\n\nDraft.\n');
      await waitFor(() => latest()[0]?.label === 'PRD.md', 'PRD.md at the top');
      expect(latest()[0].group).toBe('workbench');

      // Repo docs join the watched set: CONTEXT.md…
      await writeFile(join(wb.repoA, 'CONTEXT.md'), '# Context\n');
      await waitFor(() => latest()[0]?.label === 'CONTEXT.md', 'CONTEXT.md at the top');
      expect(latest()[0].group).toBe('repo');

      // …and a docs/adr/ created AFTER the watch attached (the retry seam:
      // the repo-root watch sees `docs` appear and the re-scan attaches).
      await mkdir(join(wb.repoA, 'docs', 'adr'), { recursive: true });
      await writeFile(join(wb.repoA, 'docs', 'adr', '0001-first.md'), '# ADR 1\n');
      await waitFor(
        () => latest()[0]?.label === 'docs/adr/0001-first.md',
        'the new ADR at the top',
      );

      // Editing an issue floats it up; recency order holds strictly.
      await writeFile(join(wb.issuesRoot, '03-blocked-on-02.md'), '\nEdited during planning.\n', {
        flag: 'a',
      });
      await waitFor(
        () => latest()[0]?.label === 'issues/03-blocked-on-02.md',
        'the edited issue at the top',
      );
      const labels = latest().map((d) => d.label);
      expect(labels.indexOf('issues/03-blocked-on-02.md')).toBeLessThan(
        labels.indexOf('docs/adr/0001-first.md'),
      );
      expect(labels.indexOf('docs/adr/0001-first.md')).toBeLessThan(
        labels.indexOf('CONTEXT.md'),
      );
      expect(labels.indexOf('CONTEXT.md')).toBeLessThan(labels.indexOf('PRD.md'));

      // Non-planning churn under the same watched roots never re-pushes:
      // Receipts (completions/) and memory/journal are filtered out.
      const count = pushes.length;
      await mkdir(wb.completionsRoot, { recursive: true });
      await writeFile(
        join(wb.completionsRoot, '09-noise.md'),
        '---\nissue: 9\nslug: noise\noutcome: completed\nfinished: 2026-07-05T00:00:00Z\n---\n',
      );
      await mkdir(join(wb.memoryRoot, 'journal'), { recursive: true });
      await writeFile(join(wb.memoryRoot, 'journal', '2026-07-05.md'), '- Ended: now\n');
      await sleep(DEBOUNCE * 5);
      expect(pushes.length).toBe(count);
      expect(latest().some((d) => d.path.includes('/completions/'))).toBe(false);

      // Unwatch tears down; later churn is silent (nothing outlives the view).
      pw.unwatch('win1');
      expect(pw.size).toBe(0);
      await writeFile(join(wb.projectRoot, 'PRD-2.md'), '# another\n');
      await sleep(DEBOUNCE * 5);
      expect(pushes.length).toBe(count);
    } finally {
      pw.closeAll();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario e — issue 84's hook script, run as executed code against fixture
  // registries. It lives in the real Workbench tools dir (present before the
  // human applies the settings change — the HITL half of issue 84); the
  // SESSION_WARM_START_REGISTRY override points it at the fixtures. Every run
  // resolving (promisified execFile throws on non-zero) asserts exit 0.
  // ---------------------------------------------------------------------------
  it('Scenario e: session-warm-start.sh — registered cwds inject labeled CORE; unregistered/inactive/malformed stay silent; the cap truncates with its marker', async () => {
    const script = join(homedir(), 'Workbench', 'tools', 'session-warm-start.sh');
    expect(existsSync(script), `issue 84's hook script must exist at ${script}`).toBe(true);

    const runHook = async (registry: string, cwdArg: string): Promise<string> => {
      const { stdout } = await exec('/bin/sh', [script, cwdArg], {
        env: { ...process.env, SESSION_WARM_START_REGISTRY: registry },
      });
      return stdout;
    };
    const registry = join(wb.workbenchRoot, 'registry.md');
    const LABEL_PREFIX = "Project memory (from this project's Workbench memory/CORE.md";

    // REGISTERED: a cwd inside a mapped repo injects CORE under the exact
    // ADR-0015 label — the same content the in-app warm start carries.
    const out = await runHook(registry, wb.repoA);
    expect(out).toContain(LABEL_PREFIX);
    expect(out).toContain(WORKBENCH_CORE_FACT);

    // A NESTED cwd resolves via the ancestor walk.
    await mkdir(join(wb.repoA, 'src', 'deep'), { recursive: true });
    expect(await runHook(registry, join(wb.repoA, 'src', 'deep'))).toContain(WORKBENCH_CORE_FACT);

    // The SessionStart stdin JSON payload is honored when argv gives no cwd.
    const payload = JSON.stringify({ session_id: 'e2e', cwd: wb.repoB });
    const { stdout: viaStdin } = await exec(
      '/bin/sh',
      ['-c', 'printf %s "$1" | /bin/sh "$2"', 'sh', payload, script],
      { env: { ...process.env, SESSION_WARM_START_REGISTRY: registry } },
    );
    expect(viaStdin).toContain(WORKBENCH_CORE_FACT);

    // UNREGISTERED cwd: silence, exit 0.
    expect(await runHook(registry, wb.scratch)).toBe('');

    // INACTIVE entry: mapped but not active → silence (never a stale inject).
    const fixtures = join(wb.scratch, 'hook-fixtures');
    const inactiveDir = join(fixtures, 'inactive');
    await mkdir(join(inactiveDir, 'proj', 'memory'), { recursive: true });
    await writeFile(join(inactiveDir, 'proj', 'memory', 'CORE.md'), '- must never print\n');
    await writeFile(
      join(inactiveDir, 'registry.md'),
      `# Registry\n\n- repo: ${wb.repoA}\n  project: proj\n  status: inactive\n`,
    );
    expect(await runHook(join(inactiveDir, 'registry.md'), wb.repoA)).toBe('');

    // MALFORMED registry: tolerant parse yields no match → silence, exit 0
    // (a broken registry must never leak an error into a session).
    const malformed = join(fixtures, 'malformed.md');
    await writeFile(malformed, '::: not a registry\n- repo\nproject status active\n{{{\n');
    expect(await runHook(malformed, wb.repoA)).toBe('');

    // MISSING registry: silence, exit 0.
    expect(await runHook(join(fixtures, 'no-such-registry.md'), wb.repoA)).toBe('');

    // Whitespace-only CORE: registered, but nothing to inject → silence.
    const wsDir = join(fixtures, 'whitespace');
    await mkdir(join(wsDir, 'projw', 'memory'), { recursive: true });
    await writeFile(join(wsDir, 'projw', 'memory', 'CORE.md'), '   \n\n\t\n');
    await writeFile(
      join(wsDir, 'registry.md'),
      `- repo: ${wb.repoA}\n  project: projw\n  status: active\n`,
    );
    expect(await runHook(join(wsDir, 'registry.md'), wb.repoA)).toBe('');

    // The ~1.5k-token CAP: a long CORE truncates at ~6,000 characters with
    // the explicit marker — never a silent cut, never unbounded.
    const capDir = join(fixtures, 'cap');
    await mkdir(join(capDir, 'projc', 'memory'), { recursive: true });
    await writeFile(
      join(capDir, 'projc', 'memory', 'CORE.md'),
      `${'x'.repeat(7000)}\nTAIL-SENTINEL\n`,
    );
    await writeFile(
      join(capDir, 'registry.md'),
      `- repo: ${wb.repoA}\n  project: projc\n  status: active\n`,
    );
    const capped = await runHook(join(capDir, 'registry.md'), wb.repoA);
    expect(capped).toContain(LABEL_PREFIX);
    expect(capped).toContain('[…CORE.md truncated at the ~1.5k-token cap]');
    expect(capped).not.toContain('TAIL-SENTINEL');
  });
});

// -----------------------------------------------------------------------------
// Manual-only checklist items — walkthrough-86 lines that genuinely require the
// live Electron shell or a real claude session. Declared here (as named,
// skipped specs) so the coverage gap is explicit in the suite output, never
// silent.
// -----------------------------------------------------------------------------
describe('manual-only — guides batch: needs the live shell / a real claude session (declared, not silently skipped)', () => {
  it.skip('manual-only: the Inbox tab renders grouped items and click-through opens/focuses the target project — reason: Electron shell + renderer; the pipeline, ids, and grouping are asserted in Scenario a', () => {});
  it.skip('manual-only: opening the Inbox advances the last-seen stamp through the attention:mark-seen IPC of a live Window — reason: Electron IPC; the store + rederiveAll cycle it wires is asserted in Scenario a', () => {});
  it.skip('manual-only: the Launcher UI — Quick fix form, Run-now spawning a real claude Pane, Just talk warm session, Continue rows — reason: shell + real LLM; the issue-writer, numbering, auto-commit, Receipt, and card are asserted in Scenario b', () => {});
  it.skip('manual-only: the New project wizard form (Browse pre-fill, warnings pausing for "Create anyway", landing on the new project) — reason: renderer form + shell; the setup function, dual-handle resolution, and refusals are asserted in Scenario c', () => {});
  it.skip('manual-only: the Planning view Pane — a real claude session writing docs while the preview follows, Grill typing the /grill-with-docs prefix UNsubmitted (terminal focused, user finishes the sentence, issue 91) and PRD/Issues typing+submitting through the typing gate — reason: real LLM session (the issue declares this half manual-only); the watched set + recency ordering are asserted in Scenario d, the prefix-vs-submit table + pump in unit tests', () => {});
  it.skip('manual-only: the SessionStart hook applied in ~/.claude/settings.json injecting CORE into a REAL claude session — reason: issue 84 is HITL (the human applies the settings change); the script contract is asserted in Scenario e', () => {});
});
