import { describe, expect, it } from 'vitest';
import {
  alignResults,
  applyStepUpdate,
  deriveSessionVerdict,
  freshResults,
  markDoneFlipped,
  nextPassNumber,
  parseQaPass,
  qaPassFileName,
  qaPassFilePrefix,
  recordFiledIssue,
  resumeOrStartSession,
  serializeQaPass,
  setStepResult,
  type QaPass,
  type QaStepResult,
} from './qa-session-model';

describe('deriveSessionVerdict', () => {
  it('all-pass → green', () => {
    const results: QaStepResult[] = [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'pass', note: null, filedIssue: null },
    ];
    expect(deriveSessionVerdict(results)).toBe('green');
  });

  it('any fail → failed, even alongside passes', () => {
    const results: QaStepResult[] = [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'fail', note: 'saw a blank panel', filedIssue: null },
    ];
    expect(deriveSessionVerdict(results)).toBe('failed');
  });

  it('unvisited steps → in progress', () => {
    const results: QaStepResult[] = [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
    ];
    expect(deriveSessionVerdict(results)).toBe('in-progress');
  });

  it('empty step list → in progress', () => {
    expect(deriveSessionVerdict([])).toBe('in-progress');
  });

  it('a fail outweighs an otherwise-complete pass set', () => {
    const results: QaStepResult[] = [
      { verdict: 'fail', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
    ];
    expect(deriveSessionVerdict(results)).toBe('failed');
  });
});

describe('freshResults / alignResults', () => {
  it('freshResults builds N unset entries', () => {
    expect(freshResults(3)).toEqual([
      { verdict: 'unset', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
    ]);
  });

  it('alignResults pads a shorter array with unset entries', () => {
    const results: QaStepResult[] = [{ verdict: 'pass', note: null, filedIssue: null }];
    expect(alignResults(results, 3)).toEqual([
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
      { verdict: 'unset', note: null, filedIssue: null },
    ]);
  });

  it('alignResults truncates a longer array', () => {
    const results: QaStepResult[] = [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'fail', note: 'x', filedIssue: null },
      { verdict: 'pass', note: null, filedIssue: null },
    ];
    expect(alignResults(results, 1)).toEqual([{ verdict: 'pass', note: null, filedIssue: null }]);
  });
});

describe('setStepResult', () => {
  it('updates one step verdict, leaving others untouched', () => {
    const results = freshResults(2);
    const next = setStepResult(results, 1, { verdict: 'fail', note: 'expected header missing', filedIssue: null });
    expect(next[0]).toEqual({ verdict: 'unset', note: null, filedIssue: null });
    expect(next[1]).toEqual({ verdict: 'fail', note: 'expected header missing', filedIssue: null });
  });

  it('is a no-op for an out-of-range index', () => {
    const results = freshResults(2);
    expect(setStepResult(results, 5, { verdict: 'pass' })).toEqual(results);
  });

  it('preserves the existing note when only the verdict is updated', () => {
    const results: QaStepResult[] = [{ verdict: 'fail', note: 'saw nothing', filedIssue: null }];
    const next = setStepResult(results, 0, { verdict: 'pass' });
    expect(next[0]).toEqual({ verdict: 'pass', note: 'saw nothing', filedIssue: null });
  });
});

describe('nextPassNumber', () => {
  it('is 1 with no existing passes', () => {
    expect(nextPassNumber([])).toBe(1);
  });

  it('is one past the highest existing pass number', () => {
    expect(nextPassNumber([1, 2, 3])).toBe(4);
    expect(nextPassNumber([1, 3])).toBe(4);
  });
});

