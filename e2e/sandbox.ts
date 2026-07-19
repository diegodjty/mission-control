/**
 * E2E sandbox (issue 63) — a throwaway git repo seeded like the QA sandbox
 * (`mc-qa-sandbox/repo-a`), plus the deterministic test doubles the drain
 * harness needs: a scripted fake PTY (records what was typed/submitted, so
 * chat delivery is observable) and small wait/poll helpers.
 *
 * The seeded backlog mirrors the QA sandbox's shape 1:1 so the automated suite
 * exercises the same walkthrough the human runs (issue 58):
 *
 *   01-foundation      done  — seeded finished, like repo-a's root commit
 *   02-second-step     open  — first drainable issue
 *   03-blocked-on-02   open  — dep-blocked (depends_on: [2])
 *   04-independent     open
 *   05-manual-check    open  — HITL (`hitl: true`)
 *   06-parallel-a      open
 *   07-parallel-b      open
 *   08-blocked-on-hitl open  — dep-blocked behind the HITL 05 (depends_on: [5]),
 *                              so issue 64's "a park blocks only its dependents"
 *                              rule is observable: 08 must never start while 05
 *                              is parked, while 06/07 still run.
 *
 * No LLM anywhere: Workers are driven by `fake-worker.ts`, and the "Dispatcher
 * chat" is the FakePty below.
 *
 * Issue 75 adds the WORKBENCH fixture beside the legacy one (ADR-0015): a temp
 * `workbench/` git repo (registry.md, a `proj/` project with a two-repo
 * `repos:` CONFIG, the WORKBENCH_ISSUES backlog, a memory skeleton) plus two
 * temp code repos that hold no pipeline artifacts at all. The legacy seeding
 * above is untouched — both layouts stay exercised, per the ADR's consequence.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBMIT_KEY } from '../src/shared/submit-sequence';

const exec = promisify(execFile);

/** Run git in `cwd`, returning stdout. Throws on non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** One seeded sandbox issue. */
export interface SandboxIssue {
  id: number;
  slug: string;
  title: string;
  status: 'open' | 'wip' | 'done';
  dependsOn: number[];
  hitl: boolean;
  /**
   * The issue's declared `repo:` frontmatter key (ADR-0015, issue 72) — a key
   * into its workbench project CONFIG's `repos:` map. Absent/null = the
   * project's default repo (and every legacy issue, whose files carry no
   * `repo:` line at all — byte-identical to before the workbench existed).
   */
  repoKey?: string | null;
}

/** The QA-sandbox-shaped backlog (see file header). */
export const SANDBOX_ISSUES: readonly SandboxIssue[] = [
  { id: 1, slug: '01-foundation', title: 'Foundation', status: 'done', dependsOn: [], hitl: false },
  { id: 2, slug: '02-second-step', title: 'Second step', status: 'open', dependsOn: [], hitl: false },
  { id: 3, slug: '03-blocked-on-02', title: 'Blocked on 02', status: 'open', dependsOn: [2], hitl: false },
  { id: 4, slug: '04-independent', title: 'Independent', status: 'open', dependsOn: [], hitl: false },
  { id: 5, slug: '05-manual-check', title: 'Manual check (HITL)', status: 'open', dependsOn: [], hitl: true },
  { id: 6, slug: '06-parallel-a', title: 'Parallel A', status: 'open', dependsOn: [], hitl: false },
  { id: 7, slug: '07-parallel-b', title: 'Parallel B', status: 'open', dependsOn: [], hitl: false },
  { id: 8, slug: '08-blocked-on-hitl', title: 'Blocked on HITL 05', status: 'open', dependsOn: [5], hitl: false },
];

/** Look up a seeded issue by id (throws on a bad id — a test bug). */
export function sandboxIssue(id: number): SandboxIssue {
  const issue = SANDBOX_ISSUES.find((i) => i.id === id);
  if (!issue) throw new Error(`no sandbox issue ${id}`);
  return issue;
}

/**
 * The full text of one backlog issue file, in the exact `NN-slug.md` format the
 * Backlog Model parses (frontmatter `status`/`depends_on`/optional `hitl`, then
 * a `# NN — Title` heading). Standalone on purpose (no `## Parent`), so every
 * seeded issue is drain-eligible the way repo-a's are.
 */
export function issueFileContent(
  issue: Pick<SandboxIssue, 'id' | 'title' | 'dependsOn' | 'hitl'> &
    Partial<Pick<SandboxIssue, 'repoKey'>>,
  status: 'open' | 'wip' | 'done',
): string {
  const hitlLine = issue.hitl ? 'hitl: true\n' : '';
  // The optional `repo:` target (issue 72). Legacy issues never set it, so
  // their files stay byte-identical to the pre-workbench fixture.
  const repoLine = issue.repoKey ? `repo: ${issue.repoKey}\n` : '';
  return (
    `---\nstatus: ${status}\ndepends_on: [${issue.dependsOn.join(', ')}]\n${hitlLine}${repoLine}---\n\n` +
    `# ${issue.id} — ${issue.title}\n\nScripted sandbox issue for the e2e drain harness.\n`
  );
}

