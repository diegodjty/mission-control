/**
 * Issue 76 — Migration: move MC's backlog into the Workbench (ADR-0015).
 *
 * Copies the in-repo backlog (issues/, issues/completions/, docs/PRD*.md,
 * issues/HUMAN-SETUP.md) into ~/Workbench/mission-control/, rewrites
 * `## Parent` links to workbench paths, merges the in-repo CONFIG into the
 * workbench CONFIG scaffold (issue 69's scaffold wins on conflicts), activates
 * the mission-control entry in ~/Workbench/registry.md, and emits a
 * verification report (file counts, link-rewrite counts, diff summary).
 *
 * SAFE BY DEFAULT: dry-run unless `--execute` is passed. Idempotent: a second
 * `--execute` run reports every file as `unchanged`. The script never deletes
 * anything from the mission-control repo — the `git rm` cleanup and the README
 * pointer note are human follow-up steps, printed at the end of the report.
 *
 * Run (Node >= 22.18 strips types natively; use nvm):
 *   source ~/.nvm/nvm.sh && nvm use 22
 *   node scripts/migrate-backlog-to-workbench.ts                # dry-run
 *   node scripts/migrate-backlog-to-workbench.ts --out <file>   # dry-run + write report
 *   node scripts/migrate-backlog-to-workbench.ts --execute      # real migration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in src/main/migrate-backlog-to-workbench.test.ts)
// ---------------------------------------------------------------------------

/** Where code-describing docs keep living after the migration (ADR-0015:
 * CONTEXT.md and docs/adr/ stay with the code they describe). */
export const DEFAULT_CODE_REPO_REF = '~/Developer/mission-control';

export interface RewriteResult {
  content: string;
  /** Number of individual link replacements made. */
  rewrites: number;
}

/**
 * Rewrite backtick-wrapped doc paths inside the `## Parent` section only:
 *   `docs/PRD.md`            -> `PRD.md`             (PRD moves to the workbench)
 *   `docs/PRD-dispatcher.md` -> `PRD-dispatcher.md`  (PRD moves to the workbench)
 *   `docs/adr/...`           -> `<codeRepoRef>/docs/adr/...` (ADRs stay in-repo)
 * Anchored on the opening backtick, so already-rewritten content never
 * matches again (idempotent). Everything outside `## Parent` is untouched.
 */
export function rewriteParentLinks(
  content: string,
  codeRepoRef: string = DEFAULT_CODE_REPO_REF,
): RewriteResult {
  const headingMatch = /^## Parent\s*$/m.exec(content);
  if (!headingMatch) return { content, rewrites: 0 };

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = content.slice(sectionStart).search(/^## /m);
  const sectionEnd = nextHeading === -1 ? content.length : sectionStart + nextHeading;

  const section = content.slice(sectionStart, sectionEnd);
  let rewrites = 0;
  const rewritten = section
    .replace(/`docs\/PRD\.md`/g, () => {
      rewrites += 1;
      return '`PRD.md`';
    })
    .replace(/`docs\/PRD-dispatcher\.md`/g, () => {
      rewrites += 1;
      return '`PRD-dispatcher.md`';
    })
    .replace(/`docs\/adr\//g, () => {
      rewrites += 1;
      return `\`${codeRepoRef}/docs/adr/`;
    });

  return {
    content: content.slice(0, sectionStart) + rewritten + content.slice(sectionEnd),
    rewrites,
  };
}

/** Rewrite the same doc paths anywhere in a CONFIG section body (used for the
 * merged CONFIG's `## Active PRD`, which points at an ADR that stays in-repo). */
function rewriteConfigDocPaths(body: string, codeRepoRef: string): string {
  return body
    .replace(/`docs\/PRD\.md`/g, '`PRD.md`')
    .replace(/`docs\/PRD-dispatcher\.md`/g, '`PRD-dispatcher.md`')
    .replace(/`docs\/adr\//g, `\`${codeRepoRef}/docs/adr/`);
}

