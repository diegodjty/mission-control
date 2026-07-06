/**
 * Workbench project discovery (main-process edge) — the file-I/O half of "which
 * projects does the Launcher list?" (issue 99).
 *
 * A workbench project is NOT the same thing as a registry entry. The registry
 * maps code-repo paths → projects, so a project only appears there once it has
 * a repo; a **repo-less project** (ADR-0017) is created as a `~/Workbench/<dir>`
 * skeleton with a `CONFIG.md` whose `repos:` map is empty and NO registry lines
 * (registration is deferred until a repo appears via self-heal). Listing from
 * the registry alone made a just-created repo-less project invisible — while its
 * directory still existed, so re-creating it was refused as a collision (issue
 * 99's exact report).
 *
 * The fix lists the UNION the pure `workbenchProjectNames` decides: every
 * `status: active` registry project AND every **repo-less** workbench directory
 * (a `CONFIG.md` that declares no repos). The repo-less test is deliberate: a
 * project whose registry entries were **removed** (issue 92 — removal is
 * registry-only, the directory and its populated `repos:` map stay on disk)
 * must NOT reappear here. Its CONFIG still names repos, so it fails the
 * repo-less test and stays gone; a true repo-less project (empty `repos:`)
 * shows until a repo registers it, at which point the registry carries it. The
 * two views collapse into one exactly when a repo exists. Never throws — an
 * unreadable workbench root, registry, or CONFIG all degrade to "nothing here".
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProjectConfig, parseRegistry } from '../shared/workbench-model';
import { workbenchProjectNames } from '../shared/launcher-model';

/** Read a file's text, or null when missing/unreadable — never throw. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The names of the directories directly under `workbenchRoot` that are
 * **repo-less projects**: a subdirectory (dotfiles skipped) with a `CONFIG.md`
 * whose `repos:` map is empty. This is what surfaces a repo-less project, which
 * has no registry entry — and, by requiring an empty `repos:` map, deliberately
 * does NOT resurrect a repo-full project whose registry entries were removed
 * (its CONFIG still names its repos).
 */
export async function repolessProjectDirNames(workbenchRoot: string): Promise<string[]> {
  let dirs: string[];
  try {
    const entries = await readdir(workbenchRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
  const repoless = await Promise.all(
    dirs.map(async (name) => {
      const config = await readOrNull(join(workbenchRoot, name, 'CONFIG.md'));
      if (config === null) return null; // not a project (no CONFIG.md)
      return Object.keys(parseProjectConfig(config).repos).length === 0 ? name : null;
    }),
  );
  return repoless.filter((n): n is string => n !== null);
}

/**
 * Every workbench project name the Launcher should list: the union of the
 * registry's `status: active` projects and the repo-less workbench directories.
 * Deduped and ascending (the caller re-orders by recency).
 */
export async function listWorkbenchProjectNames(workbenchRoot: string): Promise<string[]> {
  const registryContent = await readOrNull(join(workbenchRoot, 'registry.md'));
  const { entries } = parseRegistry(registryContent);
  const activeRegistryProjects = entries.filter((e) => e.active).map((e) => e.project);
  const repolessDirs = await repolessProjectDirNames(workbenchRoot);
  return workbenchProjectNames(activeRegistryProjects, repolessDirs);
}
