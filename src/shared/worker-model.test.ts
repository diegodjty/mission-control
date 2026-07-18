import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ESCALATION_CEILING,
  DEFAULT_WORKER_MODEL,
  EFFORT_LEVELS,
  MAX_WORKER_ATTEMPTS,
  effortForTier,
  isEscalationSuccess,
  isWorkerEffort,
  isWorkerModelTier,
  modelIdForTier,
  nextEscalation,
  parseEffort,
  parseTier,
  parseWorkerTieringConfig,
  resolveWorkerEffort,
  resolveWorkerModel,
  type DrainAttempt,
} from './worker-model';

describe('tier parsing + model id map (issue 154 tier table)', () => {
  it('recognizes exactly the four known tiers', () => {
    for (const tier of ['haiku', 'sonnet', 'opus', 'fable']) {
      expect(isWorkerModelTier(tier)).toBe(true);
    }
    expect(isWorkerModelTier('gpt')).toBe(false);
    expect(isWorkerModelTier('')).toBe(false);
    expect(isWorkerModelTier(undefined)).toBe(false);
  });

  it('parseTier normalizes quotes/case/whitespace and rejects unknowns', () => {
    expect(parseTier('haiku')).toBe('haiku');
    expect(parseTier('  SONNET ')).toBe('sonnet');
    expect(parseTier('"opus"')).toBe('opus');
    expect(parseTier("'fable'")).toBe('fable');
    expect(parseTier('xxl')).toBeNull();
    expect(parseTier('')).toBeNull();
    expect(parseTier(null)).toBeNull();
    expect(parseTier(undefined)).toBeNull();
  });

  it('maps each short name → the correct full model id', () => {
    expect(modelIdForTier('haiku')).toBe('claude-haiku-4-5');
    expect(modelIdForTier('sonnet')).toBe('claude-sonnet-5');
    expect(modelIdForTier('opus')).toBe('claude-opus-4-8');
    expect(modelIdForTier('fable')).toBe('claude-fable-5');
    // Standard-context ids — never the [1m] variant a drain Worker doesn't need.
    for (const id of Object.values({ h: modelIdForTier('haiku'), s: modelIdForTier('sonnet') })) {
      expect(id).not.toContain('[1m]');
    }
  });
});

describe('resolveWorkerModel — the FIRST attempt tier (AC1)', () => {
  it('uses the CONFIG worker_model default when no per-issue override', () => {
    expect(resolveWorkerModel({ configDefault: 'haiku' })).toBe('haiku');
    expect(resolveWorkerModel({ configDefault: 'opus', issueModel: null })).toBe('opus');
  });

  it('a per-issue model: overrides the CONFIG default', () => {
    expect(resolveWorkerModel({ configDefault: 'sonnet', issueModel: 'haiku' })).toBe('haiku');
    expect(resolveWorkerModel({ configDefault: 'haiku', issueModel: 'opus' })).toBe('opus');
  });

  it('unknown or absent values fall back to sonnet', () => {
    expect(resolveWorkerModel({})).toBe('sonnet');
    expect(resolveWorkerModel({ configDefault: null, issueModel: null })).toBe('sonnet');
    expect(resolveWorkerModel({ configDefault: 'nonsense' })).toBe('sonnet');
    expect(DEFAULT_WORKER_MODEL).toBe('sonnet');
    // A garbage per-issue value is not a declaration — it falls through to the
    // CONFIG default rather than forcing sonnet past a real CONFIG setting.
    expect(resolveWorkerModel({ configDefault: 'haiku', issueModel: 'garbage' })).toBe('haiku');
    // …and with no CONFIG default either, a garbage override lands on sonnet.
    expect(resolveWorkerModel({ issueModel: 'garbage' })).toBe('sonnet');
  });
});

describe('effort parsing + tier derivation (issue 155)', () => {
  it('recognizes exactly the five known effort levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isWorkerEffort(level)).toBe(true);
    }
    expect(isWorkerEffort('extreme')).toBe(false);
    expect(isWorkerEffort('')).toBe(false);
    expect(isWorkerEffort(undefined)).toBe(false);
    // The exported ladder is the five levels, cheapest → most deliberate.
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('parseEffort normalizes quotes/case/whitespace and rejects unknowns', () => {
    expect(parseEffort('low')).toBe('low');
    expect(parseEffort('  HIGH ')).toBe('high');
    expect(parseEffort('"xhigh"')).toBe('xhigh');
    expect(parseEffort("'max'")).toBe('max');
    expect(parseEffort('turbo')).toBeNull();
    expect(parseEffort('')).toBeNull();
    expect(parseEffort(null)).toBeNull();
    expect(parseEffort(undefined)).toBeNull();
  });

  it('derives effort from the tier: haiku→low, sonnet→medium, opus/fable→high', () => {
    expect(effortForTier('haiku')).toBe('low');
    expect(effortForTier('sonnet')).toBe('medium');
    expect(effortForTier('opus')).toBe('high');
    expect(effortForTier('fable')).toBe('high');
    // The two top tiers derive `high`, never xhigh/max — those are override-only.
    expect(effortForTier('opus')).not.toBe('max');
    expect(effortForTier('fable')).not.toBe('xhigh');
  });
});

