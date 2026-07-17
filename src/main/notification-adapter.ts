/**
 * Native OS-notification adapter (thin) — issue 138.
 *
 * The main-process side of the OS-notification feature. It is deliberately
 * dumb: the decision (tier filter + dedupe) is the pure
 * `shared/attention-notifications`; this only SHOWS the decided intents as
 * `electron.Notification`s and wires each one's click to focus/navigate.
 *
 * `showNotifications` takes the intents, an `onActivate` callback (index.ts
 * focuses the Window and sends the navigate message), and — injectable for
 * tests — the low-level `show`. The default `show` is the real Electron
 * Notification; the injected one lets the wiring (one Notification per intent;
 * click → onActivate with the right target) be unit-tested with no Electron.
 */
import { Notification } from 'electron';
import type { NotificationIntent } from '../shared/attention-notifications';

/** Where a clicked notification should take the human. */
export interface NotificationTarget {
  /** The workbench project directory name to open/focus. */
  project: string;
  /** The issue to select on the Project's attention surface, or null. */
  issueId: number | null;
}

/**
 * The low-level "show one notification" primitive. Given the title/body and a
 * click handler, present it. Injected in tests; defaults to Electron.
 */
export type ShowNotification = (opts: {
  title: string;
  body: string;
  onClick: () => void;
}) => void;

/**
 * The default primitive: a real Electron `Notification`, its `click` wired to
 * the handler. A no-op when the OS/Electron reports notifications unsupported
 * (a headless CI, an unentitled build) — never a throw.
 */
export const showElectronNotification: ShowNotification = ({ title, body, onClick }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', onClick);
  notification.show();
};

/**
 * Show each intent as a native notification, wiring its click to `onActivate`
 * with the intent's target (project + issue). Pure fan-out over the intents;
 * the intents themselves are already tier-filtered and deduped upstream, so this
 * shows exactly what it is handed.
 */
export function showNotifications(
  intents: readonly NotificationIntent[],
  onActivate: (target: NotificationTarget) => void,
  show: ShowNotification = showElectronNotification,
): void {
  for (const intent of intents) {
    show({
      title: intent.title,
      body: intent.body,
      onClick: () => onActivate({ project: intent.project, issueId: intent.issueId }),
    });
  }
}
