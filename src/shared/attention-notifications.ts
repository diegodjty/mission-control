/**
 * OS-notification decisions (PURE) — issue 138.
 *
 * "Handle it yourself, notify me only when I'm needed." The Inbox/attention
 * surface is deliberately quiet at the app level (ADR-0016: "quiet text, never
 * notifications") so the human can poll it. This module is the ONE exception,
 * scoped to the OS channel: it decides which attention/lifecycle events have
 * earned a native OS notification — a genuine "come look" ping — and, just as
 * importantly, which never do.
 *
 * It is the OS-channel analog of the ADR-0012 noise floor: only the
 * BLOCKING-APPROVAL tier plus the TERMINAL drain moments clear the bar —
 *
 *   - `hitl-park`      — an HITL Run parked awaiting your sign-off/verification;
 *   - `blocked-park`   — a Run parked blocked (issue 137), needing you to unstick it;
 *   - `merge-conflict` — a Merge hit a conflict only you can resolve;
 *   - `drain-stopped`  — the drain halted early (a blocker / your stop / a mid-merge);
 *   - `drain-finished` — the drain finished (the backlog drained).
 *
 * Everything else — routine claim/done flips, curator proposals, setup gates,
 * new-repo candidates, the journal briefing, passive notes — stays silent. "If
 * in doubt, stay silent" (ADR-0012) governs at OS level too: an OS ping is the
 * loudest interruption the app has, so it must justify itself.
 *
 * Structure (why it's pure): the tier filter and the per-issue dedupe are the
 * whole decision, so they live here as one total function over an event stream
 * plus the already-notified key set. The thin main-process adapter
 * (`main/notification-adapter`) only SHOWS the intents this returns and wires
 * their click; the controller (`main/notification-controller`) threads the seen
 * set. That split keeps the interesting logic unit-testable with no Electron.
 *
 * Dedupe contract: one notification per event, keyed per issue (per drain).
 * `decideNotifications` returns the intents to fire PLUS the grown seen set;
 * feeding a re-scan of the same state back with that seen set yields nothing —
 * the "a re-scan must not re-ping" the acceptance criteria name.
 *
 * House PURE contract: no I/O, no Electron, no timers; any input yields a value,
 * never a throw. Malformed input degrades to no intent.
 */
import type { AttentionItem, AttentionKind } from './attention-hub-model';

/** Why an event earned an OS notification — the tier that cleared the bar. */
export type NotificationReason =
  | 'hitl-park'
  | 'blocked-park'
  | 'merge-conflict'
  | 'drain-stopped'
  | 'drain-finished';

/**
 * One decided notification, ready for the thin adapter to show. `title` and
 * `body` are the final display strings (built here so they are testable); the
 * adapter adds nothing. `key` is the stable dedupe identity; `project` +
 * `issueId` are what a click focuses/navigates to (the Project's attention
 * surface, with the issue selected when there is one).
 */
export interface NotificationIntent {
  /** Stable dedupe key — one per (reason, issue) within a drain. */
  key: string;
  reason: NotificationReason;
  /** The workbench project directory name the click-through resolves. */
  project: string;
  /** The issue this is about, or null (a merge / drain moment). */
  issueId: number | null;
  /** Notification title — carries issue + project. */
  title: string;
  /** One human-readable line. */
  body: string;
}

/**
 * The event stream the decision module folds over. `attention` carries the FULL
 * current cross-project attention set (the aggregated snapshot); the module
 * picks out the notifying kinds. `merge-conflict` and `drain-ended` are discrete
 * lifecycle moments the main process observes at their source.
 */
export type NotificationEvent =
  | { type: 'attention'; items: readonly AttentionItem[] }
  | {
      type: 'merge-conflict';
      /** The workbench project directory name. */
      project: string;
      /** The `NN-slug`s the merge attempt covered (dedupes distinct conflicts). */
      slugs?: readonly string[];
      /** The files git reported conflicting, when known. */
      conflictingFiles?: readonly string[];
    }
  | {
      type: 'drain-ended';
      /** The workbench project directory name. */
      project: string;
      /** Halted early (`stopped`) vs the backlog drained (`finished`). */
      outcome: 'stopped' | 'finished';
      /** The drain's stated stop reason, for the body. */
      reason?: string | null;
    };

/** The decision: the intents to fire now, plus the grown already-notified set. */
export interface NotificationDecision {
  intents: NotificationIntent[];
  /** A NEW set (the input plus every fired key) — thread it into the next call. */
  seen: Set<string>;
}

/**
 * The attention kinds that clear the OS-notification bar. Deliberately only the
 * two blocking-approval parks — every other `AttentionKind` (curator-proposal,
 * setup-gate, new-repo-candidate, briefing) is quiet-surface-only (ADR-0016) and
 * must never become an OS ping.
 */
const NOTIFYING_ATTENTION_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  'hitl-park',
  'blocked-run',
]);

/** `NN`, zero-padded to two digits, matching the house display convention. */
function pad2(id: number): string {
  return String(id).padStart(2, '0');
}