export interface Sandbox {
  /** The scratch dir holding the repo (rm -rf this in afterEach). */
  scratch: string;
  /** The seeded git repo (the "Project checkout", on `main`). */
  repo: string;
  /** The repo's `issues/` dir (what the Receipt watcher points at). */
  issuesDir: string;
}

/** Create and seed the sandbox repo with the QA-sandbox backlog, committed. */
export async function seedSandbox(): Promise<Sandbox> {
  const scratch = await mkdtemp(join(tmpdir(), 'mc-drain-e2e-'));
  const repo = join(scratch, 'repo');
  const issuesDir = join(repo, 'issues');
  await mkdir(issuesDir, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'e2e@example.com');
  await git(repo, 'config', 'user.name', 'MC Drain E2E');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), '# e2e sandbox repo\n');
  for (const issue of SANDBOX_ISSUES) {
    await writeFile(join(issuesDir, `${issue.slug}.md`), issueFileContent(issue, issue.status));
  }
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial: seeded QA-sandbox backlog');
  return { scratch, repo, issuesDir };
}

// --- Workbench fixture (issue 75, ADR-0015) ------------------------------------

/**
 * The workbench-shaped backlog (issue 75): a two-repo project whose issues
 * declare `repo:` targets, with a cross-repo `depends_on` chain (02 in repo-a
 * unblocks 03 in repo-b), an HITL park (05), an issue naming an UNKNOWN repo
 * key (06 — its Run must block without stalling siblings; 07 depends on it and
 * stays blocked naturally), and a post-park sibling (08) proving the drain
 * continues past both the park and the unknown-key block.
 */
export const WORKBENCH_ISSUES: readonly SandboxIssue[] = [
  { id: 1, slug: '01-foundation', title: 'Foundation', status: 'done', dependsOn: [], hitl: false },
  { id: 2, slug: '02-core-api', title: 'Core API', status: 'open', dependsOn: [], hitl: false, repoKey: 'a' },
  { id: 3, slug: '03-b-consumes-core', title: 'B consumes core', status: 'open', dependsOn: [2], hitl: false, repoKey: 'b' },
  { id: 4, slug: '04-b-independent', title: 'B independent', status: 'open', dependsOn: [], hitl: false, repoKey: 'b' },
  { id: 5, slug: '05-manual-check', title: 'Manual check (HITL)', status: 'open', dependsOn: [], hitl: true, repoKey: 'a' },
  { id: 6, slug: '06-unknown-repo', title: 'Unknown repo target', status: 'open', dependsOn: [], hitl: false, repoKey: 'rogue' },
  { id: 7, slug: '07-blocked-on-unknown', title: 'Blocked on unknown-repo 06', status: 'open', dependsOn: [6], hitl: false },
  { id: 8, slug: '08-a-followup', title: 'A followup', status: 'open', dependsOn: [], hitl: false, repoKey: 'a' },
];

/** Look up a seeded workbench issue by id (throws on a bad id — a test bug). */
export function workbenchIssue(id: number): SandboxIssue {
  const issue = WORKBENCH_ISSUES.find((i) => i.id === id);
  if (!issue) throw new Error(`no workbench sandbox issue ${id}`);
  return issue;
}

/** The distinctive CORE.md fact the memory scenarios assert rides the prompts. */
export const WORKBENCH_CORE_FACT =
  'The fixture tab width is exactly 7 spaces (distinctive workbench core fact).';

export interface WorkbenchSandbox {
  /** The scratch dir holding everything (rm -rf this in afterEach). */
  scratch: string;
  /** The Workbench root — ONE private git repo (`~/Workbench/` in real life). */
  workbenchRoot: string;
  /** The fixture project's directory: `<workbenchRoot>/proj`. */
  projectRoot: string;
  /** `<projectRoot>/issues` — where the `NN-slug.md` files live. */
  issuesRoot: string;
  /** `<projectRoot>/completions` — the ONE Receipt root for the project. */
  completionsRoot: string;
  /** `<projectRoot>/memory` — CORE.md + journal/. */
  memoryRoot: string;
  /** Code repo `a` (the CONFIG's default repo). Holds NO issues/ at all. */
  repoA: string;
  /** Code repo `b`. Holds NO issues/ at all. */
  repoB: string;
  /** The raw `registry.md` content, as the identity layer reads it. */
  registryContent: string;
  /** The raw project `CONFIG.md` content. */
  configContent: string;
}