const SCAFFOLD_NOTE_RE = /^> \*\*Scaffold note \(issue 69\):\*\*(?:.*\n)(?:^>.*\n?)*/m;

const MIGRATION_NOTE = `> **Migrated (issue 76):** the backlog (issues, Receipts, PRDs, HUMAN-SETUP)
> now lives here; the in-repo originals in \`~/Developer/mission-control\` were
> removed with a pointer note. This file is the operative config.
`;

export interface ConfigMergeResult {
  merged: string;
  /** Section titles copied over from the in-repo CONFIG. */
  appended: string[];
  /** Section titles present in both; the scaffold's body was kept (69 wins). */
  conflicts: string[];
}

/** Split a markdown document into a preamble and `## `-titled sections. */
function splitSections(doc: string): { preamble: string; sections: Map<string, string> } {
  const sections = new Map<string, string>();
  const parts = doc.split(/^(?=## )/m);
  const preamble = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const title = (newline === -1 ? part : part.slice(0, newline)).replace(/^## /, '').trim();
    sections.set(title, part);
  }
  return { preamble, sections };
}

/**
 * Merge the in-repo issues/CONFIG.md into the workbench CONFIG scaffold.
 * Section-level merge keyed on `## ` titles: sections the scaffold already has
 * are conflicts (scaffold wins, reported); sections it lacks are appended with
 * doc paths rewritten. The issue-69 scaffold note (which says the backlog is
 * still in-repo) is replaced by a migration note. Idempotent: merging the
 * merged output again changes nothing.
 */
export function mergeConfigs(
  scaffold: string,
  inRepo: string,
  codeRepoRef: string = DEFAULT_CODE_REPO_REF,
): ConfigMergeResult {
  const scaffoldParts = splitSections(scaffold);
  const inRepoParts = splitSections(inRepo);

  const appended: string[] = [];
  const conflicts: string[] = [];
  let merged = scaffold;

  if (SCAFFOLD_NOTE_RE.test(merged)) {
    merged = merged.replace(SCAFFOLD_NOTE_RE, MIGRATION_NOTE);
  }

  for (const [title, body] of inRepoParts.sections) {
    if (scaffoldParts.sections.has(title)) {
      conflicts.push(title);
      continue;
    }
    appended.push(title);
    if (!merged.endsWith('\n')) merged += '\n';
    merged += '\n' + rewriteConfigDocPaths(body, codeRepoRef).trimEnd() + '\n';
  }

  return { merged, appended, conflicts };
}

export interface RegistryResult {
  content: string;
  changed: boolean;
}

/**
 * Activate the mission-control entry in ~/Workbench/registry.md: drop the
 * "INACTIVE until migration issue 76" comment and flip the entry's
 * `status: inactive` to `status: active`. Other entries are untouched.
 * Idempotent: already-active content comes back with `changed: false`.
 */
export function activateRegistry(registry: string): RegistryResult {
  let content = registry;

  content = content.replace(/[ \t]*<!--\s*INACTIVE until migration issue 76[\s\S]*?-->\n?/, '');

  const entryRe =
    /(- repo: ~\/Developer\/mission-control\n {2}project: mission-control\n {2}status: )inactive/;
  content = content.replace(entryRe, '$1active');

  return { content, changed: content !== registry };
}

// ---------------------------------------------------------------------------
// Plan / apply / report
// ---------------------------------------------------------------------------

export type FileAction = 'create' | 'update' | 'unchanged';

export interface PlannedFile {
  kind: 'issue' | 'receipt' | 'prd' | 'human-setup' | 'config' | 'registry';
  source: string;
  dest: string;
  action: FileAction;
  content: string;
  rewrites: number;
}

export interface MigrationPlan {
  files: PlannedFile[];
  configMerge: ConfigMergeResult;
  registryChanged: boolean;
  counts: {
    issues: number;
    receipts: number;
    prds: number;
    humanSetup: number;
    parentRewrites: number;
    issuesWithRewrites: number;
  };
  errors: string[];
}

export interface MigrationPaths {
  /** mission-control code repo root (source of the in-repo backlog). */
  repoRoot: string;
  /** ~/Workbench/mission-control (destination project directory). */
  projectDir: string;
  /** ~/Workbench/registry.md */
  registryPath: string;
  /** Path ADR parent links get rewritten to point at. */
  codeRepoRef?: string;
}

const ISSUE_FILE_RE = /^\d{2,}-.*\.md$/;

function actionFor(dest: string, content: string): FileAction {
  if (!fs.existsSync(dest)) return 'create';
  return fs.readFileSync(dest, 'utf8') === content ? 'unchanged' : 'update';
}

/** Read every source, compute every destination write. Reads only — never writes. */
export function planMigration(paths: MigrationPaths): MigrationPlan {
  const codeRepoRef = paths.codeRepoRef ?? DEFAULT_CODE_REPO_REF;
  const issuesDir = path.join(paths.repoRoot, 'issues');
  const completionsDir = path.join(issuesDir, 'completions');
  const docsDir = path.join(paths.repoRoot, 'docs');

  const files: PlannedFile[] = [];
  const errors: string[] = [];
  let parentRewrites = 0;
  let issuesWithRewrites = 0;

  // 1. Issue files (NN-slug.md) — Parent links rewritten.
  if (!fs.existsSync(issuesDir)) {
    errors.push(`source issues directory missing: ${issuesDir} (already migrated and cleaned?)`);
  } else {
    for (const name of fs.readdirSync(issuesDir).filter((n) => ISSUE_FILE_RE.test(n)).sort()) {
      const source = path.join(issuesDir, name);
      const { content, rewrites } = rewriteParentLinks(fs.readFileSync(source, 'utf8'), codeRepoRef);
      parentRewrites += rewrites;
      if (rewrites > 0) issuesWithRewrites += 1;
      const dest = path.join(paths.projectDir, 'issues', name);
      files.push({ kind: 'issue', source, dest, action: actionFor(dest, content), content, rewrites });
    }
  }

  // 2. Receipts — copied verbatim into the workbench completions root.
  if (fs.existsSync(completionsDir)) {
    for (const name of fs.readdirSync(completionsDir).filter((n) => n.endsWith('.md')).sort()) {
      const source = path.join(completionsDir, name);
      const content = fs.readFileSync(source, 'utf8');
      const dest = path.join(paths.projectDir, 'completions', name);
      files.push({ kind: 'receipt', source, dest, action: actionFor(dest, content), content, rewrites: 0 });
    }
  }

  // 3. PRDs — copied verbatim to the project root.
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).filter((n) => /^PRD.*\.md$/.test(n)).sort()) {
      const source = path.join(docsDir, name);
      const content = fs.readFileSync(source, 'utf8');
      const dest = path.join(paths.projectDir, name);
      files.push({ kind: 'prd', source, dest, action: actionFor(dest, content), content, rewrites: 0 });
    }
  }

  // 4. HUMAN-SETUP.md — copied verbatim to the project root.
  const humanSetupSource = path.join(issuesDir, 'HUMAN-SETUP.md');
  if (fs.existsSync(humanSetupSource)) {
    const content = fs.readFileSync(humanSetupSource, 'utf8');
    const dest = path.join(paths.projectDir, 'HUMAN-SETUP.md');
    files.push({ kind: 'human-setup', source: humanSetupSource, dest, action: actionFor(dest, content), content, rewrites: 0 });
  }

  // 5. CONFIG merge — issue 69's workbench scaffold wins on conflicts.
  let configMerge: ConfigMergeResult = { merged: '', appended: [], conflicts: [] };
  const scaffoldPath = path.join(paths.projectDir, 'CONFIG.md');
  const inRepoConfigPath = path.join(issuesDir, 'CONFIG.md');
  if (!fs.existsSync(scaffoldPath)) {
    errors.push(`workbench CONFIG scaffold missing: ${scaffoldPath} (issue 69 not applied?)`);
  } else if (!fs.existsSync(inRepoConfigPath)) {
    errors.push(`in-repo CONFIG missing: ${inRepoConfigPath}`);
  } else {
    configMerge = mergeConfigs(
      fs.readFileSync(scaffoldPath, 'utf8'),
      fs.readFileSync(inRepoConfigPath, 'utf8'),
      codeRepoRef,
    );
    files.push({
      kind: 'config',
      source: inRepoConfigPath,
      dest: scaffoldPath,
      action: actionFor(scaffoldPath, configMerge.merged),
      content: configMerge.merged,
      rewrites: 0,
    });
  }

  // 6. Registry activation.
  let registryChanged = false;
  if (!fs.existsSync(paths.registryPath)) {
    errors.push(`registry missing: ${paths.registryPath}`);
  } else {
    const result = activateRegistry(fs.readFileSync(paths.registryPath, 'utf8'));
    registryChanged = result.changed;
    files.push({
      kind: 'registry',
      source: paths.registryPath,
      dest: paths.registryPath,
      action: result.changed ? 'update' : 'unchanged',
      content: result.content,
      rewrites: 0,
    });
  }

  const byKind = (kind: PlannedFile['kind']) => files.filter((f) => f.kind === kind).length;
  return {
    files,
    configMerge,
    registryChanged,
    counts: {
      issues: byKind('issue'),
      receipts: byKind('receipt'),
      prds: byKind('prd'),
      humanSetup: byKind('human-setup'),
      parentRewrites,
      issuesWithRewrites,
    },
    errors,
  };
}

