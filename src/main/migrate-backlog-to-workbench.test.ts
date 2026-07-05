import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  activateRegistry,
  applyPlan,
  mergeConfigs,
  planMigration,
  renderReport,
  rewriteParentLinks,
} from '../../scripts/migrate-backlog-to-workbench';

const REF = '~/Developer/mission-control';

describe('rewriteParentLinks', () => {
  it('rewrites a docs/PRD.md parent to the workbench-root PRD.md', () => {
    const issue = '# 01 — x\n\n## Parent\n\n`docs/PRD.md` — Mission Control.\n\n## What to build\n\nBody.\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toContain('## Parent\n\n`PRD.md` — Mission Control.');
    expect(result.rewrites).toBe(1);
  });

  it('rewrites docs/PRD-dispatcher.md without being mangled by the PRD.md rule', () => {
    const issue = '## Parent\n\n`docs/PRD-dispatcher.md` — Dispatcher.\n\n## Body\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toContain('`PRD-dispatcher.md` — Dispatcher.');
    expect(result.content).not.toContain('docs/');
    expect(result.rewrites).toBe(1);
  });

  it('rewrites ADR parents to point into the code repo (ADRs stay with the code)', () => {
    const issue = '## Parent\n\n`docs/adr/0015-the-workbench.md` — the Workbench.\n\n## Body\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toContain('`~/Developer/mission-control/docs/adr/0015-the-workbench.md` — the Workbench.');
    expect(result.rewrites).toBe(1);
  });

  it('leaves doc paths outside the Parent section untouched', () => {
    const issue =
      '## Parent\n\n`docs/PRD.md` — MC.\n\n## What to build\n\nSee `docs/PRD.md` and `docs/adr/0002-x.md`.\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toContain('See `docs/PRD.md` and `docs/adr/0002-x.md`.');
    expect(result.rewrites).toBe(1);
  });

  it('leaves parenthetical references like CONTEXT.md alone', () => {
    const issue =
      '## Parent\n\n`docs/adr/0013-receipts.md` — Receipts (see also the **Receipt** entry in `CONTEXT.md`).\n\n## Body\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toContain('`CONTEXT.md`');
    expect(result.rewrites).toBe(1);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const issue = '## Parent\n\n`docs/PRD.md` — MC.\n\n## Body\n\n`docs/adr/0001-a.md`\n';
    const once = rewriteParentLinks(issue, REF);
    const twice = rewriteParentLinks(once.content, REF);
    expect(twice.content).toBe(once.content);
    expect(twice.rewrites).toBe(0);
  });

  it('returns content unchanged when there is no Parent section (standalone issue)', () => {
    const issue = '# 90 — standalone\n\n## Source\n\ntriage note referencing `docs/PRD.md`.\n';
    const result = rewriteParentLinks(issue, REF);
    expect(result.content).toBe(issue);
    expect(result.rewrites).toBe(0);
  });
});

const SCAFFOLD = `---
repos:
  app: ~/Developer/mission-control
default_repo: app
---

# mission-control — project CONFIG

Intro text.

> **Scaffold note (issue 69):** this project's backlog still lives in-repo
> until migration issue 76 moves it here.

## Test commands

Scaffold's authoritative test commands (includes the nvm line).
`;

const IN_REPO = `# AFK project config

Per-project specifics.

## Active PRD

\`docs/adr/0015-the-workbench.md\` — the Workbench batch (issues 69–77).

## Repo

Single Electron + React + TypeScript repo (this directory).

## Test commands

In-repo (older) test commands text.

## Parallel mode

\`afk-merge.sh\` lives in the skill dir.
`;

describe('mergeConfigs', () => {
  it('appends sections the scaffold lacks, keeps scaffold body on conflicts, and reports both', () => {
    const result = mergeConfigs(SCAFFOLD, IN_REPO, REF);
    expect(result.appended).toEqual(['Active PRD', 'Repo', 'Parallel mode']);
    expect(result.conflicts).toEqual(['Test commands']);
    expect(result.merged).toContain("Scaffold's authoritative test commands");
    expect(result.merged).not.toContain('In-repo (older) test commands text');
    expect(result.merged).toContain('## Parallel mode');
  });

  it('rewrites the Active PRD path to point into the code repo', () => {
    const result = mergeConfigs(SCAFFOLD, IN_REPO, REF);
    expect(result.merged).toContain('`~/Developer/mission-control/docs/adr/0015-the-workbench.md`');
    expect(result.merged).not.toContain('`docs/adr/0015-the-workbench.md`');
  });

  it('replaces the issue-69 scaffold note with a migration note', () => {
    const result = mergeConfigs(SCAFFOLD, IN_REPO, REF);
    expect(result.merged).not.toContain('Scaffold note (issue 69)');
    expect(result.merged).toContain('**Migrated (issue 76):**');
  });

  it('is idempotent — merging the merged output again changes nothing', () => {
    const once = mergeConfigs(SCAFFOLD, IN_REPO, REF);
    const twice = mergeConfigs(once.merged, IN_REPO, REF);
    expect(twice.merged).toBe(once.merged);
    expect(twice.appended).toEqual([]);
  });
});

