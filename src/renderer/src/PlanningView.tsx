import { useEffect, useMemo, useRef, useState } from 'react';
import './Planning.css';
import { Pane } from './Pane';
import { RichViewer } from './components';
import type { PlanningDoc, PlanningStage } from '../../shared/planning-model';
import { PLANNING_STAGES, stageInvocation } from '../../shared/planning-model';
import type { TalkTarget } from '../../shared/ipc-contract';

interface PlanningViewProps {
  /** The workbench project root — the planning docs' first root. */
  workbenchDir: string;
  /** The project's default repo — CONTEXT.md / docs/adr live here. */
  repoPath: string;
  /** Compact project label for the header. */
  label: string;
  /** The Pane's PTY session spawned — the parent attaches its submit pump. */
  onSession: (sessionId: string) => void;
  /** The Pane's session exited — the parent detaches the pump. */
  onSessionEnd: () => void;
  /** Raw user keystrokes in the Pane — feeds the defer-while-typing gate. */
  onInput: (data: string) => void;
  /** A stage button was clicked — the parent pumps the skill invocation. */
  onStage: (stage: PlanningStage) => void;
}

/**
 * The thin Planning view (issue 83, ADR-0016): left, a normal warm Pane the
 * grill/to-prd/to-issues session runs in; right, a LIVE read-only preview of
 * the documents planning writes — the workbench PRDs + issues and the repo's
 * CONTEXT.md / docs/adr — file-watched, most-recently-changed first, so the
 * doc being written now floats to the top. Three stage buttons type the
 * corresponding skill invocation into the Pane through the parent's submit
 * pump (typed then submitted, honoring the defer-while-typing gate).
 * Deliberately NOT structured chat, doc editing, or multi-pane planning.
 */
export function PlanningView({
  workbenchDir,
  repoPath,
  label,
  onSession,
  onSessionEnd,
  onInput,
  onStage,
}: PlanningViewProps): JSX.Element {
  const [docs, setDocs] = useState<PlanningDoc[]>([]);
  // Bumped when a PREFIX stage (Grill) is clicked, so the Pane grabs keyboard
  // focus and the user can finish the sentence + press Enter (issue 91).
  const [paneFocusSignal, setPaneFocusSignal] = useState(0);
  // The user's pinned doc (clicked in the list), or null = follow the most
  // recently changed doc — the "watch the document being written" default.
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string | null; error: string | null } | null>(null);

  // Start the planning watch for this project's roots; the initial doc list
  // arrives immediately, then on every debounced change. Leaving the view
  // (unmount / project switch) stops the watch.
  useEffect(() => {
    window.mc.watchPlanning({ workbenchDir, repoPath });
    const off = window.mc.onPlanningChanged((msg) => {
      if (msg.workbenchDir === workbenchDir) setDocs(msg.docs);
    });
    return () => {
      off();
      window.mc.watchPlanning({ workbenchDir: '', repoPath: '' });
    };
  }, [workbenchDir, repoPath]);

  // The doc the preview shows: the pinned one while it still exists, else the
  // most recently changed (docs[0] — the push is already recency-ordered).
  const selectedPath = useMemo(() => {
    if (pinnedPath !== null && docs.some((d) => d.path === pinnedPath)) return pinnedPath;
    return docs[0]?.path ?? null;
  }, [docs, pinnedPath]);

  // Re-fetch the selected doc's content on every doc-set push (a push means
  // something really changed) and on selection change. Stale responses (the
  // selection moved while the read was in flight) are discarded by path.
  const fetchSeq = useRef(0);
  useEffect(() => {
    if (selectedPath === null) {
      setContent(null);
      return;
    }
    const seq = ++fetchSeq.current;
    void window.mc
      .readPlanningDoc({ path: selectedPath })
      .then((res) => {
        if (fetchSeq.current !== seq) return;
        setContent({ path: res.path, text: res.content, error: res.error });
      })
      .catch((err: unknown) => {
        if (fetchSeq.current !== seq) return;
        setContent({
          path: selectedPath,
          text: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [selectedPath, docs]);

  // The warm Pane target: the project's default repo, CORE.md injected (main
  // reads it at the spawn edge). Unlike Just-talk, this is a PLANNING session
  // (issue 101): `planning: true` makes the spawn carry the Workbench artifact
  // destination, so /to-prd and /to-issues write into the Workbench, not cwd.
  const talk = useMemo<TalkTarget>(
    () => ({ cwd: repoPath, workbenchProjectRoot: workbenchDir, planning: true, label }),
    [repoPath, workbenchDir, label],
  );

  return (
    <div className="planning">
      <div className="planning__left">
        {/* Left panel header — names the live planning session (the mock's
            "Run · planning" header). The dot mirrors the Map's liveness dot. */}
        <div className="planning__panehead">
          <span className="planning__panetitle">
            <span className="planning__dot" aria-hidden="true" />
            Planning
          </span>
          <span className="planning__panelabel">{label}</span>
        </div>
        <div className="planning__pane">
          <Pane
            talk={talk}
            onSession={onSession}
            onInput={onInput}
            onExit={onSessionEnd}
            focusSignal={paneFocusSignal}
          />
        </div>
      </div>

      <div className="planning__preview">
        {/* Right panel header — the live doc preview title plus the stage
            controls, placed here per the mock's layout. The stages keep their
            real labels/behaviour (Grill/PRD/Issues type their skill invocation
            into the LEFT session through the parent's submit pump). */}
        <div className="planning__previewhead">
          <span className="planning__previewtitle">Live doc preview</span>
          <div className="planning__stagebar">
            {PLANNING_STAGES.map(({ stage, label: stageLabel, hint }) => (
              <button
                key={stage}
                className="planning__stage"
                onClick={() => {
                  onStage(stage);
                  // A prefix stage (Grill) leaves the line unsubmitted — hand
                  // the keyboard to the terminal so the user finishes the
                  // sentence and presses Enter themselves (issue 91).
                  if (!stageInvocation(stage).submit) setPaneFocusSignal((n) => n + 1);
                }}
                title={hint}
              >
                {stageLabel}
              </button>
            ))}
          </div>
        </div>
        <div className="planning__doclist">
          <div className="planning__doclist-head">Documents · newest change first</div>
          {docs.length === 0 && (
            <p className="planning__empty">
              No planning documents yet — they appear here as the session writes them.
            </p>
          )}
          <ul className="planning__docs">
            {docs.map((d) => (
              <li key={d.path}>
                <button
                  className={`planning__doc${d.path === selectedPath ? ' planning__doc--active' : ''}`}
                  onClick={() => setPinnedPath(d.path)}
                  title={d.path}
                >
                  <span className={`planning__badge planning__badge--${d.group}`}>
                    {d.group}
                  </span>
                  <span className="planning__doc-label">{d.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {pinnedPath !== null && (
            <button
              className="planning__follow"
              onClick={() => setPinnedPath(null)}
              title="Stop pinning this document — follow whichever changed most recently"
            >
              Follow latest
            </button>
          )}
        </div>

        <div className="planning__doc-body">
          {content === null && <p className="planning__empty">Select a document.</p>}
          {content !== null && content.error !== null && (
            <p className="planning__error">{content.error}</p>
          )}
          {content?.text != null && <RichViewer text={content.text} />}
        </div>
      </div>
    </div>
  );
}
