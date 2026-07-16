import { describe, expect, it } from 'vitest';
import {
  BREAKPOINTS,
  BREAKPOINT_LIST,
  maxWidthQuery,
  type Breakpoint,
} from './breakpoints';

describe('BREAKPOINTS token contract', () => {
  it('names each breakpoint with a --bp-* token and a data-* attribute', () => {
    for (const bp of BREAKPOINT_LIST) {
      expect(bp.token.startsWith('--bp-')).toBe(true);
      expect(bp.attribute.startsWith('data-')).toBe(true);
    }
  });

  it('exposes the narrow tier the shell collapse consumes', () => {
    expect(BREAKPOINTS.narrow).toEqual<Breakpoint>({
      token: '--bp-narrow',
      attribute: 'data-narrow',
    });
  });

  it('exposes the compact tier the per-view rebuilds reflow against', () => {
    expect(BREAKPOINTS.compact).toEqual<Breakpoint>({
      token: '--bp-compact',
      attribute: 'data-compact',
    });
  });

  it('lists every breakpoint with no duplicate tokens or attributes', () => {
    const tokens = BREAKPOINT_LIST.map((b) => b.token);
    const attrs = BREAKPOINT_LIST.map((b) => b.attribute);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(new Set(attrs).size).toBe(attrs.length);
    expect(BREAKPOINT_LIST).toHaveLength(Object.keys(BREAKPOINTS).length);
  });
});

describe('maxWidthQuery', () => {
  it('wraps a resolved width in a max-width media condition', () => {
    expect(maxWidthQuery('900px')).toBe('(max-width: 900px)');
  });

  it('trims the leading space getComputedStyle returns for custom properties', () => {
    expect(maxWidthQuery(' 640px ')).toBe('(max-width: 640px)');
  });

  it('returns an empty string for an undeclared (blank) token so the caller can skip it', () => {
    expect(maxWidthQuery('')).toBe('');
    expect(maxWidthQuery('   ')).toBe('');
  });
});
