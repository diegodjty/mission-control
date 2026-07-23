import { describe, it, expect } from 'vitest';
import {
  MANUAL_RUN_DEFAULT_CHOICE,
  MANUAL_RUN_MODEL_OPTIONS,
  manualRunModelChoiceForKey,
  manualRunModelKey,
  type ManualRunModelChoice,
} from './manual-run-model';
import { TIER_LADDER } from './worker-model';

describe('manual single-issue Run model picker (issue 203)', () => {
  it('defaults to the interactive default (null) — a confirmed default is never tiered', () => {
    // The whole point of AC #2: the pre-selected default carries NO tier, so the
    // spawn edge injects no --model and reproduces today's command byte-for-byte.
    expect(MANUAL_RUN_DEFAULT_CHOICE).toBeNull();
  });

  it('lists the interactive default FIRST and pre-selected, then the four tiers verbatim', () => {
    const [first, ...rest] = MANUAL_RUN_MODEL_OPTIONS;
    // The default row: value null, pre-selected, stable key.
    expect(first).toEqual({ value: null, key: 'default', isDefault: true });
    // The remaining rows are exactly the drain-side ladder, in order, none
    // marked default — the same haiku/sonnet/opus/fable vocabulary (no new naming).
    expect(rest.map((o) => o.value)).toEqual([...TIER_LADDER]);
    expect(rest.map((o) => o.key)).toEqual([...TIER_LADDER]);
    expect(rest.every((o) => o.isDefault === false)).toBe(true);
    // Exactly one pre-selected row.
    expect(MANUAL_RUN_MODEL_OPTIONS.filter((o) => o.isDefault)).toHaveLength(1);
  });

  it('round-trips choice ⇄ key, with `default` standing in for null', () => {
    const choices: ManualRunModelChoice[] = [null, 'haiku', 'sonnet', 'opus', 'fable'];
    for (const choice of choices) {
      expect(manualRunModelChoiceForKey(manualRunModelKey(choice))).toBe(choice);
    }
    expect(manualRunModelKey(null)).toBe('default');
    expect(manualRunModelKey('opus')).toBe('opus');
  });

  it('degrades an unknown key to the interactive default — a stray value never tiers a manual Run', () => {
    expect(manualRunModelChoiceForKey('totally-bogus')).toBeNull();
    expect(manualRunModelChoiceForKey('')).toBeNull();
  });
});