/** One trimmed line, bounded — a notification body must never be a pasted block. */
function oneLine(text: string | null | undefined, max = 160): string {
  if (typeof text !== 'string') return '';
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A defensive array read: anything non-array degrades to empty. */
function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** The reason an attention item maps to, or null when it is below the bar. */
function attentionReason(kind: AttentionKind): NotificationReason | null {
  if (!NOTIFYING_ATTENTION_KINDS.has(kind)) return null;
  return kind === 'hitl-park' ? 'hitl-park' : 'blocked-park';
}

/**
 * Classify a drain's stop MESSAGE into the terminal outcome. The drain plan's
 * messages are house-controlled (`run-coordinator`): only "no eligible issue
 * remains" is the backlog draining to completion (`finished`); a run-blocked
 * halt, a mid-merge halt, and a user stop are all early stops (`stopped`).
 * Defaults to `stopped` — the conservative label — for any other/absent text.
 */
export function classifyDrainStop(reason: string | null | undefined): 'stopped' | 'finished' {
  if (typeof reason === 'string' && /no eligible/i.test(reason)) return 'finished';
  return 'stopped';
}

/** Build the intent for a notifying attention item. */
function attentionIntent(item: AttentionItem, reason: NotificationReason): NotificationIntent {
  const issuePart = item.issueId !== null ? ` · issue ${pad2(item.issueId)}` : '';
  return {
    // The item's id is already stable across re-derivation
    // (`<project>:<kind>:<issueId>`), so it is exactly the dedupe key we want.
    key: item.id,
    reason,
    project: item.project,
    issueId: item.issueId,
    title: `${item.project}${issuePart}`,
    body: oneLine(item.text),
  };
}

/** Build the intent for a merge conflict. */
function mergeConflictIntent(event: Extract<NotificationEvent, { type: 'merge-conflict' }>): NotificationIntent {
  const slugs = asArray(event.slugs).filter((s): s is string => typeof s === 'string' && s.length > 0);
  const files = asArray(event.conflictingFiles).filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  );
  const where = files.length > 0 ? ` in ${files.join(', ')}` : '';
  return {
    // Keyed on the merged set so distinct conflicts each ping once, but a
    // re-attempt of the SAME set (merge-as-you-go retry) does not re-ping.
    key: `${event.project}:merge-conflict:${[...slugs].sort().join(',')}`,
    reason: 'merge-conflict',
    project: event.project,
    issueId: null,
    title: `${event.project} · merge conflict`,
    body: oneLine(`A merge hit a conflict${where} — resolve it or Abort the merge.`),
  };
}

/** Build the intent for a terminal drain moment. */
function drainEndedIntent(event: Extract<NotificationEvent, { type: 'drain-ended' }>): NotificationIntent {
  const finished = event.outcome === 'finished';
  const reason: NotificationReason = finished ? 'drain-finished' : 'drain-stopped';
  const label = finished ? 'drain finished' : 'drain stopped';
  const detail = oneLine(event.reason ?? '');
  return {
    key: `${event.project}:${reason}`,
    reason,
    project: event.project,
    issueId: null,
    title: `${event.project} · ${label}`,
    body: detail || (finished ? 'The backlog drained — come take a look.' : 'The drain stopped — come take a look.'),
  };
}

/**
 * Every intent an event WOULD produce, before deduping — the tier filter only.
 * Non-notifying attention kinds and malformed input drop out here.
 */
function candidateIntents(event: NotificationEvent): NotificationIntent[] {
  if (!event || typeof event !== 'object') return [];
  switch (event.type) {
    case 'attention': {
      const intents: NotificationIntent[] = [];
      for (const item of asArray(event.items)) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
        const reason = attentionReason(item.kind);
        if (reason === null) continue;
        intents.push(attentionIntent(item, reason));
      }
      return intents;
    }
    case 'merge-conflict':
      if (typeof event.project !== 'string' || event.project === '') return [];
      return [mergeConflictIntent(event)];
    case 'drain-ended':
      if (typeof event.project !== 'string' || event.project === '') return [];
      return [drainEndedIntent(event)];
    default:
      return [];
  }
}

/**
 * Decide which intents to fire for one event, deduped against the already-fired
 * key set. Pure and total: returns the intents to fire (tier-cleared AND not yet
 * seen) plus a NEW seen set grown by those fired keys. Feeding the same event
 * back with the returned seen set yields no intents — the re-scan idempotence the
 * acceptance criteria require. A key already in `seen` is silently dropped even
 * if it appears twice in one event (deduped within the batch too).
 */
export function decideNotifications(
  event: NotificationEvent,
  seen: ReadonlySet<string> = new Set(),
): NotificationDecision {
  const next = new Set<string>(seen ?? []);
  const intents: NotificationIntent[] = [];
  for (const intent of candidateIntents(event)) {
    if (next.has(intent.key)) continue;
    next.add(intent.key);
    intents.push(intent);
  }
  return { intents, seen: next };
}
