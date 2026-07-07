/**
 * Onboarding edge (main process) — the Launcher's New project flow's file
 * work (issue 82, ADR-0016).
 *
 * Gathers the filesystem facts the pure `shared/onboarding-model` plan needs
 * (registry content, existing project dirs, which repo paths exist / are git
 * repos), and when the plan holds, performs the ADR-0015 setup itself:
 *
 *   1. `~/Workbench/<project>/` — `CONFIG.md` (workspace_root + repos map +
 *      default_repo), empty `issues/` + `completions/`, memory skeleton
 *      (`memory/CORE.md` empty, `journal/` + `topics/` dirs);
 *   2. appends the active registry entries (one per member repo) to
 *      `~/Workbench/registry.md`, creating it with a minimal header when this
 *      is the first project ever — SKIPPED for a repo-less project (ADR-0017),
 *      which has no repos to register yet;
 *   3. ONE boring workbench commit (`<project>: project onboarded`) scoped to
 *      the new project dir (+ `registry.md` when it was touched) — sibling
 *      projects' dirt never rides along.
 *
 * All validation decisions live in the pure model; this file only reads and
 * writes. Refusals (and `dryRun`) write and commit NOTHING. Never throws —
 * failures degrade to `{ ok: false, errors }`.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planOnboarding, workspaceRootFor, type RepoFact } from '../shared/onboarding-model';
import { expandTilde } from '../shared/workbench-model';
import { commitWorkbenchPaths } from './workbench-git';

/** One repo row as the renderer drafts it: a short key + a path. */
export interface OnboardingRepoDraft {
  key: string;
  path: string;
}

export interface CreateProjectInput {
  /** The workbench root (normally `~/Workbench`). Must already exist. */
  workbenchRoot: string;
  /** The real home directory, for `~` handling in registry/CONFIG paths. */
  homeDir: string;
  /** The project display name; slugged into the directory name. */
  name: string;
  /** Zero or more repo drafts; the FIRST becomes `default_repo`. */
  repos: OnboardingRepoDraft[];
  /**
   * The workspace root the user entered, or empty/absent for the default
   * `~/Developer/<name>` (ADR-0017) — where the project's code lives/will live.
   */
  workspaceRoot?: string;
  /** Validate only: report errors/warnings, write nothing. */
  dryRun?: boolean;
}

export interface CreateProjectOutcome {
  /** True when the plan holds (and, unless dryRun, everything was written). */
  ok: boolean;
  /** Refusal reasons — every problem named, not just the first. */
  errors: string[];
  /** Non-blocking notes (non-git path, path missing) — shown, then allowed. */
  warnings: string[];
  /** The workbench directory name, when the plan holds. */
  dirName: string | null;
  /** The absolute project root (`<workbenchRoot>/<dirName>`), when it holds. */
  workbenchDir: string | null;
}

/** True when the path exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists at all (file or directory). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the path is an existing directory that contains at least one entry
 * — the fact behind ADR-0017's "existing non-empty workspace root warns". A
 * missing path, a file, or an empty directory are all "not non-empty".
 */
async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
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
 * Perform (or, with `dryRun`, just validate) the New-project setup. Never
 * throws; a refused plan or any write failure comes back as `ok: false` with
 * the reasons in `errors`.
 */
