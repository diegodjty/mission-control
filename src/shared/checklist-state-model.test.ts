import { describe, it, expect } from 'vitest';
import {
  allChecked,
  checkedFlagsFor,
  checklistStateKey,
  parseChecklistState,
  serializeChecklistState,
  toggleChecklistItem,
} from './checklist-state-model';

describe('checklistStateKey', () => {
  it('combines project key and file name', () => {
    expect(checklistStateKey('proj', '42-example.md')).toBe('proj::42-example.md');
  });
});

describe('parseChecklistState', () => {
  it('yields the empty map for missing/malformed content', () => {
    expect(parseChecklistState(null)).toEqual({});
    expect(parseChecklistState('')).toEqual({});
    expect(parseChecklistState('not json')).toEqual({});
    expect(parseChecklistState('[]')).toEqual({});
    expect(parseChecklistState('null')).toEqual({});
  });

  it('drops non-boolean-array entries but keeps well-formed ones', () => {
    const parsed = parseChecklistState(
      JSON.stringify({ 'p::a.md': [true, false], 'p::b.md': 'nope', 'p::c.md': [1, 2] }),
    );
    expect(parsed).toEqual({ 'p::a.md': [true, false] });
  });
});

describe('serializeChecklistState', () => {
  it('round-trips through parseChecklistState with stable key order', () => {
    const state = { 'p::b.md': [true], 'p::a.md': [false, true] };
    const text = serializeChecklistState(state);
    expect(Object.keys(parseChecklistState(text))).toEqual(['p::a.md', 'p::b.md']);
  });
});

describe('checkedFlagsFor', () => {
  it('pads a missing entry to itemCount with false', () => {
    expect(checkedFlagsFor({}, 'p::a.md', 3)).toEqual([false, false, false]);
  });

  it('pads a short stored entry', () => {
    const state = { 'p::a.md': [true] };
    expect(checkedFlagsFor(state, 'p::a.md', 3)).toEqual([true, false, false]);
  });

  it('truncates a longer stored entry', () => {
    const state = { 'p::a.md': [true, true, true] };
    expect(checkedFlagsFor(state, 'p::a.md', 1)).toEqual([true]);
  });
});

describe('toggleChecklistItem', () => {
  it('flips one item and returns a NEW map (pure)', () => {
    const before = {};
    const after = toggleChecklistItem(before, 'p::a.md', 1, 3);
    expect(after).toEqual({ 'p::a.md': [false, true, false] });
    expect(before).toEqual({});
  });

  it('flips back to unchecked on a second toggle', () => {
    const once = toggleChecklistItem({}, 'p::a.md', 0, 2);
    const twice = toggleChecklistItem(once, 'p::a.md', 0, 2);
    expect(twice).toEqual({ 'p::a.md': [false, false] });
  });

  it('ignores an out-of-range index (no crash)', () => {
    expect(toggleChecklistItem({}, 'p::a.md', 5, 2)).toEqual({});
    expect(toggleChecklistItem({}, 'p::a.md', -1, 2)).toEqual({});
  });
});

describe('allChecked', () => {
  it('is false for an empty checklist (nothing to verify yet)', () => {
    expect(allChecked([], 0)).toBe(false);
  });

  it('is false when any item is unchecked', () => {
    expect(allChecked([true, false], 2)).toBe(false);
  });

  it('is true when every item of itemCount is checked', () => {
    expect(allChecked([true, true, true], 3)).toBe(true);
  });

  it('is false when the flags length disagrees with itemCount', () => {
    expect(allChecked([true, true], 3)).toBe(false);
  });
});
