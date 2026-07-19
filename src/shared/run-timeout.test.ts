import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RUN_TIMEOUT_MINUTES,
  hasRunTimedOut,
  parseIssueRunTimeoutMinutes,
  parseRunTimeoutMinutes,
  resolveRunTimeoutMinutes,
  resolveRunTimeoutMs,
  runTimeoutMsFor,
} from './run-timeout';

describe('parseRunTimeoutMinutes (issue 141) — CONFIG `run_timeout`, never throws', () => {
  it('defaults to 30 minutes when CONFIG is null/empty/has no key', () => {
    expect(parseRunTimeoutMinutes(null)).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(parseRunTimeoutMinutes(undefined)).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(parseRunTimeoutMinutes('')).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(parseRunTimeoutMinutes('---\nworker_model: sonnet\n---\n')).toBe(
      DEFAULT_RUN_TIMEOUT_MINUTES,
    );
  });

  it('reads a valid override from frontmatter', () => {
    expect(parseRunTimeoutMinutes('---\nrun_timeout: 45\n---\n')).toBe(45);
    expect(parseRunTimeoutMinutes('---\nrun_timeout: 5\n---\n')).toBe(5);
  });

  it('degrades malformed values (non-numeric, zero, negative) to the default', () => {
    expect(parseRunTimeoutMinutes('---\nrun_timeout: soon\n---\n')).toBe(
      DEFAULT_RUN_TIMEOUT_MINUTES,
    );
    expect(parseRunTimeoutMinutes('---\nrun_timeout: 0\n---\n')).toBe(
      DEFAULT_RUN_TIMEOUT_MINUTES,
    );
    expect(parseRunTimeoutMinutes('---\nrun_timeout: -10\n---\n')).toBe(
      DEFAULT_RUN_TIMEOUT_MINUTES,
    );
    expect(parseRunTimeoutMinutes('---\nrun_timeout: \n---\n')).toBe(
      DEFAULT_RUN_TIMEOUT_MINUTES,
    );
  });

  it('runTimeoutMsFor resolves minutes to milliseconds', () => {
    expect(runTimeoutMsFor('---\nrun_timeout: 1\n---\n')).toBe(60_000);
    expect(runTimeoutMsFor(null)).toBe(DEFAULT_RUN_TIMEOUT_MINUTES * 60_000);
  });
});

describe('hasRunTimedOut (issue 141) — breach decision from timestamps', () => {
  it('is false before the timeout elapses', () => {
    expect(hasRunTimedOut(0, 59_999, 60_000)).toBe(false);
  });

  it('is true exactly at and past the timeout', () => {
    expect(hasRunTimedOut(0, 60_000, 60_000)).toBe(true);
    expect(hasRunTimedOut(0, 60_001, 60_000)).toBe(true);
    expect(hasRunTimedOut(1_000_000, 2_000_000, 60_000)).toBe(true);
  });
});

describe('parseIssueRunTimeoutMinutes (issue 170) — per-issue `run_timeout` override', () => {
  it('returns null when the issue declares no override', () => {
    expect(parseIssueRunTimeoutMinutes(null)).toBeNull();
    expect(parseIssueRunTimeoutMinutes(undefined)).toBeNull();
    expect(parseIssueRunTimeoutMinutes('')).toBeNull();
    expect(parseIssueRunTimeoutMinutes('---\nstatus: open\n---\n')).toBeNull();
  });

  it('reads a valid per-issue override', () => {
    expect(parseIssueRunTimeoutMinutes('---\nrun_timeout: 90\n---\n')).toBe(90);
  });

  it('degrades malformed values (non-numeric, zero, negative) to null, not the default', () => {
    expect(parseIssueRunTimeoutMinutes('---\nrun_timeout: soon\n---\n')).toBeNull();
    expect(parseIssueRunTimeoutMinutes('---\nrun_timeout: 0\n---\n')).toBeNull();
    expect(parseIssueRunTimeoutMinutes('---\nrun_timeout: -5\n---\n')).toBeNull();
  });
});

describe('resolveRunTimeoutMinutes (issue 170) — blunt-kill mitigation', () => {
  it('an issue override wins outright, with no effort scaling applied on top', () => {
    expect(resolveRunTimeoutMinutes(null, '---\nrun_timeout: 90\n---\n', 'max')).toBe(90);
    expect(resolveRunTimeoutMinutes(null, '---\nrun_timeout: 90\n---\n', null)).toBe(90);
  });

  it('absent an override, low/medium effort applies no scaling to the CONFIG default', () => {
    expect(resolveRunTimeoutMinutes(null, null, 'low')).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(resolveRunTimeoutMinutes(null, null, 'medium')).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(resolveRunTimeoutMinutes(null, null, null)).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(resolveRunTimeoutMinutes(null, null, undefined)).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
  });

  it('high/xhigh/max effort scales the CONFIG default up', () => {
    expect(resolveRunTimeoutMinutes(null, null, 'high')).toBe(45); // 30 * 1.5
    expect(resolveRunTimeoutMinutes(null, null, 'xhigh')).toBe(60); // 30 * 2
    expect(resolveRunTimeoutMinutes(null, null, 'max')).toBe(75); // 30 * 2.5
  });

  it('scales a non-default CONFIG value too, rounded to the nearest minute', () => {
    expect(resolveRunTimeoutMinutes('---\nrun_timeout: 20\n---\n', null, 'high')).toBe(30); // 20 * 1.5
  });

  it('resolveRunTimeoutMs mirrors the minutes resolution in milliseconds', () => {
    expect(resolveRunTimeoutMs(null, null, 'high')).toBe(45 * 60_000);
    expect(resolveRunTimeoutMs(null, '---\nrun_timeout: 10\n---\n', 'max')).toBe(10 * 60_000);
  });
});
