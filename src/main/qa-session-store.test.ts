import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listQaPasses,
  loadQaSession,
  recordQaStepVerdict,
  startNewQaPass,
} from './qa-session-store';

/**
 * Guided QA session persistence (issue 198): the durable `qa/` pass file is
 * the session's ONLY store — no userData involvement (unlike issue 156's
 * ephemeral checklist tick-store) — so a fresh store instance / relaunch
 * reads exactly what a prior instance wrote.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-qa-session-'));
  dirs.push(dir);
  return dir;
}

const ISSUE = '198-guided-session-verdicts-qa-receipt.md';

describe('loadQaSession', () => {
  it('starts pass 1 fresh when qa/ does not exist yet', async () => {
    const qaRoot = join(await tempDir(), 'qa');
    const session = await loadQaSession(qaRoot, ISSUE, 2, '2026-07-23T00:00:00.000Z');
    expect(session.pass).toBe(1);
    expect(session.results).toEqual([
      { verdict: 'unset', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
    ]);
  });

  it('does not itself create a file — only recording a verdict does', async () => {
    const qaRoot = join(await tempDir(), 'qa');
    await loadQaSession(qaRoot, ISSUE, 2, '2026-07-23T00:00:00.000Z');
    const exists = await readdir(qaRoot).catch(() => null);
    expect(exists).toBeNull();
  });
});

describe('recordQaStepVerdict', () => {
  it('writes a pass file incrementally, one write per verdict', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(
      qaRoot,
      ISSUE,
      2,
      0,
      { verdict: 'pass' },
      '2026-07-23T00:00:00.000Z',
    );
    const names = await readdir(qaRoot);
    expect(names).toEqual(['198-guided-session-verdicts-qa-receipt--pass-1.md']);
  });

  it('a NEW session resumes exactly where a prior one left off (relaunch)', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(qaRoot, ISSUE, 2, 0, { verdict: 'pass' }, '2026-07-23T00:00:00.000Z');
    // Simulate quitting and relaunching: a fresh call reads only the disk file.
    const resumed = await loadQaSession(qaRoot, ISSUE, 2, '2026-07-23T01:00:00.000Z');
    expect(resumed.pass).toBe(1);
    expect(resumed.results[0]).toEqual({ verdict: 'pass', note: null, filedIssue: null });
    expect(resumed.results[1]).toEqual({ verdict: 'unset', note: null, filedIssue: null });
  });

  it('records a note alongside a fail verdict', async () => {
    const qaRoot = await tempDir();
    const updated = await recordQaStepVerdict(
      qaRoot,
      ISSUE,
      1,
      0,
      { verdict: 'fail', note: 'expected header missing, saw blank panel' },
      '2026-07-23T00:00:00.000Z',
    );
    expect(updated.results[0]).toEqual({
      verdict: 'fail',
      note: 'expected header missing, saw blank panel',
      filedIssue: null,
    });
    expect(updated.verdict).toBe('failed');
    expect(updated.finished).toBe('2026-07-23T00:00:00.000Z');
  });

  it('a decided session (all-pass) becomes green and stamps finished', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(qaRoot, ISSUE, 2, 0, { verdict: 'pass' }, '2026-07-23T00:00:00.000Z');
    const final = await recordQaStepVerdict(
      qaRoot,
      ISSUE,
      2,
      1,
      { verdict: 'pass' },
      '2026-07-23T00:01:00.000Z',
    );
    expect(final.verdict).toBe('green');
    expect(final.finished).toBe('2026-07-23T00:01:00.000Z');
  });
});

describe('re-QA (starting a new pass on a decided session)', () => {
  it('starting re-QA creates pass N+1 and leaves pass N untouched', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(qaRoot, ISSUE, 1, 0, { verdict: 'pass' }, '2026-07-23T00:00:00.000Z');

    const passes = await listQaPasses(qaRoot, ISSUE);
    expect(passes).toHaveLength(1);
    expect(passes[0].verdict).toBe('green');

    const reQa = await startNewQaPass(qaRoot, ISSUE, 1, '2026-07-23T02:00:00.000Z');
    expect(reQa.pass).toBe(2);
    expect(reQa.results).toEqual([{ verdict: 'unset', note: null, filedIssue: null }]);

    const allPasses = await listQaPasses(qaRoot, ISSUE);
    expect(allPasses).toHaveLength(2);
    const pass1 = allPasses.find((p) => p.pass === 1);
    expect(pass1?.verdict).toBe('green'); // untouched by the re-QA
    expect(pass1?.finished).toBe('2026-07-23T00:00:00.000Z');
  });

  it('after re-QA, loadQaSession resumes the NEW pass, not the old decided one', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(qaRoot, ISSUE, 1, 0, { verdict: 'fail', note: 'x' }, '2026-07-23T00:00:00.000Z');
    await startNewQaPass(qaRoot, ISSUE, 1, '2026-07-23T02:00:00.000Z');

    const resumed = await loadQaSession(qaRoot, ISSUE, 1, '2026-07-23T03:00:00.000Z');
    expect(resumed.pass).toBe(2);
    expect(resumed.verdict).toBe('in-progress');
  });
});

describe('listQaPasses', () => {
  it('scopes strictly to the named issue — a different issue is not mixed in', async () => {
    const qaRoot = await tempDir();
    await recordQaStepVerdict(qaRoot, ISSUE, 1, 0, { verdict: 'pass' }, '2026-07-23T00:00:00.000Z');
    await recordQaStepVerdict(
      qaRoot,
      '199-session-end-actions-file-and-flip.md',
      1,
      0,
      { verdict: 'pass' },
      '2026-07-23T00:00:00.000Z',
    );
    const passes = await listQaPasses(qaRoot, ISSUE);
    expect(passes).toHaveLength(1);
    expect(passes[0].issue).toBe(ISSUE);
  });

  it('degrades to empty on an unreadable qa root, never throws', async () => {
    const passes = await listQaPasses('/nonexistent/path/qa', ISSUE);
    expect(passes).toEqual([]);
  });
});
