/**
 * Unit tests for the PURE workbench model (issue 70, ADR-0015).
 *
 * The Workbench (`~/Workbench/`) is one private repo holding every project's
 * pipeline artifacts. This module parses its three text shapes — `registry.md`
 * (repo path → project entries), a project `CONFIG.md` (`repos:` map +
 * `default_repo` + test commands), an issue's optional `repo:` frontmatter —
 * and makes the resolution decision (explicit paths → registry → legacy
 * fallback). House PURE contract: no I/O, any input yields a value, never a
 * throw. Tilde expansion is the edge's job: parsers return paths verbatim, and
 * the resolver only rewrites `~/` when the edge supplies `homeDir`.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRegistry,
  parseProjectConfig,
  parseIssueRepo,
  removeRegistryProject,
  repoPathForIssue,
  resolveProject,
} from './workbench-model';

// ---------------------------------------------------------------------------
// Fixtures — self-contained strings mirroring the real ~/Workbench shapes
// (issue 69's scaffold), including the traps: prose bullets, a fenced schema
// example, and an HTML comment around an inactive entry.
// ---------------------------------------------------------------------------

const REGISTRY = `# Registry

Maps **code-repo paths → Workbench projects**. Discovery order (ADR-0015):
explicit paths in the spawning prompt → this registry, looked up by cwd →
legacy fallback to an in-repo \`issues/\`.

## Schema (documented by example)

Each entry is one top-level list item with three fields:

\`\`\`markdown
- repo: <absolute path to a code repo; \`~\` allowed>
  project: <directory name under ~/Workbench/ holding that repo's artifacts>
  status: <active | inactive>
\`\`\`

- A **project** may appear in multiple entries (one per member repo).
- \`status: inactive\` means the mapping exists but must **not** resolve yet.

## Entries

<!-- INACTIVE until migration issue 76 moves the backlog here. -->
- repo: ~/Developer/mission-control
  project: mission-control
  status: inactive
- repo: /Users/dev/code/answering-api
  project: answering
  status: active
- repo: ~/code/answering-web
  project: answering
  status: active
`;

const CONFIG = `---
repos:
  app: ~/Developer/mission-control
  api: /Users/dev/code/answering-api
default_repo: app
---

# mission-control — project CONFIG

Workbench project config per ADR-0015. \`repos:\` maps a short key → code-repo
path; an issue's optional \`repo:\` frontmatter names one of these keys
(omitted = \`default_repo\`). One issue targets exactly one repo.

## Test commands

\`npm run test\` (unit) and \`npm run type-check\`, run after every change.
\`npm run test:e2e\` drives the assembled drain end-to-end.
`;

const ISSUE_WITH_REPO = `---
status: open
depends_on: [70]
repo: api
---

# 81 — Example cross-repo issue

## What to build

Something in the api repo.
`;

const ISSUE_WITHOUT_REPO = `---
status: open
depends_on: []
---

# 82 — Example single-repo issue
`;

// ---------------------------------------------------------------------------
// parseRegistry
// ---------------------------------------------------------------------------

describe('parseRegistry — well-formed registry', () => {
  const reg = parseRegistry(REGISTRY);

  it('finds every real entry, verbatim paths, active flags read from status', () => {
    expect(reg.entries).toEqual([
      { repo: '~/Developer/mission-control', project: 'mission-control', active: false },
      { repo: '/Users/dev/code/answering-api', project: 'answering', active: true },
      { repo: '~/code/answering-web', project: 'answering', active: true },
    ]);
  });

  it('does not mistake the fenced schema example for an entry', () => {
    expect(reg.entries.some((e) => e.repo.startsWith('<'))).toBe(false);
  });

  it('ignores prose bullets without noise', () => {
    expect(reg.notes).toEqual([]);
  });
});

describe('parseRegistry — malformed input (never throws, explicit notes)', () => {
  it('skips an entry with no project and records a note', () => {
    const reg = parseRegistry('## Entries\n\n- repo: /a/b\n  status: active\n');
    expect(reg.entries).toEqual([]);
    expect(reg.notes.length).toBe(1);
    expect(reg.notes[0]).toMatch(/\/a\/b/);
  });

  it('skips an entry with an empty repo path and records a note', () => {
    const reg = parseRegistry('- repo:\n  project: x\n  status: active\n');
    expect(reg.entries).toEqual([]);
    expect(reg.notes.length).toBe(1);
  });

  it('treats a missing or unrecognized status as inactive, with a note', () => {
    const missing = parseRegistry('- repo: /a\n  project: p\n');
    expect(missing.entries).toEqual([{ repo: '/a', project: 'p', active: false }]);
    expect(missing.notes.length).toBe(1);

    const junk = parseRegistry('- repo: /a\n  project: p\n  status: wibble\n');
    expect(junk.entries).toEqual([{ repo: '/a', project: 'p', active: false }]);
    expect(junk.notes.length).toBe(1);
  });

  it('ignores an entry that is entirely commented out', () => {
    const reg = parseRegistry('<!--\n- repo: /a\n  project: p\n  status: active\n-->\n');
    expect(reg.entries).toEqual([]);
  });

  it('yields empty results for empty and non-string input', () => {
    expect(parseRegistry('').entries).toEqual([]);
    expect(parseRegistry(null).entries).toEqual([]);
    expect(parseRegistry(42).entries).toEqual([]);
    expect(parseRegistry(undefined).entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseProjectConfig
// ---------------------------------------------------------------------------

describe('parseProjectConfig — well-formed CONFIG', () => {
  const cfg = parseProjectConfig(CONFIG);

  it('reads the repos: map with paths verbatim (no tilde expansion)', () => {
    expect(cfg.repos).toEqual({
      app: '~/Developer/mission-control',
      api: '/Users/dev/code/answering-api',
    });
  });

  it('reads default_repo', () => {
    expect(cfg.defaultRepo).toBe('app');
  });

  it('captures the Test commands section body verbatim', () => {
    expect(cfg.testCommands).toMatch(/npm run test/);
    expect(cfg.testCommands).toMatch(/npm run type-check/);
    expect(cfg.testCommands).toMatch(/npm run test:e2e/);
  });
});

describe('parseProjectConfig — malformed input (never throws)', () => {
  it('yields an empty config for content without frontmatter', () => {
    const cfg = parseProjectConfig('# Just a heading\n\nprose\n');
    expect(cfg.repos).toEqual({});
    expect(cfg.defaultRepo).toBeNull();
  });

  it('skips a repos entry with an empty path and records a note', () => {
    const cfg = parseProjectConfig('---\nrepos:\n  app:\n  api: /x\n---\n');
    expect(cfg.repos).toEqual({ api: '/x' });
    expect(cfg.notes.length).toBe(1);
  });

  it('stops the repos map at the first de-indented line', () => {
    const cfg = parseProjectConfig('---\nrepos:\n  app: /a\ndefault_repo: app\n---\n');
    expect(cfg.repos).toEqual({ app: '/a' });
    expect(cfg.defaultRepo).toBe('app');
  });

  it('yields empty results for empty and non-string input', () => {
    expect(parseProjectConfig('').repos).toEqual({});
    expect(parseProjectConfig(null).repos).toEqual({});
    expect(parseProjectConfig([]).repos).toEqual({});
  });

  it('has null testCommands when the section is absent', () => {
    expect(parseProjectConfig('---\ndefault_repo: app\n---\n# hi\n').testCommands).toBeNull();
  });

  it('parses workspace_root when present (ADR-0017), verbatim with ~/', () => {
    const cfg = parseProjectConfig('---\nworkspace_root: ~/Developer/billing\nrepos:\n---\n');
    expect(cfg.workspaceRoot).toBe('~/Developer/billing');
    expect(cfg.repos).toEqual({});
    expect(cfg.defaultRepo).toBeNull();
  });

  it('has null workspace_root when the scalar is absent (pre-0017 configs)', () => {
    expect(parseProjectConfig(CONFIG).workspaceRoot).toBeNull();
    expect(parseProjectConfig('---\nrepos:\n  app: /a\n---\n').workspaceRoot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseIssueRepo
// ---------------------------------------------------------------------------

describe('parseIssueRepo', () => {
  it('reads the optional repo: key from issue frontmatter', () => {
    expect(parseIssueRepo(ISSUE_WITH_REPO)).toBe('api');
  });

  it('is null when the issue has no repo: key', () => {
    expect(parseIssueRepo(ISSUE_WITHOUT_REPO)).toBeNull();
  });

  it('tolerates quotes around the value', () => {
    expect(parseIssueRepo('---\nrepo: "api"\n---\n')).toBe('api');
  });

  it('does not read a repo: line outside the frontmatter', () => {
    expect(parseIssueRepo('# heading\n\nrepo: api\n')).toBeNull();
  });

  it('is null for empty and non-string input', () => {
    expect(parseIssueRepo('')).toBeNull();
    expect(parseIssueRepo(null)).toBeNull();
    expect(parseIssueRepo(7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// repoPathForIssue — one issue targets exactly one repo
// ---------------------------------------------------------------------------

describe('repoPathForIssue', () => {
  const cfg = parseProjectConfig(CONFIG);

  it('resolves an explicit known key', () => {
    expect(repoPathForIssue(cfg, 'api')).toEqual({
      ok: true,
      key: 'api',
      path: '/Users/dev/code/answering-api',
    });
  });

  it('resolves to an explicit error value on an unknown key — never a guessed path', () => {
    expect(repoPathForIssue(cfg, 'web')).toEqual({
      ok: false,
      error: 'unknown-repo-key',
      key: 'web',
    });
  });

  it('falls back to default_repo when the issue names no repo', () => {
    expect(repoPathForIssue(cfg, null)).toEqual({
      ok: true,
      key: 'app',
      path: '~/Developer/mission-control',
    });
  });

  it('needs no repo: field for a single-repo project even without default_repo', () => {
    const single = parseProjectConfig('---\nrepos:\n  app: /only/repo\n---\n');
    expect(repoPathForIssue(single, null)).toEqual({ ok: true, key: 'app', path: '/only/repo' });
  });

  it('errors when default_repo names an unknown key', () => {
    const bad = parseProjectConfig('---\nrepos:\n  app: /a\ndefault_repo: gone\n---\n');
    expect(repoPathForIssue(bad, null)).toEqual({
      ok: false,
      error: 'unknown-default-repo',
      key: 'gone',
    });
  });

  it('errors when a multi-repo project has no default and the issue names no repo', () => {
    const multi = parseProjectConfig('---\nrepos:\n  a: /a\n  b: /b\n---\n');
    expect(repoPathForIssue(multi, null)).toEqual({ ok: false, error: 'ambiguous-repo', key: null });
  });

  it('errors when the config has no repos at all', () => {
    const empty = parseProjectConfig('');
    expect(repoPathForIssue(empty, null)).toEqual({ ok: false, error: 'no-repos', key: null });
  });
});

// ---------------------------------------------------------------------------
// resolveProject — explicit paths → registry lookup → legacy fallback
// ---------------------------------------------------------------------------

const HOME = '/Users/dev';
const WORKBENCH = '/Users/dev/Workbench';

describe('resolveProject — explicit paths (first in the order)', () => {
  it('uses an explicit issuesRoot and derives its siblings from the project root', () => {
    const res = resolveProject({
      explicit: { issuesRoot: '/Users/dev/Workbench/mission-control/issues' },
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/Developer/mission-control',
      legacyIssuesPresent: true,
    });
    expect(res).toEqual({
      kind: 'workbench',
      source: 'explicit',
      project: 'mission-control',
      projectRoot: '/Users/dev/Workbench/mission-control',
      issuesRoot: '/Users/dev/Workbench/mission-control/issues',
      completionsRoot: '/Users/dev/Workbench/mission-control/completions',
      memoryRoot: '/Users/dev/Workbench/mission-control/memory',
    });
  });

  it('honors explicitly given completions/memory roots verbatim', () => {
    const res = resolveProject({
      explicit: {
        issuesRoot: '/wb/p/issues',
        completionsRoot: '/elsewhere/done',
        memoryRoot: '/elsewhere/mem',
      },
      cwd: '/code/repo',
      legacyIssuesPresent: false,
    });
    expect(res).toMatchObject({
      kind: 'workbench',
      source: 'explicit',
      completionsRoot: '/elsewhere/done',
      memoryRoot: '/elsewhere/mem',
    });
  });

  it('ignores an explicit object without an issuesRoot and falls through', () => {
    const res = resolveProject({
      explicit: { completionsRoot: '/elsewhere/done' },
      cwd: '/code/unknown',
      legacyIssuesPresent: true,
    });
    expect(res.kind).toBe('legacy');
  });
});

describe('resolveProject — registry lookup by cwd (second in the order)', () => {
  it('resolves an active entry to workbench paths under the workbench root', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-api',
      legacyIssuesPresent: true, // registry outranks the legacy fallback
    });
    expect(res).toEqual({
      kind: 'workbench',
      source: 'registry',
      project: 'answering',
      projectRoot: '/Users/dev/Workbench/answering',
      issuesRoot: '/Users/dev/Workbench/answering/issues',
      completionsRoot: '/Users/dev/Workbench/answering/completions',
      memoryRoot: '/Users/dev/Workbench/answering/memory',
    });
  });

  it('matches a tilde-written entry only via the edge-supplied homeDir', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-web',
      legacyIssuesPresent: false,
    });
    expect(res).toMatchObject({ kind: 'workbench', project: 'answering' });
  });

  it('matches a cwd inside a registered repo (subdirectory of the repo path)', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-api/src/deep',
      legacyIssuesPresent: false,
    });
    expect(res).toMatchObject({ kind: 'workbench', project: 'answering' });
  });

  it('does not match a sibling path that merely shares a prefix', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-api-v2',
      legacyIssuesPresent: false,
    });
    expect(res.kind).toBe('unresolved');
  });

  it('skips inactive entries — the repo behaves as unregistered (legacy fallback)', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/Users/dev/Developer/mission-control',
      legacyIssuesPresent: true,
    });
    expect(res).toEqual({
      kind: 'legacy',
      issuesRoot: '/Users/dev/Developer/mission-control/issues',
      completionsRoot: '/Users/dev/Developer/mission-control/issues/completions',
    });
  });

  it('without homeDir, a tilde entry cannot match an absolute cwd', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      cwd: '/Users/dev/code/answering-web',
      legacyIssuesPresent: false,
    });
    expect(res.kind).toBe('unresolved');
  });

  it('is unresolved (not a guess) when an entry matches but no workbench root is derivable', () => {
    const res = resolveProject({
      registryContent: '- repo: /Users/dev/code/answering-api\n  project: answering\n  status: active\n',
      cwd: '/Users/dev/code/answering-api',
      legacyIssuesPresent: false,
    });
    expect(res.kind).toBe('unresolved');
    expect(res.kind === 'unresolved' && res.reason).toMatch(/workbench root/i);
  });

  it('defaults the workbench root to <homeDir>/Workbench when only homeDir is given', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-api',
      legacyIssuesPresent: false,
    });
    expect(res).toMatchObject({
      kind: 'workbench',
      projectRoot: '/Users/dev/Workbench/answering',
    });
  });
});

describe('resolveProject — legacy fallback and unresolved (last in the order)', () => {
  it('falls back to the in-repo layout when the cwd is unregistered', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/somewhere/qa-sandbox',
      legacyIssuesPresent: true,
    });
    expect(res).toEqual({
      kind: 'legacy',
      issuesRoot: '/somewhere/qa-sandbox/issues',
      completionsRoot: '/somewhere/qa-sandbox/issues/completions',
    });
  });

  it('works with no registry at all (missing workbench)', () => {
    const res = resolveProject({ cwd: '/somewhere/qa-sandbox', legacyIssuesPresent: true });
    expect(res.kind).toBe('legacy');
  });

  it('is unresolved when nothing applies', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: WORKBENCH,
      homeDir: HOME,
      cwd: '/somewhere/plain-repo',
      legacyIssuesPresent: false,
    });
    expect(res.kind).toBe('unresolved');
    expect(res.kind === 'unresolved' && res.reason.length > 0).toBe(true);
  });

  it('tolerates trailing slashes on cwd and workbench root', () => {
    const res = resolveProject({
      registryContent: REGISTRY,
      workbenchRoot: '/Users/dev/Workbench/',
      homeDir: HOME,
      cwd: '/Users/dev/code/answering-api/',
      legacyIssuesPresent: false,
    });
    expect(res).toMatchObject({
      kind: 'workbench',
      issuesRoot: '/Users/dev/Workbench/answering/issues',
    });
  });
});

// ---------------------------------------------------------------------------
// removeRegistryProject — the Launcher's Remove project (issue 92): drop every
// entry mapping to one project, touch nothing else. What parseRegistry sees as
// an entry for the project is exactly what goes; docs (fenced examples, HTML
// comments) and other projects' entries survive byte-for-byte.
// ---------------------------------------------------------------------------

describe('removeRegistryProject', () => {
  it('removes every entry of a multi-repo project and reports the count', () => {
    const { content, removed } = removeRegistryProject(REGISTRY, 'answering');
    expect(removed).toBe(2);
    const after = parseRegistry(content);
    expect(after.entries).toEqual([
      { repo: '~/Developer/mission-control', project: 'mission-control', active: false },
    ]);
    expect(content).not.toContain('answering-api');
    expect(content).not.toContain('answering-web');
  });

  it('leaves the registry prose, fenced schema example, and comments intact', () => {
    const { content } = removeRegistryProject(REGISTRY, 'answering');
    expect(content).toContain('## Schema (documented by example)');
    expect(content).toContain('status: <active | inactive>'); // the fenced example
    expect(content).toContain('<!-- INACTIVE until migration issue 76 moves the backlog here. -->');
    expect(content).toContain('# Registry');
  });

  it('removes inactive entries of the named project too — removal is total', () => {
    const { content, removed } = removeRegistryProject(REGISTRY, 'mission-control');
    expect(removed).toBe(1);
    expect(parseRegistry(content).entries.map((e) => e.project)).toEqual([
      'answering',
      'answering',
    ]);
  });

  it('returns the content unchanged (and removed: 0) for an unknown project', () => {
    const { content, removed } = removeRegistryProject(REGISTRY, 'no-such-project');
    expect(removed).toBe(0);
    expect(content).toBe(REGISTRY);
  });

  it('never removes an entry-shaped block inside a code fence', () => {
    const doc = [
      '## Entries',
      '',
      '```markdown',
      '- repo: ~/code/example',
      '  project: victim',
      '  status: active',
      '```',
      '',
      '- repo: ~/code/real',
      '  project: victim',
      '  status: active',
      '',
    ].join('\n');
    const { content, removed } = removeRegistryProject(doc, 'victim');
    expect(removed).toBe(1);
    expect(content).toContain('~/code/example'); // the fenced example survives
    expect(content).not.toContain('~/code/real');
  });

  it('never removes an entry-shaped block inside an HTML comment', () => {
    const doc = [
      '<!--',
      '- repo: ~/code/parked',
      '  project: victim',
      '  status: active',
      '-->',
      '- repo: ~/code/live',
      '  project: victim',
      '  status: active',
      '',
    ].join('\n');
    const { content, removed } = removeRegistryProject(doc, 'victim');
    expect(removed).toBe(1);
    expect(content).toContain('~/code/parked');
    expect(content).not.toContain('~/code/live');
  });

  it('does not pile up blank lines where a blank-separated entry was removed', () => {
    const doc = [
      '## Entries',
      '',
      '- repo: ~/code/a',
      '  project: gone',
      '  status: active',
      '',
      '- repo: ~/code/b',
      '  project: stays',
      '  status: active',
      '',
    ].join('\n');
    const { content, removed } = removeRegistryProject(doc, 'gone');
    expect(removed).toBe(1);
    expect(content).not.toContain('\n\n\n');
    expect(parseRegistry(content).entries).toEqual([
      { repo: '~/code/b', project: 'stays', active: true },
    ]);
  });

  it('keeps packed neighbours parseable when a middle entry goes', () => {
    // buildRegistryAppend packs entries with no blank line between them.
    const doc = [
      '- repo: ~/code/a',
      '  project: first',
      '  status: active',
      '- repo: ~/code/b',
      '  project: middle',
      '  status: active',
      '- repo: ~/code/c',
      '  project: last',
      '  status: active',
      '',
    ].join('\n');
    const { content, removed } = removeRegistryProject(doc, 'middle');
    expect(removed).toBe(1);
    expect(parseRegistry(content).entries.map((e) => e.project)).toEqual(['first', 'last']);
  });

  it('degrades non-string content and an empty project name to a no-op', () => {
    expect(removeRegistryProject(undefined, 'x')).toEqual({ content: '', removed: 0 });
    expect(removeRegistryProject(42, 'x')).toEqual({ content: '', removed: 0 });
    expect(removeRegistryProject(REGISTRY, '')).toEqual({ content: REGISTRY, removed: 0 });
  });
});