/** Write every planned file whose content differs. Returns paths written. */
export function applyPlan(plan: MigrationPlan): string[] {
  const written: string[] = [];
  for (const file of plan.files) {
    if (file.action === 'unchanged') continue;
    fs.mkdirSync(path.dirname(file.dest), { recursive: true });
    fs.writeFileSync(file.dest, file.content);
    written.push(file.dest);
  }
  return written;
}

export function renderReport(plan: MigrationPlan, mode: 'dry-run' | 'execute', now: Date = new Date()): string {
  const verb = mode === 'dry-run' ? 'would be' : 'was';
  const lines: string[] = [];
  const creates = plan.files.filter((f) => f.action === 'create');
  const updates = plan.files.filter((f) => f.action === 'update');
  const unchanged = plan.files.filter((f) => f.action === 'unchanged');

  lines.push(`# Migration ${mode} report — MC backlog -> ~/Workbench/mission-control (issue 76)`);
  lines.push('');
  lines.push(`Generated: ${now.toISOString()} by \`scripts/migrate-backlog-to-workbench.ts\` (mode: **${mode}**).`);
  lines.push('');

  if (plan.errors.length > 0) {
    lines.push('## ERRORS — migration blocked');
    lines.push('');
    for (const error of plan.errors) lines.push(`- ${error}`);
    lines.push('');
  }

  lines.push('## File counts');
  lines.push('');
  lines.push(`- Issue files: **${plan.counts.issues}**`);
  lines.push(`- Receipts (completions): **${plan.counts.receipts}**`);
  lines.push(`- PRDs: **${plan.counts.prds}**`);
  lines.push(`- HUMAN-SETUP.md: **${plan.counts.humanSetup}**`);
  lines.push('');

  lines.push('## Parent-link rewrites');
  lines.push('');
  lines.push(
    `- **${plan.counts.parentRewrites}** link rewrites across **${plan.counts.issuesWithRewrites}** issue files ` +
      '(`docs/PRD*.md` -> workbench-root `PRD*.md`; `docs/adr/...` -> ' +
      '`~/Developer/mission-control/docs/adr/...` — ADRs stay with the code per ADR-0015).',
  );
  lines.push('');

  lines.push('## CONFIG merge (issue 69 scaffold wins on conflicts)');
  lines.push('');
  lines.push(
    `- Sections appended from in-repo CONFIG: ${plan.configMerge.appended.map((s) => `**${s}**`).join(', ') || 'none'}`,
  );
  lines.push(
    `- Conflicts (scaffold's body kept): ${plan.configMerge.conflicts.map((s) => `**${s}**`).join(', ') || 'none'}`,
  );
  lines.push('- The issue-69 scaffold note is replaced by a migration note.');
  lines.push('');

  lines.push('## Registry');
  lines.push('');
  lines.push(
    plan.registryChanged
      ? `- \`~/Workbench/registry.md\`: mission-control entry ${verb} flipped to \`status: active\` and the INACTIVE comment removed.`
      : '- `~/Workbench/registry.md`: already active — no change.',
  );
  lines.push('');

  lines.push('## Diff summary');
  lines.push('');
  lines.push(`- Create: **${creates.length}**, update: **${updates.length}**, unchanged: **${unchanged.length}**.`);
  for (const file of [...updates, ...creates.filter((f) => f.kind === 'config' || f.kind === 'registry')]) {
    lines.push(`  - ${file.action}: \`${file.dest}\``);
  }
  if (mode === 'dry-run') {
    lines.push('- Dry-run: **nothing was written**. Re-run with `--execute` to apply.');
  }
  lines.push('');

  lines.push('## Human follow-up steps (after --execute)');
  lines.push('');
  lines.push('Machine-before-human gate: run these only after `npm run test:e2e` is green.');
  lines.push('');
  lines.push('1. `source ~/.nvm/nvm.sh && nvm use 22 && npm run test:e2e`  # must be green first');
  lines.push('2. `node scripts/migrate-backlog-to-workbench.ts --execute`');
  lines.push('3. Spot-check `~/Workbench/mission-control/` (Map opens in MC; statuses intact).');
  lines.push('4. Remove the originals so exactly one source of truth remains:');
  lines.push('   `git -C ~/Developer/mission-control rm -r issues docs/PRD.md docs/PRD-dispatcher.md`');
  lines.push('5. Add a pointer note to `README.md`, e.g.:');
  lines.push('   > The backlog (issues, Receipts, PRDs, HUMAN-SETUP) moved to `~/Workbench/mission-control/`');
  lines.push('   > per ADR-0015 (migration issue 76). Git history preserves the originals.');
  lines.push('6. `git -C ~/Developer/mission-control add README.md && git -C ~/Developer/mission-control commit -m "chore: backlog moved to ~/Workbench/mission-control (issue 76, ADR-0015)"`');
  lines.push('7. `git -C ~/Workbench add -A && git -C ~/Workbench commit -m "migrate mission-control backlog from in-repo (issue 76)"`');
  lines.push('8. Verify: a bare `claude` session in the MC repo resolves the backlog via the registry (issue 74), and MC shows the full Map via the workbench.');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  const execute = argv.includes('--execute');
  const outIndex = argv.indexOf('--out');
  const outFile = outIndex !== -1 ? argv[outIndex + 1] : undefined;
  if (outIndex !== -1 && !outFile) {
    console.error('--out requires a file path');
    return 2;
  }

  const home = os.homedir();
  const plan = planMigration({
    repoRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    projectDir: path.join(home, 'Workbench', 'mission-control'),
    registryPath: path.join(home, 'Workbench', 'registry.md'),
  });

  const mode = execute ? 'execute' : 'dry-run';
  if (plan.errors.length > 0) {
    console.error(renderReport(plan, mode));
    console.error('Errors found — nothing written.');
    return 1;
  }

  if (execute) applyPlan(plan);

  const report = renderReport(plan, mode);
  console.log(report);
  if (outFile) fs.writeFileSync(outFile, report);
  return 0;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
