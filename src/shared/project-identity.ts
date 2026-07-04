/**
 * Project Identity (PURE) — what a Project *is* after ADR-0015 (issue 71).
 *
 * A Project used to be "a repo path". Now it is a **workbench entry** that
 * references one or more code repos — or, for repos with an in-repo `issues/`
 * (the legacy layout), still just the repo. This module turns whatever handle
 * the user opened — a repo path OR a workbench project directory — into ONE
 * canonical `ProjectIdentity`, so:
 *
 *   - opening a workbench project by its workbench dir or by ANY of its member
 *     repos lands on the SAME identity (same ownership `key`), which is what
 *     stops two Windows owning one Project under different aliases;
 *   - everything downstream (backlog watch, Map, ownership guard) reads the
 *     resolved `issuesRoot` and never cares which layout produced it — one
 *     code path downstream, two resolutions upstream.
 *
 * It builds on the workbench-model (issue 70): registry/CONFIG parsing and the
 * ADR's resolution order live there; this module only adds the *identity*
 * decision (which key, which roots, which default repo) on top.
 *
 * House PURE contract: no I/O, never throws. The filesystem facts it needs
 * (registry content, whether the workbench exists, a project's CONFIG content)
 * are handed in by the adapter (`src/main/project-resolver.ts`).
 */
import {
  expandTilde,
  parseProjectConfig,
  repoPathForIssue,
  resolveProject,
} from './workbench-model';

/** Drop a trailing `/` (but never the root `/` itself) and trim whitespace. */
function normalize(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** Last path segment, for a compact human label. */
function basename(path: string): string {
  const parts = normalize(path).split('/');
  return parts[parts.length - 1] || path;
}

/** True when `path` sits at or under `root`. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * One Project's canonical identity, however it was opened. `key` is the
 * ownership/registry key: the workbench project directory for a workbench
 * Project, the repo path for a legacy one. Both are absolute paths, so the
 * key doubles as something a human can read in an error message.
 */
export interface ProjectIdentity {
  /** THE identity: workbench project root, or legacy repo path. Normalized. */
  key: string;
  kind: 'workbench' | 'legacy';
  /** Compact display name (workbench project name / repo basename). */
  label: string;
  /** Where this Project's `NN-slug.md` issue files live. */
  issuesRoot: string;
  /** Where this Project's Receipts land. */
  completionsRoot: string;
  /**
   * The repo git/Run operations target until issue 72 makes Runs repo-
   * targeted per issue: the workbench CONFIG's default repo (tilde-expanded),
   * or — legacy — the repo itself. Falls back to `key` when a workbench
   * CONFIG names no usable repo, so callers always get *a* path, never null.
   */
  defaultRepoPath: string;
  /** Every member repo path (expanded, normalized). Legacy: just the repo. */
  repoPaths: string[];
}

/** Where an opened path was matched: which resolution produced the identity. */
export interface LocatedProject {
  kind: 'workbench' | 'legacy';
  /** Workbench only: the project directory name under the workbench root. */
  project: string | null;
  /** Workbench: `<workbenchRoot>/<project>`. Legacy: the opened repo path. */
  root: string;
}

export interface LocateInput {
  /** The handle the user opened: a repo path OR a workbench project dir. */
  openedPath: string;
  /** Raw `registry.md` content, or null when the workbench has none. */
  registryContent: string | null;
  /** The workbench root (already tilde-free), or null when it doesn't exist. */
  workbenchRoot: string | null;
  /** Edge-discovered home dir, for tilde-written registry/CONFIG paths. */
  homeDir: string | null;
}

/**
 * Decide WHICH Project an opened path belongs to (not yet its full shape):
 *
 *   1. a path at/under the workbench root names that workbench project
 *      directly (opening `~/Workbench/<project>` or anything inside it);
 *   2. else the registry maps the path (as a repo) to a workbench project —
 *      the same lookup a Worker's session would make (ADR-0015 order);
 *   3. else the path is a legacy Project: the repo is the identity.
 *
 * Opening the workbench root itself names no single project → legacy (the
 * caller will surface the missing-backlog error exactly as any repo without
 * `issues/` does today). Never throws.
 */
export function locateOpenedProject(input: LocateInput): LocatedProject {
  const opened = normalize(typeof input.openedPath === 'string' ? input.openedPath : '');
  const legacy: LocatedProject = { kind: 'legacy', project: null, root: opened };
  if (opened === '') return legacy;

  const workbenchRoot =
    typeof input.workbenchRoot === 'string' && input.workbenchRoot.length > 0
      ? normalize(input.workbenchRoot)
      : null;

  // 1. Opened the workbench project dir (or something inside it).
  if (workbenchRoot !== null && within(opened, workbenchRoot) && opened !== workbenchRoot) {
    const project = opened.slice(workbenchRoot.length + 1).split('/')[0];
    if (project.length > 0) {
      return { kind: 'workbench', project, root: `${workbenchRoot}/${project}` };
    }
  }

  // 2. Registry lookup by the opened path, exactly as a session cwd resolves.
  const resolved = resolveProject({
    registryContent: input.registryContent,
    workbenchRoot,
    homeDir: input.homeDir,
    cwd: opened,
    legacyIssuesPresent: false,
  });
  if (resolved.kind === 'workbench') {
    return { kind: 'workbench', project: resolved.project, root: resolved.projectRoot };
  }

  // 3. Legacy: the repo is the Project, as it always was.
  return legacy;
}

/**
 * Flesh a located Project out into its full identity. For a workbench project
 * the CONFIG content (may be null when missing/unreadable) supplies the
 * `repos:` map and default repo; a missing or repo-less CONFIG degrades to
 * `defaultRepoPath = key` rather than failing — the Map still opens, and Runs
 * against a repo-less workbench project are issue 72's concern. Never throws.
 */
export function projectIdentityFor(
  located: LocatedProject,
  configContent: string | null,
  homeDir: string | null,
): ProjectIdentity {
  const root = normalize(located.root);

  if (located.kind === 'legacy') {
    return {
      key: root,
      kind: 'legacy',
      label: basename(root),
      issuesRoot: `${root}/issues`,
      completionsRoot: `${root}/issues/completions`,
      defaultRepoPath: root,
      repoPaths: [root],
    };
  }

  const config = parseProjectConfig(configContent);
  const repoPaths = Object.values(config.repos).map((p) => normalize(expandTilde(p, homeDir)));
  const defaultRepo = repoPathForIssue(config, null);

  return {
    key: root,
    kind: 'workbench',
    label: located.project ?? basename(root),
    issuesRoot: `${root}/issues`,
    completionsRoot: `${root}/completions`,
    defaultRepoPath: defaultRepo.ok
      ? normalize(expandTilde(defaultRepo.path, homeDir))
      : root,
    repoPaths,
  };
}

/**
 * The one-call form: locate + resolve. The adapter reads the located
 * project's CONFIG between the two steps; callers that already have the
 * content (tests, fixtures) use this directly.
 */
export function resolveOpenedProject(
  input: LocateInput,
  configContent: string | null,
): ProjectIdentity {
  return projectIdentityFor(locateOpenedProject(input), configContent, input.homeDir);
}