describe('resolveWorkerEffort — precedence (AC1)', () => {
  it('derives from tier by default when neither override is set', () => {
    expect(resolveWorkerEffort({ tier: 'haiku' })).toBe('low');
    expect(resolveWorkerEffort({ tier: 'sonnet' })).toBe('medium');
    expect(resolveWorkerEffort({ tier: 'opus' })).toBe('high');
    expect(resolveWorkerEffort({ tier: 'fable' })).toBe('high');
    expect(resolveWorkerEffort({ tier: 'sonnet', configDefault: null, issueEffort: null })).toBe(
      'medium',
    );
  });

  it('a CONFIG worker_effort overrides the tier derivation', () => {
    // sonnet would derive `medium`, but the project pins `high`.
    expect(resolveWorkerEffort({ tier: 'sonnet', configDefault: 'high' })).toBe('high');
    // haiku would derive `low`, but the project pins `max`.
    expect(resolveWorkerEffort({ tier: 'haiku', configDefault: 'max' })).toBe('max');
  });

  it('a per-issue effort: overrides BOTH the CONFIG override and the derivation', () => {
    expect(
      resolveWorkerEffort({ tier: 'sonnet', configDefault: 'high', issueEffort: 'low' }),
    ).toBe('low');
    expect(resolveWorkerEffort({ tier: 'opus', issueEffort: 'xhigh' })).toBe('xhigh');
  });

  it('unknown values at either override level fall through to the next source', () => {
    // Garbage issue effort → falls to the CONFIG override.
    expect(
      resolveWorkerEffort({ tier: 'haiku', configDefault: 'max', issueEffort: 'garbage' }),
    ).toBe('max');
    // Garbage at both override levels → falls to the tier-derived default.
    expect(
      resolveWorkerEffort({ tier: 'sonnet', configDefault: 'nonsense', issueEffort: 'garbage' }),
    ).toBe('medium');
  });
});

describe('effort re-derivation across escalation (AC3)', () => {
  it('re-derives effort for the escalated tier when no per-issue effort pins it', () => {
    // A drain that escalates haiku → sonnet → opus re-resolves effort at each
    // tier: the retry is both a bigger model AND more deliberate reasoning.
    expect(resolveWorkerEffort({ tier: 'haiku' })).toBe('low'); // first attempt
    expect(resolveWorkerEffort({ tier: 'sonnet' })).toBe('medium'); // after 1st escalation
    expect(resolveWorkerEffort({ tier: 'opus' })).toBe('high'); // after 2nd escalation
  });

  it('a per-issue effort: PINS the level — escalation raises the tier but not the effort', () => {
    // effort: max pinned on the issue stays max at every escalated tier.
    expect(resolveWorkerEffort({ tier: 'haiku', issueEffort: 'max' })).toBe('max');
    expect(resolveWorkerEffort({ tier: 'sonnet', issueEffort: 'max' })).toBe('max');
    expect(resolveWorkerEffort({ tier: 'opus', issueEffort: 'max' })).toBe('max');
    // A pin BELOW the derived default also holds — a low pin stays low on opus,
    // which would otherwise derive `high`.
    expect(resolveWorkerEffort({ tier: 'opus', issueEffort: 'low' })).toBe('low');
  });
});

describe('parseWorkerTieringConfig — CONFIG frontmatter keys (AC1 + AC5)', () => {
  const config = (body: string): string => `---\n${body}\n---\n\n# proj CONFIG\n`;

  it('reads worker_model, escalation_ceiling and worker_effort from frontmatter', () => {
    const parsed = parseWorkerTieringConfig(
      config(
        'repos:\n  a: /x\ndefault_repo: a\nworker_model: haiku\nescalation_ceiling: fable\nworker_effort: max',
      ),
    );
    expect(parsed.workerModel).toBe('haiku');
    expect(parsed.escalationCeiling).toBe('fable');
    expect(parsed.workerEffort).toBe('max');
  });

  it('absent keys fall back to their documented defaults (sonnet / opus / derive)', () => {
    const parsed = parseWorkerTieringConfig(config('repos:\n  a: /x\ndefault_repo: a'));
    expect(parsed.workerModel).toBe('sonnet');
    expect(parsed.escalationCeiling).toBe('opus');
    expect(DEFAULT_ESCALATION_CEILING).toBe('opus');
    // worker_effort has NO fixed default — absent means "derive from tier", so
    // it resolves to null rather than a level.
    expect(parsed.workerEffort).toBeNull();
  });

  it('an unknown worker_effort degrades to null (derive from tier), not a level', () => {
    expect(parseWorkerTieringConfig(config('worker_effort: turbo')).workerEffort).toBeNull();
  });

  it('unknown values fall back, and a null/empty CONFIG is all-defaults', () => {
    expect(parseWorkerTieringConfig(config('worker_model: turbo')).workerModel).toBe('sonnet');
    expect(parseWorkerTieringConfig(null)).toEqual({
      workerModel: 'sonnet',
      escalationCeiling: 'opus',
      workerEffort: null,
    });
    expect(parseWorkerTieringConfig('')).toEqual({
      workerModel: 'sonnet',
      escalationCeiling: 'opus',
      workerEffort: null,
    });
  });

  it('ignores a worker_model line that lives in the body, not the frontmatter', () => {
    const content = `---\nrepos:\n  a: /x\n---\n\nworker_model: opus (this is prose, not config)\n`;
    expect(parseWorkerTieringConfig(content).workerModel).toBe('sonnet');
  });
});