/** Init a plain seeded code repo (README committed on `main`, no issues/). */
async function seedCodeRepo(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.email', 'e2e@example.com');
  await git(path, 'config', 'user.name', 'MC Drain E2E');
  await git(path, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'README.md'), `# e2e code repo ${name}\n`);
  await git(path, 'add', '.');
  await git(path, 'commit', '-m', `initial: seed ${name}`);
}

/**
 * Create and seed the workbench fixture: a temp Workbench git repo (registry,
 * project CONFIG with a two-repo `repos:` map, the WORKBENCH_ISSUES backlog,
 * a memory skeleton) plus two temp code repos that hold code ONLY — the
 * pipeline artifacts live exclusively in the workbench (ADR-0015's boundary).
 */
export async function seedWorkbenchSandbox(): Promise<WorkbenchSandbox> {
  const scratch = await mkdtemp(join(tmpdir(), 'mc-workbench-e2e-'));
  const repoA = join(scratch, 'repo-a');
  const repoB = join(scratch, 'repo-b');
  await seedCodeRepo(repoA, 'repo-a');
  await seedCodeRepo(repoB, 'repo-b');

  const workbenchRoot = join(scratch, 'workbench');
  const projectRoot = join(workbenchRoot, 'proj');
  const issuesRoot = join(projectRoot, 'issues');
  const completionsRoot = join(projectRoot, 'completions');
  const memoryRoot = join(projectRoot, 'memory');
  await mkdir(issuesRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });

  const registryContent =
    `# Workbench registry\n\n` +
    `Repo path → project mapping (bare-session discovery, ADR-0015).\n\n` +
    `- repo: ${repoA}\n` +
    `  project: proj\n` +
    `  status: active\n` +
    `- repo: ${repoB}\n` +
    `  project: proj\n` +
    `  status: active\n`;
  await writeFile(join(workbenchRoot, 'registry.md'), registryContent);

  const configContent =
    `---\n` +
    `repos:\n` +
    `  a: ${repoA}\n` +
    `  b: ${repoB}\n` +
    `default_repo: a\n` +
    `---\n\n` +
    `# proj — e2e workbench fixture project\n\n` +
    `## Test commands\n\n` +
    `(scripted fixture — no tests to run)\n`;
  await writeFile(join(projectRoot, 'CONFIG.md'), configContent);

  for (const issue of WORKBENCH_ISSUES) {
    await writeFile(join(issuesRoot, `${issue.slug}.md`), issueFileContent(issue, issue.status));
  }
  await writeFile(join(memoryRoot, 'CORE.md'), `- ${WORKBENCH_CORE_FACT}\n`);

  await git(workbenchRoot, 'init', '-b', 'main');
  await git(workbenchRoot, 'config', 'user.email', 'e2e@example.com');
  await git(workbenchRoot, 'config', 'user.name', 'MC Drain E2E');
  await git(workbenchRoot, 'config', 'commit.gpgsign', 'false');
  await git(workbenchRoot, 'add', '.');
  await git(workbenchRoot, 'commit', '-m', 'initial: seeded workbench fixture');

  return {
    scratch,
    workbenchRoot,
    projectRoot,
    issuesRoot,
    completionsRoot,
    memoryRoot,
    repoA,
    repoB,
    registryContent,
    configContent,
  };
}

// --- Fake PTY -----------------------------------------------------------------

/** One fake chat PTY session: every write is recorded; dead sessions throw. */
export interface FakePtySession {
  id: string;
  alive: boolean;
  writes: string[];
}

/**
 * The scripted stand-in for the Dispatcher chat PTY. `write` behaves like the
 * real PTY manager's edge: writing to a missing or killed session THROWS (the
 * failure mode issue 60 hardens the pump against). `submittedMessages`
 * reconstructs what actually reached the chat: text typed since the last
 * submit, terminated by the submit key.
 */
export class FakePty {
  private readonly sessions = new Map<string, FakePtySession>();

  create(id: string): FakePtySession {
    const session: FakePtySession = { id, alive: true, writes: [] };
    this.sessions.set(id, session);
    return session;
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.alive = false;
  }

  write = (sessionId: string, data: string): void => {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) {
      throw new Error(`write to dead PTY session ${sessionId}`);
    }
    session.writes.push(data);
  };

  session(id: string): FakePtySession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`no fake PTY session ${id}`);
    return session;
  }

  /** The messages fully typed-and-SUBMITTED into a session, in order. */
  submittedMessages(id: string): string[] {
    const session = this.session(id);
    const messages: string[] = [];
    let line = '';
    for (const chunk of session.writes) {
      if (chunk === SUBMIT_KEY) {
        messages.push(line);
        line = '';
      } else {
        line += chunk;
      }
    }
    return messages;
  }
}

// --- Wait helpers ---------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `predicate` is true (real watchers/timers are in play, so the
 * suite waits on observed effects, never on guessed sleeps). Throws with the
 * label after `timeoutMs` so a hang fails loudly instead of hitting the runner
 * timeout with no context.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}