const REGISTRY = `# Registry

Maps repo paths to projects.

## Entries

<!-- INACTIVE until migration issue 76 moves the mission-control backlog into this
     workbench and flips this to \`status: active\`. -->
- repo: ~/Developer/mission-control
  project: mission-control
  status: inactive
- repo: ~/Developer/other-repo
  project: other
  status: inactive
`;

describe('activateRegistry', () => {
  it('flips the mission-control entry to active and removes the INACTIVE comment', () => {
    const result = activateRegistry(REGISTRY);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('- repo: ~/Developer/mission-control\n  project: mission-control\n  status: active');
    expect(result.content).not.toContain('<!--');
  });

  it('leaves other entries untouched', () => {
    const result = activateRegistry(REGISTRY);
    expect(result.content).toContain('- repo: ~/Developer/other-repo\n  project: other\n  status: inactive');
  });

  it('is idempotent — already-active content reports changed: false', () => {
    const once = activateRegistry(REGISTRY);
    const twice = activateRegistry(once.content);
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
  });
});

describe('planMigration + applyPlan (temp-dir integration)', () => {
  let root: string;
  let repoRoot: string;
  let projectDir: string;
  let registryPath: string;

  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-migration-'));
    repoRoot = path.join(root, 'repo');
    projectDir = path.join(root, 'workbench', 'mission-control');
    registryPath = path.join(root, 'workbench', 'registry.md');

    write(path.join(repoRoot, 'issues', '01-first.md'), '## Parent\n\n`docs/PRD.md` — MC.\n\n## Body\n');
    write(
      path.join(repoRoot, 'issues', '76-migration.md'),
      '## Parent\n\n`docs/adr/0015-the-workbench.md` — the Workbench.\n\n## Body\n',
    );
    write(path.join(repoRoot, 'issues', 'CONFIG.md'), IN_REPO);
    write(path.join(repoRoot, 'issues', 'HUMAN-SETUP.md'), '# Human setup\n');
    write(path.join(repoRoot, 'issues', 'completions', '01-first.md'), '---\nissue: 1\n---\nreceipt\n');
    write(path.join(repoRoot, 'docs', 'PRD.md'), '# PRD\n');
    write(path.join(repoRoot, 'docs', 'PRD-dispatcher.md'), '# PRD dispatcher\n');
    write(path.join(projectDir, 'CONFIG.md'), SCAFFOLD);
    write(registryPath, REGISTRY);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const paths = () => ({ repoRoot, projectDir, registryPath, codeRepoRef: REF });

  it('plans the full move with correct counts and writes nothing by itself', () => {
    const plan = planMigration(paths());
    expect(plan.errors).toEqual([]);
    expect(plan.counts).toMatchObject({ issues: 2, receipts: 1, prds: 2, humanSetup: 1, parentRewrites: 2 });
    expect(fs.existsSync(path.join(projectDir, 'issues', '01-first.md'))).toBe(false);
    expect(fs.readFileSync(registryPath, 'utf8')).toContain('status: inactive');
  });

  it('excludes CONFIG.md and HUMAN-SETUP.md from the issue-file glob', () => {
    const plan = planMigration(paths());
    const issueNames = plan.files.filter((f) => f.kind === 'issue').map((f) => path.basename(f.dest));
    expect(issueNames).toEqual(['01-first.md', '76-migration.md']);
  });

  it('applyPlan performs the migration: copies, rewrites, merges, activates', () => {
    applyPlan(planMigration(paths()));
    expect(fs.readFileSync(path.join(projectDir, 'issues', '01-first.md'), 'utf8')).toContain('`PRD.md` — MC.');
    expect(fs.readFileSync(path.join(projectDir, 'issues', '76-migration.md'), 'utf8')).toContain(
      '`~/Developer/mission-control/docs/adr/0015-the-workbench.md`',
    );
    expect(fs.readFileSync(path.join(projectDir, 'completions', '01-first.md'), 'utf8')).toContain('receipt');
    expect(fs.existsSync(path.join(projectDir, 'PRD.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'PRD-dispatcher.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'HUMAN-SETUP.md'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'CONFIG.md'), 'utf8')).toContain('## Parallel mode');
    expect(fs.readFileSync(registryPath, 'utf8')).toContain('status: active');
  });

  it('is idempotent — a second run finds every file unchanged', () => {
    applyPlan(planMigration(paths()));
    const second = planMigration(paths());
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(applyPlan(second)).toEqual([]);
  });

  it('reports an error (and the report says so) when the source backlog is gone', () => {
    fs.rmSync(path.join(repoRoot, 'issues'), { recursive: true });
    const plan = planMigration(paths());
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(renderReport(plan, 'dry-run')).toContain('ERRORS');
  });

  it('renderReport dry-run states nothing was written and lists follow-up steps', () => {
    const report = renderReport(planMigration(paths()), 'dry-run');
    expect(report).toContain('nothing was written');
    expect(report).toContain('Human follow-up steps');
    expect(report).toContain('git -C ~/Developer/mission-control rm -r issues');
  });
});
