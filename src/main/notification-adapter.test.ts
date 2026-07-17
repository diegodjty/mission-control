import { describe, expect, it, vi } from 'vitest';
import { showNotifications, type NotificationTarget } from './notification-adapter';
import type { NotificationIntent } from '../shared/attention-notifications';

function intent(over: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    key: 'mc:hitl-park:42',
    reason: 'hitl-park',
    project: 'mission-control',
    issueId: 42,
    title: 'mission-control · issue 42',
    body: 'parked (HITL)',
    ...over,
  };
}

describe('showNotifications — the thin adapter fan-out', () => {
  it('shows one notification per intent, with the intent title/body', () => {
    const shown: Array<{ title: string; body: string }> = [];
    showNotifications(
      [intent(), intent({ key: 'k2', title: 't2', body: 'b2' })],
      () => {},
      ({ title, body }) => shown.push({ title, body }),
    );
    expect(shown).toEqual([
      { title: 'mission-control · issue 42', body: 'parked (HITL)' },
      { title: 't2', body: 'b2' },
    ]);
  });

  it("routes a click to onActivate with the intent's project + issue target", () => {
    const activated: NotificationTarget[] = [];
    let click = (): void => {};
    showNotifications(
      [intent({ project: 'mc', issueId: 7 })],
      (target) => activated.push(target),
      ({ onClick }) => {
        click = onClick;
      },
    );
    expect(activated).toHaveLength(0); // nothing fires until clicked
    click();
    expect(activated).toEqual([{ project: 'mc', issueId: 7 }]);
  });

  it('is a no-op on an empty intent list', () => {
    const show = vi.fn();
    showNotifications([], () => {}, show);
    expect(show).not.toHaveBeenCalled();
  });
});
