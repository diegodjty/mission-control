import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttentionInput } from './attention-reader';

/**
 * The attention reader (issue 79) against real temp workbench project dirs:
 * a full fixture maps every artifact, missing pieces degrade to the empty
 * shape, and non-`.md` clutter in `completions/` and `memory/journal/` is
 * never parsed (issue 78's doc-drift note made code).
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeWorkbench(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mc-attn-read-'));
  dirs.push(root);
  return root;
}

describe('readAttentionInput', () => {
  it('reads a full project into the pure model input shape', async () => {
    const root = await makeWorkbench();
    const project = join(root, 'proj');
    await mkdir(join(project, 'issues'), { recursive: true });
    await mkdir(join(project, 'completions'), { recursive: true });
    await mkdir(join(project, 'memory', 'journal'), { recursive: true });

    await writeFile(
      join(project, 'issues', '05-manual-check.md'),
      '---\nstatus: wip\ndepends_on: []\nhitl: true\n---\n\n# 05 — manual check\n',
    );
    await writeFile(
      join(project, 'completions', '05-manual-check.md'),
      '---\nissue: 5\nslug: manual-check\noutcome: needs-verification\nfinished: 2026-07-01T10:00:00Z\n---\n\nReady for manual verification.\n',
    );
    await writeFile(join(project, 'memory', 'CORE.proposed.md'), '# proposed\n');
    await writeFile(join(project, 'HUMAN-SETUP.md'), '- [ ] Add token. Unblocks: 05\n');
    await writeFile(join(project, 'memory', 'journal', '2026-07-01.md'), '# drain\n- Reason: done\n');

    const input = await readAttentionInput(root, 'proj', '2026-06-30');

    expect(input.project).toBe('proj');
    expect(input.backlog.issues).toHaveLength(1);
    expect(input.backlog.issues[0]).toMatchObject({ id: 5, status: 'wip', hitl: true });
    expect(input.receipts).toHaveLength(1);
    expect(input.receipts[0]).toMatchObject({ issueId: 5, outcome: 'needs-verification' });
    expect(input.coreProposedPresent).toBe(true);
    expect(input.humanSetup).toContain('Unblocks: 05');
    expect(input.journal).toEqual([
      { name: '2026-07-01.md', content: '# drain\n- Reason: done\n' },
    ]);
    expect(input.lastSeen).toBe('2026-06-30');
  });

  it('reads pending timeout-salvage records from completions/.timeout-salvage.json (issue 170), never mistaking it for a Receipt', async () => {
    const root = await makeWorkbench();
    const project = join(root, 'proj');
    await mkdir(join(project, 'issues'), { recursive: true });
    await mkdir(join(project, 'completions'), { recursive: true });
    const record = {
      project: 'proj',
      issueId: 61,
      slug: '61-refactor',
      worktreePath: '/tmp/.afk-worktrees/61-refactor',
      timedOutAt: '2026-07-19T12:00:00.000Z',
    };
    await writeFile(
      join(project, 'completions', '.timeout-salvage.json'),
      JSON.stringify([record]),
    );

    const input = await readAttentionInput(root, 'proj', null);

    expect(input.timeoutSalvage).toEqual([record]);
    // The stray JSON file is not a `.md` Receipt — it must never surface here.
    expect(input.receipts).toEqual([]);
  });

  it('degrades a missing/corrupt timeout-salvage file to the empty list', async () => {
    const root = await makeWorkbench();
    const input = await readAttentionInput(root, 'ghost-project', null);
    expect(input.timeoutSalvage).toEqual([]);
  });

  it('a project with nothing on disk degrades to the empty shape, never a throw', async () => {
    const root = await makeWorkbench();
    const input = await readAttentionInput(root, 'ghost', null);
    expect(input).toEqual({
      project: 'ghost',
      backlog: { activePrd: null, workerModel: 'sonnet', escalationCeiling: 'opus', workerEffort: null, runTimeoutMinutes: 30, issues: [] },
      receipts: [],
      coreProposedPresent: false,
      humanSetup: null,
      journal: [],
      lastSeen: null,
      // No CONFIG.md → no workspace_root → the self-heal input is null (issue
      // 95): a project with nothing on disk has no appeared-repo candidates.
      selfHeal: null,
      timeoutSalvage: [],
    });
  });

  it('non-.md clutter in completions/ and journal/ is never read as an artifact', async () => {
    const root = await makeWorkbench();
    const project = join(root, 'proj');
    await mkdir(join(project, 'completions'), { recursive: true });
    await mkdir(join(project, 'memory', 'journal'), { recursive: true });
    // The doc-drift case issue 78 flagged: .gitkeep / editor droppings beside
    // real artifacts must not be parsed as Receipts or journal entries.
    await writeFile(join(project, 'completions', '.gitkeep'), '');
    await writeFile(join(project, 'completions', 'notes.txt'), 'not a receipt');
    await writeFile(join(project, 'memory', 'journal', '.DS_Store'), 'binary-ish');
    await writeFile(
      join(project, 'completions', '07-real.md'),
      '---\nissue: 7\nslug: real\noutcome: completed\nfinished: 2026-07-01T10:00:00Z\n---\n\n## Completed issue 07 — real\n',
    );

    const input = await readAttentionInput(root, 'proj', null);
    expect(input.receipts).toHaveLength(1);
    expect(input.receipts[0].issueId).toBe(7);
    expect(input.journal).toEqual([]);
  });

  it('CORE.proposed.md absent reads as false', async () => {
    const root = await makeWorkbench();
    await mkdir(join(root, 'proj', 'memory'), { recursive: true });
    const input = await readAttentionInput(root, 'proj', null);
    expect(input.coreProposedPresent).toBe(false);
  });
});
