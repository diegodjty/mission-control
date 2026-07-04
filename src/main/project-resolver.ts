/**
 * Project Resolver — the file-I/O adapter for the pure project-identity layer
 * (issue 71, ADR-0015).
 *
 * Given the handle a user opened (a repo path or a workbench project dir), it
 * gathers the filesystem facts the pure decision needs — does `~/Workbench`
 * exist, what does its `registry.md` say, what does the located project's
 * `CONFIG.md` say — and returns the canonical `ProjectIdentity`. All decisions
 * (which project, which key, which roots) live in `src/shared/project-identity`;
 * this file only reads files.
 *
 * Never throws: a missing workbench, registry, or CONFIG degrades exactly as
 * the pure layer specifies (legacy fallback / key-rooted defaults), so opening
 * the QA sandbox by repo path behaves precisely as it did before workbenches
 * existed.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  locateOpenedProject,
  projectIdentityFor,
  type ProjectIdentity,
} from '../shared/project-identity';

/** Injection points so tests can aim the resolver at a temp "home". */
export interface ResolveOptions {
  /** Home directory override (default `os.homedir()`). */
  homeDir?: string;
}

/** Read a file's text, or null when missing/unreadable — never throw. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** True when `path` exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve an opened path to its canonical Project identity: workbench project
 * (by dir or by registered member repo) or legacy repo.
 */
export async function resolveProjectIdentity(
  openedPath: string,
  opts: ResolveOptions = {},
): Promise<ProjectIdentity> {
  const homeDir = opts.homeDir ?? homedir();
  const workbenchCandidate = join(homeDir, 'Workbench');
  const workbenchRoot = (await isDirectory(workbenchCandidate)) ? workbenchCandidate : null;
  const registryContent =
    workbenchRoot === null ? null : await readOrNull(join(workbenchRoot, 'registry.md'));

  const located = locateOpenedProject({
    openedPath,
    registryContent,
    workbenchRoot,
    homeDir,
  });

  const configContent =
    located.kind === 'workbench' ? await readOrNull(join(located.root, 'CONFIG.md')) : null;

  return projectIdentityFor(located, configContent, homeDir);
}
