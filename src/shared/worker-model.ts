/**
 * Worker model tiering (issue 154) — the pure decisions behind "drain workers
 * spawn on a declared, cheap-by-default model, escalating on failure."
 *
 * The cost incident this fixes: a drain spawned bare `claude` with no `--model`,
 * so every unattended Worker inherited the interactive default (Fable 5, the
 * most expensive config) and a cap-4+cap-6 drain burned ~50% of the daily limit
 * in two minutes. The fix is DECLARATION, never runtime guessing (ADR-0013,
 * declare-don't-imply): a project CONFIG `worker_model` default (falling back to
 * `sonnet`), an optional per-issue `model:` override, and a failure escalation
 * ladder as the safety net.
 *
 * Scope: **autonomous drain workers ONLY.** Every interactive entry point (a
 * Grill/Planning session, a Simple issue, a Quick fix, a manual Run now, Just
 * talk) keeps inheriting the interactive default model and never calls into this
 * module — the caller only computes a tier for a drain-spawned Run.
 *
 * PURE: no I/O, no Electron. The reading of CONFIG/issue frontmatter off disk
 * and the actual `claude --model` spawn happen in adapters that consume these
 * decisions, so the decisions themselves stay unit-testable in isolation.
 */
import type { RunStatus } from './run-state';

/** A worker model tier, cheapest → most expensive. */
export type WorkerModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';

/**
 * The escalation ladder, cheapest first. Escalation walks UP this ladder one
 * step at a time and never downgrades. `fable` sits at the top (it is the
 * interactive default) but is only ever reached by escalation when the CONFIG
 * ceiling is raised to it.
 */
export const TIER_LADDER: readonly WorkerModelTier[] = ['haiku', 'sonnet', 'opus', 'fable'];

/** CONFIG `worker_model` default when unset/unknown — the affordable middle. */
export const DEFAULT_WORKER_MODEL: WorkerModelTier = 'sonnet';

/** CONFIG `escalation_ceiling` default when unset/unknown — escalation stops here. */
export const DEFAULT_ESCALATION_CEILING: WorkerModelTier = 'opus';

/** Hard cap on total attempts per issue per drain (haiku→sonnet→opus is 3). */
export const MAX_WORKER_ATTEMPTS = 3;

/**
 * Short tier name → full model id (the issue-154 tier table). The `claude` CLI's
 * `--model` accepts the bare alias directly, but Mission Control passes the
 * explicit id so what a Worker runs on is declared, not implied. These are the
 * standard-context ids — never the `[1m]` variant a drain Worker doesn't need.
 */
const TIER_MODEL_ID: Record<WorkerModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

/** Type guard: is `value` one of the four known tiers? */
export function isWorkerModelTier(value: unknown): value is WorkerModelTier {
  return typeof value === 'string' && (TIER_LADDER as readonly string[]).includes(value);
}

/**
 * Normalize a raw frontmatter value to a tier, or null when absent/unknown. A
 * garbage value is NOT a declaration — it degrades to null so the caller falls
 * through to the next declared source (issue override → CONFIG default → sonnet).
 */
export function parseTier(raw: string | null | undefined): WorkerModelTier | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return isWorkerModelTier(value) ? value : null;
}

/** The full model id for a tier — what MC passes to `claude --model`. */
export function modelIdForTier(tier: WorkerModelTier): string {
  return TIER_MODEL_ID[tier];
}

export interface WorkerModelInputs {
  /** The project CONFIG's `worker_model` default (raw frontmatter value). */
  configDefault?: string | null;
  /** The issue's `model:` override (raw frontmatter value). */
  issueModel?: string | null;
}

/**
 * The tier a DRAIN worker's FIRST attempt spawns on: the per-issue `model:`
 * override when set and valid, else the CONFIG `worker_model` default when set
 * and valid, else `sonnet`. Unknown values at either level are treated as unset
 * (a garbage value is not a declaration) and fall through. Interactive Runs
 * never call this — they inherit the interactive default (Opus).
 */
export function resolveWorkerModel(inputs: WorkerModelInputs): WorkerModelTier {
  return parseTier(inputs.issueModel) ?? parseTier(inputs.configDefault) ?? DEFAULT_WORKER_MODEL;
}

