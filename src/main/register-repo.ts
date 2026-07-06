/**
 * Register-appeared-repo edge (main process) — the confirm half of self-heal
 * (issue 95, ADR-0017).
 *
 * When the human clicks a `new-repo-candidate` Inbox item, this performs the
 * ADR-0015 registration: it reads the project's `CONFIG.md` and the workbench
 * `registry.md`, lets the pure `planRepoRegistration` decide the exact edits
 * (repo added to the `repos:` map, promoted to `default_repo` when the project
 * was repo-less, plus one active registry entry), writes both files, and lands
 * ONE boring workbench commit scoped to the project dir + `registry.md` — the
 * same shape onboarding uses, so a commit can never sweep a sibling's dirt.
 *
 * All validation lives in the pure planner; this file only reads and writes.
 * Refusals write and commit NOTHING. Never throws — failures degrade to
 * `{ ok: false, errors }`. Deliberately weaker than issue 62's auto-adopt: this
 * runs only on explicit human confirm, never on its own.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planRepoRegistration } from '../shared/repo-registration';
import { commitWorkbenchPaths } from './workbench-git';

export interface RegisterRepoInput {
  /** The workbench root (normally `~/Workbench`). */
  workbenchRoot: string;
  /** The real home directory, for `~` handling in CONFIG/registry paths. */
  homeDir: string;
  /** The workbench project directory name the repo joins. */
  project: string;
  /** The appeared repo's absolute path (from the candidate). */
  repoPath: string;
  /** The chosen short `repos:` key (the candidate's suggestion, user-editable). */
  key: string;
}

export interface RegisterRepoOutcome {
  /** True when the plan held and (unless a git hiccup) everything was written. */
  ok: boolean;
  /** Refusal reasons — every problem named, not just the first. */
  errors: string[];
  /** Non-blocking notes (e.g. a commit that failed after the files landed). */
  warnings: string[];
  /** The key actually registered, when the plan held. */
  key: string | null;
}

/** Read a file's text, or null when missing/unreadable — never throw. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Register one appeared repo into an existing workbench project. Never throws;
 * a refused plan or a write failure comes back as `ok: false` with reasons.
 */
export async function registerAppearedRepo(
  input: RegisterRepoInput,
): Promise<RegisterRepoOutcome> {
  const fail = (errors: string[]): RegisterRepoOutcome => ({
    ok: false,
    errors,
    warnings: [],
    key: null,
  });

  try {
    const { workbenchRoot, homeDir, project } = input;
    if (
      typeof project !== 'string' ||
      project.trim().length === 0 ||
      project.includes('/') ||
      project === '.' ||
      project === '..'
    ) {
      return fail([`Not a workbench project name: "${project}".`]);
    }

    const projectRoot = join(workbenchRoot, project);
    const registryPath = join(workbenchRoot, 'registry.md');
    const configPath = join(projectRoot, 'CONFIG.md');
    const [configContent, registryContent] = await Promise.all([
      readOrNull(configPath),
      readOrNull(registryPath),
    ]);

    const plan = planRepoRegistration({
      project,
      key: input.key,
      repoPath: input.repoPath,
      configContent,
      registryContent,
      homeDir,
    });
    if (!plan.ok) return fail(plan.errors);

    // Write the CONFIG (repos map + maybe default_repo) and append the registry
    // entry, then ONE boring commit scoped to the project dir + registry.md.
    await writeFile(configPath, plan.configContent, 'utf8');
    const nextRegistry =
      registryContent === null
        ? `# Registry\n\nMaps code-repo paths → Workbench projects (ADR-0015).\n\n## Entries\n\n${plan.registryAppend}`
        : `${registryContent.replace(/\n*$/, '\n')}${plan.registryAppend}`;
    await writeFile(registryPath, nextRegistry, 'utf8');

    const commit = await commitWorkbenchPaths(
      workbenchRoot,
      [project, 'registry.md'],
      `${project}: repo ${plan.key} registered`,
    );
    const warnings =
      commit.error === null
        ? []
        : [
            `Workbench commit failed (${commit.error}) — the repo is registered on disk; commit ~/Workbench manually.`,
          ];
    return { ok: true, errors: [], warnings, key: plan.key };
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }
}
