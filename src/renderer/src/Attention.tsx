import { useEffect, useMemo, useState } from 'react';
import type { AttentionGroup, AttentionItem } from '../../shared/attention-hub-model';
import type { AttentionSnapshot } from '../../shared/ipc-contract';
import {
  buildAttentionHub,
  kindLabel,
  mergeBriefing,
  projectDirNameFromKey,
  scopeAttentionToWindow,
  workbenchProjectPath,
} from '../../shared/attention-hub-model';
import { RichViewer } from './components';

/** What the rendered-doc modal is currently showing (issue 151): a single
 *  curator report, or a project's proposed CORE.md beside its current one. */
type DocViewerTarget =
  | { kind: 'curator-report'; name: string; label: string }
  | { kind: 'curator-proposal'; project: string };

/** The proposal modal's confirm step (issue 169) — Accept requires an
 *  explicit second click naming it as the CORE.md sign-off; Dismiss does not
 *  (it discards a proposal, never CORE.md itself, so nothing to sign off). */
type ProposalConfirm = 'accept' | null;

interface AttentionProps {
  /** The live aggregated cross-project attention snapshot (issue 79). */
  snapshot: AttentionSnapshot;
  /**
   * This Window's own Project key (`ProjectView.key`), or null when this
   * Window has none open. Non-null scopes the surface to Window identity
   * (issue 150): the own project's items show expanded, every other
   * project's collapse to a count line. Null (no project open) shows the
   * full flat cross-project list, same as the Launcher.
   */
  ownProjectKey: string | null;
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
  ownProjectKey,
  onOpenItem,
  onOpenProject,
  onRegisterRepo,
  notice,
}: AttentionProps): JSX.Element {
  // Freeze the briefing as it stood when the surface was opened.
  const [frozenBriefing] = useState<AttentionItem[]>(() => buildAttentionHub(snapshot.items).briefing);
  // The collapsed "elsewhere" line starts collapsed every time the surface
  // (re)mounts — expanding is a deliberate look, not a remembered preference.
  const [elsewhereExpanded, setElsewhereExpanded] = useState(false);
  // The rendered-doc modal (issue 151): a curator report or a CORE proposal
  // diff. Opening one is a LOCAL view, never the project-switch click-through
  // the other item kinds use. A curator report stays read-only; a CORE
  // proposal gets Accept/Dismiss (issue 169) from inside the same modal.
  const [docViewer, setDocViewer] = useState<DocViewerTarget | null>(null);

  const openReport = (item: AttentionItem): void => {
    const name = item.fileRef?.split('/').pop();
    if (!name) return;
    setDocViewer({ kind: 'curator-report', name, label: item.text });
    void window.mc.markCuratorReportSeen({ name }).catch(() => {});
  };

  const openProposal = (item: AttentionItem): void => {
    setDocViewer({ kind: 'curator-proposal', project: item.project });
  };

  // Viewing the surface advances the last-seen stamp — once per view (mount).
  // StrictMode's dev double-invoke just advances to "now" twice: idempotent.
  useEffect(() => {
    void window.mc.markAttentionSeen().catch(() => {});
  }, []);

  // Curator-report items (issue 151) are global — not owned by any single
  // Project — so they're pulled out before grouping and shown in their own
  // always-visible section, in every Window, regardless of window scoping.
  const curatorReportItems = useMemo(
    () => snapshot.items.filter((i) => i.kind === 'curator-report'),
    [snapshot.items],
  );
  const hub = useMemo(
    () => buildAttentionHub(snapshot.items.filter((i) => i.kind !== 'curator-report')),
    [snapshot.items],
  );
  const briefing = useMemo(
    () => mergeBriefing(frozenBriefing, hub.briefing),
    [frozenBriefing, hub.briefing],
  );

  // This Window has a Project open exactly when `ownProjectKey` is non-null —
  // that's what scopes the surface to Window identity (issue 150). A legacy
  // Project (no matching workbench directory name) still scopes: it simply
  // has no "own" group, so every project shows collapsed.
  const isWindowScoped = ownProjectKey !== null;
  const ownProject = useMemo(
    () => (ownProjectKey !== null ? projectDirNameFromKey(snapshot.workbenchRoot, ownProjectKey) : null),
    [ownProjectKey, snapshot.workbenchRoot],
  );
  const windowView = useMemo(() => scopeAttentionToWindow(hub, ownProject), [hub, ownProject]);

  return (
    <div className="attention">
      <div className="attention__body">
        {notice && <p className="attention__notice">{notice}</p>}

        {curatorReportItems.length > 0 && (
          /* Curator-report items (issue 151): the weekly memory-curator pass,
             global and outside window scoping — always visible, in every
             Window. Opening one renders it in place (never a project switch). */
          <section className="attention__curator-reports">
            <header className="attention__group-head">
              <span className="attention__group-title">
                <span className="attention__group-dot" aria-hidden="true" />
                Curator reports
              </span>
              <span
                className="attention__group-count"
                aria-label={`${curatorReportItems.length} unread curator report${curatorReportItems.length === 1 ? '' : 's'}`}
              >
                {curatorReportItems.length}
              </span>
            </header>
            <ul className="attention__list">
              {curatorReportItems.map((item) => (
                <li key={item.id} className="attention__item-cell">
                  <button
                    className={`attention__item attention__item--${item.kind}`}
                    onClick={() => openReport(item)}
                    title={`Open ${item.text}`}
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
              ))}
            </ul>
          </section>
        )}

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

        {hub.needsYou === 0 && curatorReportItems.length === 0 && briefing.length === 0 && (
          <p className="attention__empty">Nothing needs you.</p>
        )}
        {hub.needsYou === 0 && curatorReportItems.length === 0 && briefing.length > 0 && (
          <p className="attention__empty">Nothing needs you — just the briefing above.</p>
        )}

        {/* Window-scoped (issue 150): this Window's own Project expanded,
            first-class; every other project collapsed to one quiet count
            line below. Nothing is lost — ADR-0016's cross-project guarantee
            holds, only the presentation narrows to Window identity. */}
        {isWindowScoped && windowView.own && (
          <AttentionGroupSection
            group={windowView.own}
            workbenchRoot={snapshot.workbenchRoot}
            onOpenItem={onOpenItem}
            onOpenProject={onOpenProject}
            onRegisterRepo={onRegisterRepo}
            onOpenProposal={openProposal}
          />
        )}

        {isWindowScoped && windowView.elsewhereTotal > 0 && (
          <section className="attention__elsewhere">
            <button
              type="button"
              className="attention__elsewhere-summary"
              onClick={() => setElsewhereExpanded((v) => !v)}
              aria-expanded={elsewhereExpanded}
              title="Show the other projects with something needing you"
            >
              <span className="attention__elsewhere-dot" aria-hidden="true" />
              <span className="attention__elsewhere-text">
                {windowView.elsewhereTotal} elsewhere:{' '}
                {windowView.elsewhere.map((e) => `${e.project} (${e.needsYou})`).join(' · ')}
              </span>
              <span className="attention__action" aria-hidden="true">
                {elsewhereExpanded ? '▲' : '▼'}
              </span>
            </button>
            {elsewhereExpanded && (
              <ul className="attention__elsewhere-list">
                {windowView.elsewhere.map((e) => (
                  <li key={e.project} className="attention__elsewhere-item">
                    <button
                      type="button"
                      className="attention__elsewhere-open"
                      onClick={() => onOpenProject(e.project)}
                      title={`Open ${e.project}`}
                    >
                      <span className="attention__project">{e.project}</span>
                      <span
                        className="attention__group-count"
                        aria-label={`${e.needsYou} needs you`}
                      >
                        {e.needsYou}
                      </span>
                      <span className="attention__action" aria-hidden="true">
                        open →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* No project open in this Window (the Launcher/home case) — the full
            flat cross-project list, urgency-ordered (parked HITL first). */}
        {!isWindowScoped &&
          hub.groups.map((group) => (
            <AttentionGroupSection
              key={group.project}
              group={group}
              workbenchRoot={snapshot.workbenchRoot}
              onOpenItem={onOpenItem}
              onOpenProject={onOpenProject}
              onRegisterRepo={onRegisterRepo}
              onOpenProposal={openProposal}
            />
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

      {docViewer !== null && (
        <DocViewerModal target={docViewer} onClose={() => setDocViewer(null)} />
      )}
    </div>
  );
}

interface AttentionGroupSectionProps {
  group: AttentionGroup;
  /** The workbench root (issue 170): resolves a `run-timeout` item's project
   *  name to the project KEY its salvage actions need (ownership/identity). */
  workbenchRoot: string;
  onOpenItem: (item: AttentionItem) => void;
  onOpenProject: (project: string) => void;
  onRegisterRepo: (item: AttentionItem) => void;
  /** Open the rendered proposal-diff view in place (issue 151) — never the
   *  project-switch click-through `onOpenItem` performs for other kinds. */
  onOpenProposal: (item: AttentionItem) => void;
}

/** One Project's items, expanded — the shared rendering for the flat list
 *  (no project open) and for the Window-scoped own-project section. */
function AttentionGroupSection({
  group,
  workbenchRoot,
  onOpenItem,
  onOpenProject,
  onRegisterRepo,
  onOpenProposal,
}: AttentionGroupSectionProps): JSX.Element {
  return (
    <section className="attention__group">
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
          item.kind === 'run-timeout' ? (
            <TimeoutSalvageItem key={item.id} item={item} workbenchRoot={workbenchRoot} />
          ) : item.kind === 'new-repo-candidate' && item.candidate ? (
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
          ) : item.kind === 'curator-proposal' ? (
            /* A CORE proposal opens the rendered proposed-vs-current view in
               place (issue 151) — never a project switch. That view carries
               Accept/Dismiss (issue 169); a confirmed Accept click is the
               human's CORE.md sign-off. */
            <li key={item.id} className="attention__item-cell">
              <button
                className={`attention__item attention__item--${item.kind}`}
                onClick={() => onOpenProposal(item)}
                title={`Compare the proposed CORE.md against ${group.project}'s current one`}
              >
                <span className={`attention__badge attention__badge--${item.kind}`}>
                  {kindLabel(item.kind)}
                </span>
                <span className="attention__text">{item.text}</span>
                <span className="attention__action" aria-hidden="true">
                  compare →
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
  );
}

interface TimeoutSalvageItemProps {
  item: AttentionItem;
  workbenchRoot: string;
}

type SalvagePhase =
  | { stage: 'idle' }
  | { stage: 'verifying' }
  | { stage: 'verified'; passed: boolean; output: string }
  | { stage: 'resolving' }
  | { stage: 'resolved' }
  | { stage: 'error'; message: string };

/**
 * A `run-timeout` item's action (issue 170): a killed Run's worktree still
 * stands with unknown-quality work. One click runs the project's verify
 * commands (type-check + test) against it — never guessed, never skipped —
 * then offers the evidence-based next step: **Complete from worktree** when
 * green, **Discard & requeue** when red.
 */
function TimeoutSalvageItem({ item, workbenchRoot }: TimeoutSalvageItemProps): JSX.Element {
  const [phase, setPhase] = useState<SalvagePhase>({ stage: 'idle' });

  const projectPath = workbenchProjectPath(workbenchRoot, item.project);
  // The worktree path IS `<worktreeBase>/<slug>` by construction — its
  // basename is always the `NN-slug` (git-worktree-adapter's `worktreePathFor`).
  const slug = item.fileRef?.split('/').filter(Boolean).pop() ?? null;
  const target =
    projectPath && slug && item.issueId !== null
      ? { project: item.project, projectPath, slug, issueId: item.issueId }
      : null;

  const runVerify = (): void => {
    if (!target || phase.stage === 'verifying' || phase.stage === 'resolving') return;
    setPhase({ stage: 'verifying' });
    void window.mc
      .timeoutSalvageVerify(target)
      .then((res) => {
        if (res.error) setPhase({ stage: 'error', message: res.error });
        else setPhase({ stage: 'verified', passed: res.passed, output: res.output });
      })
      .catch((err: unknown) => {
        setPhase({ stage: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  };

  const resolve = (action: 'complete' | 'discard'): void => {
    if (!target) return;
    setPhase({ stage: 'resolving' });
    const call = action === 'complete' ? window.mc.timeoutSalvageComplete : window.mc.timeoutSalvageDiscard;
    void call(target)
      .then((res) => {
        if (res.ok) setPhase({ stage: 'resolved' });
        else setPhase({ stage: 'error', message: res.error ?? 'The action failed.' });
      })
      .catch((err: unknown) => {
        setPhase({ stage: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  };

  return (
    <li key={item.id} className="attention__item-cell">
      <div className={`attention__item attention__item--${item.kind}`}>
        <span className={`attention__badge attention__badge--${item.kind}`}>
          {kindLabel(item.kind)}
        </span>
        <span className="attention__text">{item.text}</span>
        {phase.stage === 'idle' && target && (
          <button type="button" className="attention__action" onClick={runVerify}>
            Verify &amp; resolve
          </button>
        )}
        {phase.stage === 'verifying' && <span className="attention__action">Verifying…</span>}
        {phase.stage === 'resolving' && <span className="attention__action">Working…</span>}
        {phase.stage === 'resolved' && <span className="attention__action">Resolved</span>}
        {phase.stage === 'error' && (
          <span className="attention__action" title={phase.message}>
            Failed
          </span>
        )}
      </div>
      {phase.stage === 'verified' && (
        <div className="attention__salvage-detail">
          <p>
            Verify {phase.passed ? 'PASSED' : 'FAILED'} — {phase.passed
              ? 'the worktree can be completed as-is.'
              : 'discard and let the drain retry from a fresh worktree.'}
          </p>
          <details>
            <summary>output</summary>
            <pre>{phase.output}</pre>
          </details>
          {phase.passed ? (
            <button type="button" onClick={() => resolve('complete')}>
              Complete from worktree
            </button>
          ) : (
            <button type="button" onClick={() => resolve('discard')}>
              Discard &amp; requeue
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** One fetched doc's rendered doc, or its load state — shared by both panes
 *  of the modal (a single report, or either half of the proposal diff). */
function DocPane({ title, text, error }: { title: string; text: string | null; error: string | null }): JSX.Element {
  return (
    <div className="attention__doc-pane">
      <div className="attention__doc-pane-title">{title}</div>
      <div className="attention__doc-pane-body">
        {text === null && error === null && <p className="attention__empty">Loading…</p>}
        {error !== null && <p className="attention__error">{error}</p>}
        {text !== null && <RichViewer text={text} />}
      </div>
    </div>
  );
}

interface DocViewerModalProps {
  target: DocViewerTarget;
  onClose: () => void;
}

/**
 * The rendered doc view for curator reports and CORE proposals (issue 151): a
 * curator report renders as one pane; a proposal renders two panes side by
 * side (proposed vs current) so the diff is judgeable at a glance. Reuses the
 * Planning view's markdown parse/render — the exact same legible rendering,
 * not a second implementation. A curator report stays read-only; a CORE
 * proposal (issue 169) gets Accept/Dismiss — the confirmed Accept click IS
 * the human's CORE.md sign-off (ADR-0015), the only path that writes it.
 */
function DocViewerModal({ target, onClose }: DocViewerModalProps): JSX.Element {
  const [report, setReport] = useState<{ text: string | null; error: string | null }>({
    text: null,
    error: null,
  });
  const [proposal, setProposal] = useState<{
    proposed: { text: string | null; error: string | null };
    current: { text: string | null; error: string | null };
  }>({ proposed: { text: null, error: null }, current: { text: null, error: null } });
  // Accept needs an explicit second click naming the sign-off; Dismiss acts
  // straight away. `busy` disables both buttons mid-flight so a double click
  // can never fire two writes. `actionError` surfaces a failed accept/dismiss
  // in place — the modal stays open so the human can retry or close.
  const [confirm, setConfirm] = useState<ProposalConfirm>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (target.kind === 'curator-report') {
      void window.mc
        .readCuratorReport({ name: target.name })
        .then((res) => {
          if (!cancelled) setReport({ text: res.content, error: res.error });
        })
        .catch((err: unknown) => {
          if (!cancelled) setReport({ text: null, error: err instanceof Error ? err.message : String(err) });
        });
    } else {
      void window.mc
        .readCoreProposal({ project: target.project })
        .then((res) => {
          if (cancelled) return;
          setProposal({
            proposed: { text: res.proposed, error: res.error ?? (res.proposed === null ? 'CORE.proposed.md not found' : null) },
            current: { text: res.current, error: res.error },
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setProposal({ proposed: { text: null, error: message }, current: { text: null, error: message } });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [target]);

  const runAction = (
    action: (req: { project: string }) => Promise<{ ok: boolean; error: string | null }>,
  ): void => {
    if (target.kind !== 'curator-proposal' || busy) return;
    setBusy(true);
    setActionError(null);
    void action({ project: target.project })
      .then((res) => {
        if (res.ok) {
          onClose();
        } else {
          setBusy(false);
          setActionError(res.error ?? 'The action failed.');
        }
      })
      .catch((err: unknown) => {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : String(err));
      });
  };

  const doAccept = (): void => runAction(window.mc.acceptCoreProposal);
  const doDismiss = (): void => runAction(window.mc.dismissCoreProposal);

  return (
    <div className="attention__modal-overlay" onClick={onClose}>
      <div className="attention__modal" onClick={(e) => e.stopPropagation()}>
        <header className="attention__modal-head">
          <span className="attention__modal-title">
            {target.kind === 'curator-report' ? target.label : `CORE proposal — ${target.project}`}
          </span>
          <button className="attention__modal-close" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        <div className={`attention__modal-body${target.kind === 'curator-proposal' ? ' attention__modal-body--split' : ''}`}>
          {target.kind === 'curator-report' ? (
            <DocPane title={target.label} text={report.text} error={report.error} />
          ) : (
            <>
              <DocPane title="Proposed" text={proposal.proposed.text} error={proposal.proposed.error} />
              <DocPane title="Current" text={proposal.current.text} error={proposal.current.error} />
            </>
          )}
        </div>
        {target.kind === 'curator-proposal' && (
          <footer className="attention__modal-foot">
            {actionError !== null && <p className="attention__error">{actionError}</p>}
            {confirm === 'accept' ? (
              <div className="attention__proposal-confirm">
                <span className="attention__proposal-confirm-text">
                  This applies the proposed CORE.md — your sign-off.
                </span>
                <button
                  type="button"
                  className="attention__proposal-action attention__proposal-action--accept"
                  onClick={doAccept}
                  disabled={busy || proposal.proposed.text === null}
                >
                  {busy ? 'Applying…' : 'Confirm accept'}
                </button>
                <button
                  type="button"
                  className="attention__proposal-action"
                  onClick={() => setConfirm(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="attention__proposal-actions">
                <button
                  type="button"
                  className="attention__proposal-action attention__proposal-action--dismiss"
                  onClick={doDismiss}
                  disabled={busy || proposal.proposed.text === null}
                  title="Delete the proposed CORE.md — the current CORE.md stays untouched"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="attention__proposal-action attention__proposal-action--accept"
                  onClick={() => setConfirm('accept')}
                  disabled={busy || proposal.proposed.text === null}
                  title="Replace CORE.md with the proposed content"
                >
                  Accept
                </button>
              </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