/**
 * Worker effort tiering (issue 155) — a SECOND per-invocation cost lever beside
 * the model. `effort` (low→max) is how deliberate/token-heavy a Worker's
 * reasoning is: a mechanical issue doesn't need the token-heavy reasoning the
 * hard engine work does. Resolved by the SAME declare-don't-imply mechanism as
 * the model, and by default DERIVED from the resolved tier (the tier already
 * encodes how hard the issue is), so it needs no extra authoring.
 *
 * The `claude` CLI's `--effort` flag (verified present in CLI v2.1.212) accepts
 * exactly these five levels, cheapest → most deliberate.
 */
export type WorkerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The five effort levels the CLI's `--effort` accepts, in ascending order. */
export const EFFORT_LEVELS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Tier → derived-default effort (issue 155): `haiku`→`low`, `sonnet`→`medium`,
 * `opus`/`fable`→`high`. The tier encodes issue difficulty, so effort follows
 * it with no extra authoring. Both top tiers derive `high` — `xhigh`/`max` are
 * reserved for an EXPLICIT per-issue/CONFIG override, never derived silently.
 */
const TIER_EFFORT: Record<WorkerModelTier, WorkerEffort> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
  fable: 'high',
};

/** Type guard: is `value` one of the five known effort levels? */
export function isWorkerEffort(value: unknown): value is WorkerEffort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize a raw frontmatter value to an effort level, or null when
 * absent/unknown — the effort twin of `parseTier`. A garbage value is NOT a
 * declaration: it degrades to null so the caller falls through to the next
 * declared source (issue `effort:` → CONFIG `worker_effort` → derived-from-tier).
 */
export function parseEffort(raw: string | null | undefined): WorkerEffort | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return isWorkerEffort(value) ? value : null;
}

/** The effort a tier derives by default (haiku→low, sonnet→medium, opus/fable→high). */
export function effortForTier(tier: WorkerModelTier): WorkerEffort {
  return TIER_EFFORT[tier];
}

export interface WorkerEffortInputs {
  /**
   * The resolved model tier this worker runs on — the source of the DERIVED
   * default. On escalation the caller passes the ESCALATED tier here, so effort
   * re-derives for the bigger model (a retry is both smarter AND more
   * deliberate) — unless a per-issue `effort:` pins it, which wins at any tier.
   */
  tier: WorkerModelTier;
  /** The project CONFIG's `worker_effort` override (raw frontmatter value). */
  configDefault?: string | null;
  /** The issue's `effort:` override (raw frontmatter value). */
  issueEffort?: string | null;
}

/**
 * The effort level a DRAIN worker spawns on (issue 155). Precedence, mirroring
 * `resolveWorkerModel`: the per-issue `effort:` when set and valid, else the
 * CONFIG `worker_effort` when set and valid, else the tier's derived default.
 * Unknown values at either override level are treated as unset (a garbage value
 * is not a declaration) and fall through. Interactive Runs never call this —
 * they inherit the interactive default and are never tiered.
 *
 * Because the derived default keys off `tier`, escalation re-derivation is free:
 * the caller re-resolves with the escalated tier and — absent a per-issue pin —
 * gets the bigger tier's effort automatically.
 */
