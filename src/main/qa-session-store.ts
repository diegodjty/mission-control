/**
 * Guided QA session store — the fs edge for issue 198's durable per-pass QA
 * Receipts. Lives under the project's Workbench `qa/` directory (NOT
 * userData — unlike issue 156's ephemeral checklist tick-store), one file per
 * pass, so the on-disk file IS the session: no separate app-level state to
 * fall out of sync, and quitting/relaunching mid-session resumes from exactly
 * what the latest pass file says.
 *
 * The pure parse/serialize/derive logic lives in `shared/qa-session-model.ts`;
 * this file only reads/writes/lists.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyStepUpdate,
  markDoneFlipped,
  parseQaPass,
  qaPassFileName,
  qaPassFilePrefix,
  recordFiledIssue as recordFiledIssueOnPass,
  resumeOrStartSession,
  serializeQaPass,
  type QaPass,
  type QaStepVerdict,
} from '../shared/qa-session-model';

/** Read a file's text, or null when missing/unreadable — never throw. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every parsed pass on disk for `issueFileName`, any order. An unreadable
 * `qaRoot` (not yet created) or an unparseable individual pass file degrades
 * to skipping it — never throws.
 */
export async function listQaPasses(qaRoot: string, issueFileName: string): Promise<QaPass[]> {
  let names: string[];
  try {
    names = await readdir(qaRoot);
  } catch {
    return [];
  }
  const prefix = qaPassFilePrefix(issueFileName);
  const matching = names.filter((n) => n.startsWith(prefix) && n.endsWith('.md'));
  const passes = await Promise.all(
    matching.map(async (name) => parseQaPass(await readOrNull(join(qaRoot, name)))),
  );
  return passes.filter((p): p is QaPass => p !== null);
}

/**
 * Load the session to show for `stepCount` steps: resumes the latest
 * in-progress pass, or hands back a not-yet-written fresh pass (pass 1, or
 * N+1 when the latest on disk is decided) — the caller only writes it to disk
 * once the human records a verdict (see `recordQaStepVerdict`), so merely
 * opening the detail panel never creates an empty pass file.
 */
export async function loadQaSession(
  qaRoot: string,
  issueFileName: string,
  stepCount: number,
  nowIso: string,
): Promise<QaPass> {
  const existing = await listQaPasses(qaRoot, issueFileName);
  return resumeOrStartSession(existing, issueFileName, stepCount, nowIso);
}

/** Write one pass to disk (its own file — never a prior pass's file). */
async function writePass(qaRoot: string, pass: QaPass): Promise<void> {
  await mkdir(qaRoot, { recursive: true });
  await writeFile(join(qaRoot, qaPassFileName(pass.issue, pass.pass)), serializeQaPass(pass), 'utf8');
}

/**
 * Record one step's verdict/note for `issueFileName`'s current session and
 * persist it immediately (write-incrementally, per the acceptance bar): loads
 * the session (resume-or-start), applies the update, and writes the resulting
 * pass to its own file. Returns the updated pass.
 */
export async function recordQaStepVerdict(
  qaRoot: string,
  issueFileName: string,
  stepCount: number,
  index: number,
  update: { verdict?: QaStepVerdict; note?: string | null },
  nowIso: string,
): Promise<QaPass> {
  const session = await loadQaSession(qaRoot, issueFileName, stepCount, nowIso);
  const updated = applyStepUpdate(session, index, update, nowIso);
  await writePass(qaRoot, updated);
  return updated;
}

/** The highest-numbered pass on disk, or null when none exists yet. */
async function latestPass(qaRoot: string, issueFileName: string): Promise<QaPass | null> {
  const existing = await listQaPasses(qaRoot, issueFileName);
  return existing.reduce<QaPass | null>(
    (acc, p) => (acc === null || p.pass > acc.pass ? p : acc),
    null,
  );
}

/**
 * Start a fresh pass explicitly (re-QA on a decided session) even when the
 * latest pass is still in progress — used by an explicit "start re-QA"
 * action, distinct from `loadQaSession`'s resume-by-default behavior. Writes
 * the new pass immediately so it is visible on disk right away (an empty,
 * all-unset pass is still a real pass — otherwise pass N+1 wouldn't exist
 * until the first verdict, and a relaunch before that would resume pass N
 * instead of the fresh one the human asked to start).
 */
export async function startNewQaPass(
  qaRoot: string,
  issueFileName: string,
  stepCount: number,
  nowIso: string,
): Promise<QaPass> {
  const highest = await latestPass(qaRoot, issueFileName);
  const nextPass = (highest?.pass ?? 0) + 1;
  const fresh: QaPass = {
    issue: issueFileName,
    pass: nextPass,
    started: nowIso,
    finished: null,
    results: resumeOrStartSession([], issueFileName, stepCount, nowIso).results,
    verdict: 'in-progress',
    doneFlipped: false,
  };
  await writePass(qaRoot, fresh);
  return fresh;
}

/**
 * Record a filed issue's number against one failed step (issue 199), on the
 * LATEST pass on disk — never `loadQaSession`'s resume-or-start, which would
 * mistake a just-decided (failed) pass for one to roll past into a fresh
 * pass N+1. Falls back to a fresh pass only when none exists yet (should not
 * happen in practice — filing follows a recorded fail verdict).
 */
export async function recordFiledIssue(
  qaRoot: string,
  issueFileName: string,
  stepCount: number,
  index: number,
  issueId: number,
  nowIso: string,
): Promise<QaPass> {
  const session = (await latestPass(qaRoot, issueFileName)) ?? (await loadQaSession(qaRoot, issueFileName, stepCount, nowIso));
  const updated = recordFiledIssueOnPass(session, index, issueId);
  await writePass(qaRoot, updated);
  return updated;
}

/**
 * Record that the green one-click done-flip (issue 199) happened for the
 * LATEST pass on disk — the same latest-pass shape as `recordFiledIssue`, for
 * the same reason (the pass is already decided by the time this is called).
 * The caller is responsible for only calling this once the source issue's
 * frontmatter has actually been flipped through the validated issue-file
 * write path.
 */
export async function recordDoneFlip(
  qaRoot: string,
  issueFileName: string,
  stepCount: number,
  nowIso: string,
): Promise<QaPass> {
  const session = (await latestPass(qaRoot, issueFileName)) ?? (await loadQaSession(qaRoot, issueFileName, stepCount, nowIso));
  const updated = markDoneFlipped(session);
  await writePass(qaRoot, updated);
  return updated;
}
