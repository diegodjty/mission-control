/**
 * Dispatcher ↔ Run Coordinator bridge (PURE) — minimal slice.
 *
 * The Dispatcher does NOT decide which issues start under the cap: that
 * mechanical scheduling stays in the deterministic, unit-tested Run Coordinator
 * (ADR-0008). This bridge is the seam — it *delegates* "who starts next" to
 * `planDrain` and turns the resulting plan into the auto actions the Dispatcher
 * takes this step (start-next within the cap, synthesize/relay), each tagged
 * with its authority via the ADR-0007 classifier. It spends none of its own
 * intelligence on queue math; it forwards the Coordinator's decision verbatim.
 *
 * Keeping this pure (and forwarding `planDrain`'s output unchanged) is what makes
 * "scheduling is delegated, not re-implemented by the LLM" a property a test can
 * assert directly.
 */
import {
  planDrain,
  type DrainInput,
  type DrainPlan,
} from './run-coordinator';
import {
  classifyAuthority,
  type Authority,
  type DispatcherAction,
} from './dispatcher-authority';

/** An action the Dispatcher takes this step, tagged with its ADR-0007 authority. */
export interface AuthoredAction {
  action: DispatcherAction;
  authority: Authority;
}

/** What the Dispatcher should do this step, given the delegated schedule. */
export interface DispatcherDecision {
  /**
   * The Run Coordinator's plan, forwarded UNCHANGED. Scheduling (startable /
   * queued / stop) is the Coordinator's deterministic output, never the LLM's.
   */
  plan: DrainPlan;
  /** The auto actions to take this step, in the order the Dispatcher acts. */
  actions: AuthoredAction[];
}

/** Tag an action with its authority (ADR-0007). */
function authored(action: DispatcherAction): AuthoredAction {
  return { action, authority: classifyAuthority(action) };
}

/**
 * Decide the Dispatcher's next step by delegating the schedule to the Run
 * Coordinator. The plan is passed straight through; the actions are derived from
 * it:
 *   - a non-empty `startable` under a live drain ⇒ a `start-next` (auto) action
 *     (the *choice* of which issues is the Coordinator's, per ADR-0008);
 *   - the Dispatcher always keeps its `synthesize` (auto) role available so it
 *     can relay "here's where the drain is" whether or not anything starts.
 *
 * When the drain stops, no `start-next` is issued (mirrors the Coordinator
 * emptying `startable`); the Dispatcher can still synthesize the final picture.
 */
export function decideDispatcherStep(input: DrainInput): DispatcherDecision {
  const plan = planDrain(input);
  const actions: AuthoredAction[] = [];
  if (!plan.drain.stop && plan.startable.length > 0) {
    actions.push(authored('start-next'));
  }
  actions.push(authored('synthesize'));
  return { plan, actions };
}

/**
 * The inter-issue checkpoint commit is an `auto` action (ADR-0007): the
 * Dispatcher commits a clean checkpoint between issues without asking. The
 * commit itself is realized by Mission Control's existing finished-Run commit
 * path (solo `main` commit / worktree commit); this only names it and confirms
 * its authority, so the spine's "auto-commit between issues" is a classified,
 * tested action rather than an ad-hoc side effect.
 */
export function checkpointCommitAction(): AuthoredAction {
  return authored('commit-checkpoint');
}
