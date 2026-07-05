import { useEffect, useMemo, useState } from 'react';
import type { AttentionItem } from '../../shared/attention-model';
import type { AttentionSnapshot } from '../../shared/ipc-contract';
import { kindLabel, mergeBriefing, splitInbox } from '../../shared/inbox-model';

interface InboxProps {
  /** The live aggregated cross-project attention snapshot (issue 79). */
  snapshot: AttentionSnapshot;
  /** Open/switch to an item's project and focus its referenced thing. */
  onOpenItem: (item: AttentionItem) => void;
  /** A quiet outcome line from the last click-through (e.g. owned-elsewhere). */
  notice: string | null;
}

/**
 * The Inbox (issue 80, ADR-0016): the cross-project attention list, grouped
 * by project, with the since-last-seen journal **briefing** above it. A place
 * you look, never a notifier (ADR-0012): rendering this component makes no
 * sound, shows no badge anywhere else, and injects nothing into any chat —
 * its only side effect is advancing the briefing's last-seen stamp (app
 * userData, via main) because being here IS looking.
 *
 * The briefing is frozen at mount and merged with live arrivals: viewing
 * advances the stamp, which re-derives the snapshot WITHOUT the now-seen
 * entries — but what you are currently reading must not blink out from under
 * you, so the mount-time lines stay for the life of this view.
 */
export function Inbox({ snapshot, onOpenItem, notice }: InboxProps): JSX.Element {
  // Freeze the briefing as it stood when the Inbox was opened.
  const [frozenBriefing] = useState<AttentionItem[]>(() => splitInbox(snapshot.items).briefing);

  // Viewing the Inbox advances the last-seen stamp — once per view (mount).
  // StrictMode's dev double-invoke just advances to "now" twice: idempotent.
  useEffect(() => {
    void window.mc.markAttentionSeen().catch(() => {});
  }, []);

  const view = useMemo(() => splitInbox(snapshot.items), [snapshot.items]);
  const briefing = useMemo(
    () => mergeBriefing(frozenBriefing, view.briefing),
    [frozenBriefing, view.briefing],
  );
  const itemCount = view.groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="inbox">
      <div className="inbox__body">
        {notice && <p className="inbox__notice">{notice}</p>}

        {briefing.length > 0 && (
          /* Collapsed by default — quiet text you can expand, never a ping. */
          <details className="inbox__briefing">
            <summary className="inbox__briefing-summary">
              Briefing — {briefing.length} journal entr{briefing.length === 1 ? 'y' : 'ies'} since
              you last looked
            </summary>
            <ul className="inbox__briefing-list">
              {briefing.map((item) => (
                <li key={item.id} className="inbox__briefing-line">
                  <span className="inbox__project">{item.project}</span>
                  <span className="inbox__text">{item.text}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {itemCount === 0 && briefing.length === 0 && (
          <p className="inbox__empty">Nothing needs you.</p>
        )}
        {itemCount === 0 && briefing.length > 0 && (
          <p className="inbox__empty">Nothing needs you — just the briefing above.</p>
        )}

        {view.groups.map((group) => (
          <section key={group.project} className="inbox__group">
            <h3 className="inbox__group-title">{group.project}</h3>
            <ul className="inbox__list">
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    className="inbox__item"
                    onClick={() => onOpenItem(item)}
                    title={
                      item.fileRef
                        ? `Open ${group.project} and focus ${item.fileRef}`
                        : `Open ${group.project}`
                    }
                  >
                    <span className={`inbox__badge inbox__badge--${item.kind}`}>
                      {kindLabel(item.kind)}
                    </span>
                    <span className="inbox__text">{item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {snapshot.notes.length > 0 && (
          /* Malformed-artifact notes: explicit but quiet (issue 78's "no
             silence about a skip"), tucked below the fold. */
          <details className="inbox__notes">
            <summary className="inbox__notes-summary">
              {snapshot.notes.length} artifact note{snapshot.notes.length === 1 ? '' : 's'}
            </summary>
            <ul className="inbox__briefing-list">
              {snapshot.notes.map((note, i) => (
                <li key={i} className="inbox__briefing-line">
                  <span className="inbox__text">{note}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
