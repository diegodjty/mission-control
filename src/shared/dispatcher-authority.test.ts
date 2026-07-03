import { describe, expect, it } from 'vitest';
import {
  classifyAuthority,
  isAuto,
  type DispatcherAction,
} from './dispatcher-authority';

describe('dispatcher authority classifier (ADR-0007, minimal slice)', () => {
  it('marks commit-checkpoint, start-next and synthesize as auto', () => {
    // The exact three the tracer-bullet spine (issue 35) must self-authorize.
    expect(classifyAuthority('commit-checkpoint')).toBe('auto');
    expect(classifyAuthority('start-next')).toBe('auto');
    expect(classifyAuthority('synthesize')).toBe('auto');
  });

  it('also marks relay (plain-language progress) as auto', () => {
    expect(classifyAuthority('relay')).toBe('auto');
  });

  it('marks every scope-changing action as needs-approval', () => {
    const scope: DispatcherAction[] = [
      'log-issue',
      'merge',
      'abort-drain',
      'course-change',
    ];
    for (const action of scope) {
      expect(classifyAuthority(action)).toBe('needs-approval');
    }
  });

  it('isAuto agrees with classifyAuthority', () => {
    expect(isAuto('start-next')).toBe(true);
    expect(isAuto('merge')).toBe(false);
  });
});
