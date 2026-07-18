import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RUN_TIMEOUT_MINUTES,
  hasRunTimedOut,
  parseRunTimeoutMinutes,
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