describe('nextEscalation — the failure safety net (AC3)', () => {
  const attempt = (tier: DrainAttempt['tier'], status: DrainAttempt['status']): DrainAttempt => ({
    tier,
    status,
  });

  it('a failed attempt re-runs ONE tier up (from a fresh worktree)', () => {
    const decision = nextEscalation({ attempts: [attempt('haiku', 'blocked')] });
    expect(decision.escalate).toBe(true);
    expect(decision.nextTier).toBe('sonnet');
    expect(decision.reason).toBeNull();
  });

  it('walks haiku → sonnet → opus and then stops at the ceiling', () => {
    // haiku failed then sonnet failed → escalate to opus (the default ceiling).
    const toOpus = nextEscalation({
      attempts: [attempt('haiku', 'blocked'), attempt('sonnet', 'stopped')],
    });
    expect(toOpus).toEqual({ escalate: true, nextTier: 'opus', reason: null });

    // opus (the ceiling) also failed → stop; that's a normal blocked/park.
    const atCeiling = nextEscalation({
      attempts: [attempt('haiku', 'blocked'), attempt('sonnet', 'blocked'), attempt('opus', 'blocked')],
    });
    expect(atCeiling.escalate).toBe(false);
    expect(atCeiling.nextTier).toBeNull();
    // Both the ceiling AND the 3-attempt cap are reached here.
    expect(['ceiling-reached', 'attempts-exhausted']).toContain(atCeiling.reason);
  });

  it('caps total attempts at MAX_WORKER_ATTEMPTS even under a raised ceiling', () => {
    expect(MAX_WORKER_ATTEMPTS).toBe(3);
    // Ceiling raised to fable, but three attempts are already spent → no 4th.
    const decision = nextEscalation({
      attempts: [attempt('haiku', 'blocked'), attempt('sonnet', 'blocked'), attempt('opus', 'blocked')],
      ceiling: 'fable',
    });
    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBe('attempts-exhausted');
  });

  it('stops at a lower ceiling before the attempt cap bites', () => {
    // Ceiling = sonnet: a failed sonnet has nowhere to climb (opus > ceiling).
    const decision = nextEscalation({
      attempts: [attempt('haiku', 'blocked'), attempt('sonnet', 'blocked')],
      ceiling: 'sonnet',
    });
    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBe('ceiling-reached');
  });

  it('a Receipt-backed success stops escalation', () => {
    expect(nextEscalation({ attempts: [attempt('haiku', 'finished')] })).toEqual({
      escalate: false,
      nextTier: null,
      reason: 'success',
    });
    // A parked HITL Run is a success too — never re-run on a bigger model.
    expect(nextEscalation({ attempts: [attempt('haiku', 'parked')] }).escalate).toBe(false);
    expect(isEscalationSuccess('finished')).toBe(true);
    expect(isEscalationSuccess('parked')).toBe(true);
    expect(isEscalationSuccess('blocked')).toBe(false);
    expect(isEscalationSuccess('stopped')).toBe(false);
  });

  it('a hand-set starting tier is the STARTING tier, not a lock — escalation walks up from it', () => {
    // Hand-set opus that failed still escalates within the raised ceiling.
    const fromHandSet = nextEscalation({ attempts: [attempt('opus', 'blocked')], ceiling: 'fable' });
    expect(fromHandSet).toEqual({ escalate: true, nextTier: 'fable', reason: null });

    // A hand-set tier already at/above the ceiling never downgrades — it just
    // stops (no infinite retry, no dropping to a cheaper model).
    const noDowngrade = nextEscalation({ attempts: [attempt('opus', 'blocked')], ceiling: 'opus' });
    expect(noDowngrade.escalate).toBe(false);
    expect(noDowngrade.nextTier).toBeNull();
    expect(noDowngrade.reason).toBe('ceiling-reached');
  });
});