describe('resumeOrStartSession', () => {
  it('starts pass 1 fresh when no passes exist', () => {
    const session = resumeOrStartSession([], '198-x.md', 2, '2026-07-23T00:00:00.000Z');
    expect(session.pass).toBe(1);
    expect(session.results).toEqual(freshResults(2));
    expect(session.verdict).toBe('in-progress');
  });

  it('resumes the latest pass verbatim when it is still in progress', () => {
    const existing: QaPass = {
      issue: '198-x.md',
      pass: 2,
      started: '2026-07-20T00:00:00.000Z',
      finished: null,
      results: [{ verdict: 'pass', note: null, filedIssue: null }, { verdict: 'unset', note: null, filedIssue: null }],
      verdict: 'in-progress',
      doneFlipped: false,
    };
    const session = resumeOrStartSession([existing], '198-x.md', 2, '2026-07-23T00:00:00.000Z');
    expect(session.pass).toBe(2);
    expect(session.started).toBe('2026-07-20T00:00:00.000Z');
    expect(session.results[0]).toEqual({ verdict: 'pass', note: null, filedIssue: null });
  });

  it('creates pass N+1 (never touching pass N) when the latest pass is decided', () => {
    const decided: QaPass = {
      issue: '198-x.md',
      pass: 1,
      started: '2026-07-20T00:00:00.000Z',
      finished: '2026-07-20T01:00:00.000Z',
      results: [{ verdict: 'pass', note: null, filedIssue: null }],
      verdict: 'green',
      doneFlipped: false,
    };
    const session = resumeOrStartSession([decided], '198-x.md', 1, '2026-07-23T00:00:00.000Z');
    expect(session.pass).toBe(2);
    expect(session.started).toBe('2026-07-23T00:00:00.000Z');
    expect(session.results).toEqual(freshResults(1));
    // The prior pass object itself is never mutated by this call.
    expect(decided.pass).toBe(1);
    expect(decided.verdict).toBe('green');
  });

  it('aligns a resumed in-progress pass to a changed step count', () => {
    const existing: QaPass = {
      issue: '198-x.md',
      pass: 1,
      started: '2026-07-20T00:00:00.000Z',
      finished: null,
      results: [{ verdict: 'pass', note: null, filedIssue: null }],
      verdict: 'in-progress',
      doneFlipped: false,
    };
    const session = resumeOrStartSession([existing], '198-x.md', 3, '2026-07-23T00:00:00.000Z');
    expect(session.results).toHaveLength(3);
    expect(session.results[0]).toEqual({ verdict: 'pass', note: null, filedIssue: null });
  });
});

describe('applyStepUpdate', () => {
  const base: QaPass = {
    issue: '198-x.md',
    pass: 1,
    started: '2026-07-20T00:00:00.000Z',
    finished: null,
    results: freshResults(2),
    verdict: 'in-progress',
    doneFlipped: false,
  };

  it('stamps finished the moment the session becomes decided', () => {
    const p1 = applyStepUpdate(base, 0, { verdict: 'pass' }, '2026-07-23T00:00:00.000Z');
    expect(p1.finished).toBeNull();
    const p2 = applyStepUpdate(p1, 1, { verdict: 'pass' }, '2026-07-23T00:01:00.000Z');
    expect(p2.verdict).toBe('green');
    expect(p2.finished).toBe('2026-07-23T00:01:00.000Z');
  });

  it('clears finished if a later edit returns the session to in-progress', () => {
    const failed = applyStepUpdate(base, 0, { verdict: 'fail' }, '2026-07-23T00:00:00.000Z');
    expect(failed.verdict).toBe('failed');
    expect(failed.finished).toBe('2026-07-23T00:00:00.000Z');
    const reverted = applyStepUpdate(failed, 0, { verdict: 'unset' }, '2026-07-23T00:02:00.000Z');
    expect(reverted.verdict).toBe('in-progress');
    expect(reverted.finished).toBeNull();
  });

  it('does not re-stamp finished on a later edit within the same decided state', () => {
    const p1 = applyStepUpdate(base, 0, { verdict: 'fail' }, '2026-07-23T00:00:00.000Z');
    const p2 = applyStepUpdate(p1, 1, { note: 'also broken' }, '2026-07-23T00:05:00.000Z');
    expect(p2.finished).toBe('2026-07-23T00:00:00.000Z');
  });
});

