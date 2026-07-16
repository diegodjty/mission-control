import { useEffect, useMemo, useState } from 'react';
import type { AttentionItem } from '../../shared/attention-hub-model';
import type { AttentionSnapshot } from '../../shared/ipc-contract';
import { buildAttentionHub, kindLabel, mergeBriefing } from '../../shared/attention-hub-model';

interface AttentionProps {
  /** The live aggregated cross-project attention snapshot (issue 79). */
  snapshot: AttentionSnapshot;
  /** Open/switch to an item's project and focus its referenced thing. */
  onOpenItem: (item: AttentionItem) => void;
  /** Open a whole project from its group header (no specific focus). */
  onOpenProject: (project: string) => void;
  /**
   * Confirm a `new-repo-candidate` (issue 95): register the appeared repo in
   * place — this kind acts, it does not open the project.
   */
  onRegisterRepo: (item: AttentionItem) => void;
  /** A quiet outcome line from the last click-through (e.g. owned-elsewhere). */
  notice: string | null;
}

/**
 * The unified attention surface (issue 125, ADR-0020) — the one cross-project
 * answer to "where am I needed?", replacing the old Inbox tab. Items are
 * grouped by **Project** and ordered by urgency (parked **HITL** first), with
 * the since-last-seen journal **briefing** above them, exactly as the approved
 * mock (issue 122) lays it out. All shaping — the split, the grouping, the
 * urgency float, the needs-you counts — comes from the pure `attention-hub-
 * model`, the SAME model the rail badge and the Launcher cards read, so the
 * three can never disagree.
 *
 * A place you look, never a notifier (ADR-0012): rendering this component makes
 * no sound and injects nothing into any chat — its only side effect is
 * advancing the briefing's last-seen stamp (app userData, via main) because
 * being here IS looking. Clicking an item routes through the normal guarded
 * project-switch flow (interrupt guard included, issue 125) and lands on the
 * right view.
 *
 * The briefing is frozen at mount and merged with live arrivals: viewing
 * advances the stamp, which re-derives the snapshot WITHOUT the now-seen
 * entries — but what you are currently reading must not blink out from under
 * you, so the mount-time lines stay for the life of this view.
 */
export function Attention({
  snapshot,
  onOpenItem,
  onOpenProject,
  onRegisterRepo,
  notice,
}: AttentionProps): JSX.Element {
  // Freeze the briefing as it stood when the surface was opened.
  const [frozenBriefing] = useState<AttentionItem[]>(() => buildAttentionHub(snapshot.items).briefing);

  // Viewing the surface advances the last-seen stamp — once per view (mount).
  // StrictMode's dev double-invoke just advances to "now" twice: idempotent.
  useEffect(() => {
    void window.mc.markAttentionSeen().catch(() => {});
  }, []);

  const hub = useMemo(() => buildAttentionHub(snapshot.items), [snapshot.items]);
  const briefing = useMemo(
    () => mergeBriefing(frozenBriefing, hub.briefing),
    [frozenBriefing, hub.briefing],
  );

  return (
    <div className="attention">
      <div className="attention__body">
        {notice && <p className="attention__notice">{notice}</p>}

        {briefing.length > 0 && (
          /* The since-last-seen briefing (issue 80): quiet journal one-liners,
             preserved as the mock shows them — a labeled strip above the list. */
          <section className="attention__briefing">
            <header className="attention__briefing-head">
              <span className="attention__briefing-dot" aria-hidden="true" />
              <span className="attention__briefing-title">Briefing</span>
              <span className="attention__briefing-meta">
                — {briefing.length} journal entr{briefing.length === 1 ? 'y' : 'ies'} since you last
                looked
              </span>
            </header>
            <ul className="attention__briefing-list">
              {briefing.map((item) => (
                <li key={item.id} className="attention__briefing-line">
                  <span className="attention__project">{item.project}</span>
                  <span className="attention__text">{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hub.needsYou === 0 && briefing.length === 0 && (
          <p className="attention__empty">Nothing needs you.</p>
        )}
        {hub.needsYou === 0 && briefing.length > 0 && (
          <p className="attention__empty">Nothing needs you — just the briefing above.</p>
        )}

        {/* Groups by Project, urgency-ordered (parked HITL first) — the top of
            the list is always the right next thing (issue 125). */}
        {hub.groups.map((group) => (
          <section key={group.project} className="attention__group">
            <header className="attention__group-head">
              <span className="attention__group-title">
                <span className="attention__group-dot" aria-hidden="true" />
                {group.project}
              </span>
              <span
                className="attention__group-count"
                aria-label={`${group.needsYou} needs you`}
                title={`${group.needsYou} attention item${group.needsYou === 1 ? '' : 's'} awaiting you`}
              >
                {group.needsYou}
              </span>
              <button
                className="attention__group-open"
                onClick={() => onOpenProject(group.project)}
                title={`Open ${group.project}`}
              >
                open →
              </button>
            </header>
            <ul className="attention__list">
              {group.items.map((item) =>
                item.kind === 'new-repo-candidate' && item.candidate ? (
                  /* A candidate isn't opened — it's registered in place (issue
                     95). One click confirms; a new repo is new state, so MC
                     proposes and the human decides (never auto-registered). */
                  <li key={item.id} className="attention__item-cell">
                    <button
                      className={`attention__item attention__item--${item.kind}`}
                      onClick={() => onRegisterRepo(item)}
                      title={`Register ${item.candidate.path} in ${group.project} as "${item.candidate.suggestedKey}"`}
                    >
                      <span className={`attention__badge attention__badge--${item.kind}`}>
                        {kindLabel(item.kind)}
                      </span>
                      <span className="attention__text">{item.text}</span>
                      <span className="attention__action" aria-hidden="true">
                        Register
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={item.id} className="attention__item-cell">
                    <button
                      className={`attention__item attention__item--${item.kind}`}
                      onClick={() => onOpenItem(item)}
                      title={
                        item.fileRef
                          ? `Open ${group.project} and focus ${item.fileRef}`
                          : `Open ${group.project}`
                      }
                    >
                      <span className={`attention__badge attention__badge--${item.kind}`}>
                        {kindLabel(item.kind)}
                      </span>
                      <span className="attention__text">{item.text}</span>
                      <span className="attention__action" aria-hidden="true">
                        open →
                      </span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}

        {snapshot.notes.length > 0 && (
          /* Malformed-artifact notes: explicit but quiet (issue 78's "no
             silence about a skip"), tucked below the fold. */
          <details className="attention__notes">
            <summary className="attention__notes-summary">
              {snapshot.notes.length} artifact note{snapshot.notes.length === 1 ? '' : 's'}
            </summary>
            <ul className="attention__briefing-list">
              {snapshot.notes.map((note, i) => (
                <li key={i} className="attention__briefing-line">
                  <span className="attention__text">{note}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