export async function createWorkbenchProject(
  input: CreateProjectInput,
): Promise<CreateProjectOutcome> {
  const fail = (errors: string[], warnings: string[] = []): CreateProjectOutcome => ({
    ok: false,
    errors,
    warnings,
    dirName: null,
    workbenchDir: null,
  });

  try {
    const { workbenchRoot, homeDir } = input;
    if (!(await isDirectory(workbenchRoot))) {
      return fail([
        `No workbench directory at ${workbenchRoot} — the ADR-0015 bootstrap creates it (one private git repo).`,
      ]);
    }

    // --- Gather the facts the pure plan needs --------------------------------
    const registryContent = await readOrNull(join(workbenchRoot, 'registry.md'));
    let existingProjectDirs: string[] = [];
    try {
      const entries = await readdir(workbenchRoot, { withFileTypes: true });
      existingProjectDirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      // Unreadable workbench listing: collision checks degrade to the registry.
    }

    const repoFacts: RepoFact[] = await Promise.all(
      (Array.isArray(input.repos) ? input.repos : []).map(async (draft): Promise<RepoFact> => {
        const raw = typeof draft?.path === 'string' ? draft.path.trim() : '';
        const absolute = expandTilde(raw, homeDir);
        const present = raw.length > 0 && (await exists(absolute));
        // A `.git` of ANY type counts (a worktree's `.git` is a file).
        const isGit = present && (await exists(join(absolute, '.git')));
        return { key: typeof draft?.key === 'string' ? draft.key : '', path: raw, exists: present, isGit };
      }),
    );

    // The workspace root (entered or defaulted) — resolved with the SAME pure
    // helper the plan uses, so the path we stat is the path it writes.
    const name = typeof input.name === 'string' ? input.name : '';
    const workspaceRootWrite = workspaceRootFor(name, input.workspaceRoot, homeDir);
    const workspaceRootNonEmpty =
      workspaceRootWrite.length > 0 &&
      (await isNonEmptyDir(expandTilde(workspaceRootWrite, homeDir)));

    const plan = planOnboarding({
      name,
      repos: repoFacts,
      workspaceRoot: input.workspaceRoot,
      workspaceRootNonEmpty,
      registryContent,
      existingProjectDirs,
      homeDir,
    });
    if (!plan.ok) return fail(plan.errors, plan.warnings);

    const projectRoot = join(workbenchRoot, plan.dirName);
    const outcome: CreateProjectOutcome = {
      ok: true,
      errors: [],
      warnings: plan.warnings,
      dirName: plan.dirName,
      workbenchDir: projectRoot,
    };
    if (input.dryRun === true) return outcome;

    // --- Write the ADR-0015 project skeleton ----------------------------------
    await mkdir(join(projectRoot, 'issues'), { recursive: true });
    await mkdir(join(projectRoot, 'completions'), { recursive: true });
    await mkdir(join(projectRoot, 'memory', 'journal'), { recursive: true });
    await mkdir(join(projectRoot, 'memory', 'topics'), { recursive: true });
    // `wx`: never clobber. The collision check makes an EEXIST here a race
    // (another writer landed the same name between plan and write) — refuse,
    // exactly as if the plan had seen it.
    try {
      await writeFile(join(projectRoot, 'CONFIG.md'), plan.configContent, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail(
          [`A project "${plan.dirName}" appeared while creating — nothing was overwritten. Pick another name.`],
          plan.warnings,
        );
      }
      throw err;
    }
    try {
      await writeFile(join(projectRoot, 'memory', 'CORE.md'), '', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // --- Create the workspace root (ADR-0017) ---------------------------------
    // Make the project's promised code location real. Planning, Just-talk, and
    // the no-repo scaffold Run all spawn their `claude` PTY with the workspace
    // root as cwd, and node-pty cannot chdir into a directory that does not
    // exist — the session dies immediately as "[process exited: 1]". Recursive,
    // so an existing root (a repo-full project's, or one pointed at an existing
    // folder like ~/Developer) is a harmless no-op; an EMPTY directory has no
    // `.git`, so self-heal never mistakes it for an appeared repo. A failure
    // here degrades to a warning — the Workbench project is already valid, and
    // is NOT undone. This directory lives outside ~/Workbench, so it is not part
    // of the workbench commit below.
    if (plan.workspaceRoot.length > 0) {
      try {
        await mkdir(expandTilde(plan.workspaceRoot, homeDir), { recursive: true });
      } catch (err) {
        outcome.warnings = [
          ...outcome.warnings,
          `Could not create the workspace root ${plan.workspaceRoot} (${err instanceof Error ? err.message : String(err)}) — create it by hand before planning in this project.`,
        ];
      }
    }

    // --- Append the registry entries ------------------------------------------
    // A repo-less project (ADR-0017) has NO entries: leave registry.md
    // untouched — registration is deferred until a repo actually appears
    // (self-heal via the Inbox). Only rewrite when there is something to add,
    // so an unchanged registry never churns a spurious commit.
    const registryPath = join(workbenchRoot, 'registry.md');
    const committedPaths = [plan.dirName];
    if (plan.registryAppend.length > 0) {
      const current = await readOrNull(registryPath);
      const next =
        current === null
          ? `# Registry\n\nMaps code-repo paths → Workbench projects (ADR-0015).\n\n## Entries\n\n${plan.registryAppend}`
          : `${current.replace(/\n*$/, '\n')}${plan.registryAppend}`;
      await writeFile(registryPath, next, 'utf8');
      committedPaths.push('registry.md');
    }

    // --- ONE boring commit: the new project dir (+ registry.md when touched) --
    const commit = await commitWorkbenchPaths(
      workbenchRoot,
      committedPaths,
      `${plan.dirName}: project onboarded`,
    );
    if (commit.error !== null) {
      // The files are on disk and correct; only the commit failed. Surface it —
      // the human decides whether to commit by hand — but don't undo the setup.
      outcome.warnings = [
        ...outcome.warnings,
        `Workbench commit failed (${commit.error}) — the project files are in place; commit ~/Workbench manually.`,
      ];
    }
    return outcome;
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }
}