export function resolveWorkerEffort(inputs: WorkerEffortInputs): WorkerEffort {
  return (
    parseEffort(inputs.issueEffort) ??
    parseEffort(inputs.configDefault) ??
    effortForTier(inputs.tier)
  );
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** Read one `key: value` line from a CONFIG's YAML frontmatter block. */
function frontmatterValue(content: string, key: string): string | undefined {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const match = re.exec(fm[1]);
  return match ? match[1].trim() : undefined;
}

export interface WorkerTieringConfig {
  /** The project's default drain-worker tier (sonnet when unset/unknown). */
  workerModel: WorkerModelTier;
  /** The tier escalation may climb to, inclusive (opus when unset/unknown). */
  escalationCeiling: WorkerModelTier;
  /**
   * The project-wide effort override from CONFIG `worker_effort` (issue 155), or
   * null when unset/unknown. Null is NOT a fixed default — it means "derive
   * effort from each worker's resolved tier"; the derivation happens at
   * resolution time (`resolveWorkerEffort`), not here, so the same CONFIG works
   * across every tier.
   */
  workerEffort: WorkerEffort | null;
}

/**
 * Parse the drain-tiering keys out of a project CONFIG's frontmatter. All keys
 * are optional; an absent or unknown value falls back to its documented default
 * (`worker_model`→sonnet, `escalation_ceiling`→opus). `worker_effort` is unlike
 * the two model keys: it has no fixed default — unset resolves to null so effort
 * derives from each worker's tier. A project that sets none of them drains on
 * sonnet with an opus ceiling and tier-derived effort — the affordable default.
 */
export function parseWorkerTieringConfig(
  configContent: string | null | undefined,
): WorkerTieringConfig {
  const content = configContent ?? '';
  return {
    workerModel: parseTier(frontmatterValue(content, 'worker_model')) ?? DEFAULT_WORKER_MODEL,
    escalationCeiling:
      parseTier(frontmatterValue(content, 'escalation_ceiling')) ?? DEFAULT_ESCALATION_CEILING,
    workerEffort: parseEffort(frontmatterValue(content, 'worker_effort')),
  };
}

/**
 * Whether a terminal Run status is a SUCCESS that stops escalation. A `finished`
 * Run completed; a `parked` Run is an HITL success the human verifies — neither
 * is ever re-run on a bigger model. `blocked` and `stopped` (a declared block, a
 * failed verify gate, or a death with no Receipt) are the failures escalation
 * exists for. No new failure vocabulary — these are run-state's own terms.
 */
export function isEscalationSuccess(status: RunStatus): boolean {
  return status === 'finished' || status === 'parked';
}

/**
 * One recorded drain attempt: the tier it ran on and how it ended. The ordered
 * list of these is the per-attempt tier ledger the drain journal/telemetry
 * records (which tier each attempt used — feeds issue 143).
 */
export interface DrainAttempt {
  tier: WorkerModelTier;
  status: RunStatus;
}

export type EscalationReason = 'success' | 'ceiling-reached' | 'attempts-exhausted';

export interface EscalationDecision {
  /** True when another attempt should run, one tier up from a fresh worktree. */
  escalate: boolean;
  /** The tier the next attempt runs on, or null when not escalating. */
  nextTier: WorkerModelTier | null;
  /** Why escalation stopped, when it did; null while escalating. */
  reason: EscalationReason | null;
}

export interface EscalationInput {
  /** Attempts so far, oldest first; the last is the one that just ended. */
  attempts: readonly DrainAttempt[];
  /** The ceiling tier escalation may climb to, inclusive. */
  ceiling?: WorkerModelTier;
  /** Hard cap on total attempts per issue per drain. */
  maxAttempts?: number;
}

/**
 * Decide whether a failed drain attempt escalates to a higher tier.
 *
 *  - A successful last attempt (`finished`/`parked`) stops escalation.
 *  - Otherwise the next attempt runs ONE tier up (the caller discards the failed
 *    attempt's worktree and starts fresh), capped at `ceiling` and at
 *    `maxAttempts` total. If the ceiling attempt still fails, escalation stops —
 *    the Run is a normal blocked/park, never an infinite retry.
 *  - A hand-set starting tier is simply `attempts[0].tier`: escalation still
 *    walks UP from it (the starting tier is not a lock). It never downgrades a
 *    starting tier that already sits at or above the ceiling.
 */
export function nextEscalation(input: EscalationInput): EscalationDecision {
  const ceiling = input.ceiling ?? DEFAULT_ESCALATION_CEILING;
  const maxAttempts = input.maxAttempts ?? MAX_WORKER_ATTEMPTS;
  const { attempts } = input;
  const last = attempts[attempts.length - 1];

  // No attempt yet, or the last one succeeded: nothing to escalate.
  if (last === undefined || isEscalationSuccess(last.status)) {
    return { escalate: false, nextTier: null, reason: 'success' };
  }
  // The hard attempt cap (haiku→sonnet→opus already exhausts it at 3).
  if (attempts.length >= maxAttempts) {
    return { escalate: false, nextTier: null, reason: 'attempts-exhausted' };
  }
  const lastIdx = TIER_LADDER.indexOf(last.tier);
  const ceilIdx = TIER_LADDER.indexOf(ceiling);
  const nextIdx = lastIdx + 1;
  // Already at/above the ceiling (or the top of the ladder): stop, never downgrade.
  if (lastIdx >= ceilIdx || nextIdx >= TIER_LADDER.length) {
    return { escalate: false, nextTier: null, reason: 'ceiling-reached' };
  }
  return { escalate: true, nextTier: TIER_LADDER[Math.min(nextIdx, ceilIdx)], reason: null };
}