describe('serializeQaPass / parseQaPass round-trip', () => {
  const pass: QaPass = {
    issue: '198-guided-session-verdicts-qa-receipt.md',
    pass: 1,
    started: '2026-07-23T18:00:00.000Z',
    finished: '2026-07-23T18:05:00.000Z',
    results: [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'fail', note: 'expected header missing, saw blank panel', filedIssue: null },
    ],
    verdict: 'failed',
    doneFlipped: false,
  };

  it('round-trips through serialize → parse unchanged', () => {
    const text = serializeQaPass(pass);
    expect(parseQaPass(text)).toEqual(pass);
  });

  it('round-trips an in-progress pass with a null finished stamp', () => {
    const inProgress: QaPass = { ...pass, finished: null, verdict: 'in-progress' };
    expect(parseQaPass(serializeQaPass(inProgress))).toEqual(inProgress);
  });

  it('never throws on malformed input', () => {
    expect(parseQaPass(undefined)).toBeNull();
    expect(parseQaPass(123)).toBeNull();
    expect(parseQaPass('no frontmatter here')).toBeNull();
    expect(parseQaPass('---\nissue: x.md\n---\n')).toBeNull(); // missing pass/started
  });

  it('degrades an unrecognised verdict/step verdict to the safe reading', () => {
    const text =
      '---\nissue: x.md\npass: 1\nstarted: 2026-07-23T00:00:00.000Z\nfinished: \nverdict: nonsense\n---\n\n' +
      '## Step 1\n- verdict: nonsense\n- note: \n';
    const parsed = parseQaPass(text);
    expect(parsed?.results[0].verdict).toBe('unset');
    expect(parsed?.verdict).toBe('in-progress'); // re-derived from the (unset) steps
  });
});

describe('qaPassFileName / qaPassFilePrefix', () => {
  it('builds a deterministic per-pass file name', () => {
    expect(qaPassFileName('198-guided-session-verdicts-qa-receipt.md', 1)).toBe(
      '198-guided-session-verdicts-qa-receipt--pass-1.md',
    );
  });

  it('the prefix matches every pass file name for the same issue', () => {
    const prefix = qaPassFilePrefix('198-x.md');
    expect(qaPassFileName('198-x.md', 1).startsWith(prefix)).toBe(true);
    expect(qaPassFileName('198-x.md', 12).startsWith(prefix)).toBe(true);
  });
});

describe('recordFiledIssue / markDoneFlipped (issue 199)', () => {
  const base: QaPass = {
    issue: '198-x.md',
    pass: 1,
    started: '2026-07-20T00:00:00.000Z',
    finished: '2026-07-20T01:00:00.000Z',
    results: [
      { verdict: 'pass', note: null, filedIssue: null },
      { verdict: 'fail', note: 'blank panel', filedIssue: null },
    ],
    verdict: 'failed',
    doneFlipped: false,
  };

  it('records a filed issue number against one step, leaving others untouched', () => {
    const next = recordFiledIssue(base, 1, 42);
    expect(next.results[1]).toEqual({ verdict: 'fail', note: 'blank panel', filedIssue: 42 });
    expect(next.results[0]).toEqual(base.results[0]);
  });

  it('does not touch verdict/finished when recording a filed issue', () => {
    const next = recordFiledIssue(base, 1, 42);
    expect(next.verdict).toBe('failed');
    expect(next.finished).toBe(base.finished);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(recordFiledIssue(base, 9, 42).results).toEqual(base.results);
  });

  it('marks doneFlipped without touching anything else', () => {
    const green: QaPass = { ...base, verdict: 'green', results: [base.results[0]] };
    const flipped = markDoneFlipped(green);
    expect(flipped.doneFlipped).toBe(true);
    expect(flipped.verdict).toBe('green');
    expect(flipped.results).toEqual(green.results);
  });

  it('round-trips filedIssue/doneFlipped through serialize → parse', () => {
    const withDraft = markDoneFlipped(recordFiledIssue(base, 1, 42));
    expect(parseQaPass(serializeQaPass(withDraft))).toEqual(withDraft);
  });
});
