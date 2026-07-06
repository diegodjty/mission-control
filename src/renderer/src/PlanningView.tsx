import { useEffect, useMemo, useRef, useState } from 'react';
import { Pane } from './Pane';
import type { PlanningDoc, PlanningStage } from '../../shared/planning-model';
import {
  parseInline,
  parsePlanningDoc,
  PLANNING_STAGES,
  stageInvocation,
  type PlanningBlock,
} from '../../shared/planning-model';
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

/** Render one block's text with inline code/bold runs made legible. */
function InlineText({ text }: { text: string }): JSX.Element {
  return (
    <>
      {parseInline(text).map((seg, i) =>
        seg.kind === 'code' ? (
          <code key={i}>{seg.text}</code>
        ) : seg.kind === 'bold' ? (
          <strong key={i}>{seg.text}</strong>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** One parsed markdown block of the read-only preview. */
function Block({ block }: { block: PlanningBlock }): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(block.level, 4);
      return (
        <div className={`planning__h planning__h--${level}`}>
          <InlineText text={block.text} />
        </div>
      );
    }
    case 'code':
      return <pre className="planning__code">{block.text}</pre>;
    case 'quote':
      return (
        <blockquote className="planning__quote">
          <InlineText text={block.text} />
        </blockquote>
      );
    case 'rule':
      return <hr className="planning__rule" />;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'planning__task'}>
          {item.checked !== null && (
            <span className="planning__checkbox">{item.checked ? '☑' : '☐'}</span>
          )}
          <InlineText text={item.text} />
        </li>
      ));
      return block.ordered ? (
        <ol className="planning__list">{items}</ol>
      ) : (
        <ul className="planning__list">{items}</ul>
      );
    }
    case 'para':
      return (
        <p className="planning__para">
          <InlineText text={block.text} />
        </p>
      );
  }
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

  const parsed = useMemo(
    () => (content?.text != null ? parsePlanningDoc(content.text) : null),
    [content],
  );

  // The warm Pane target: the project's default repo, CORE.md injected (main
  // reads it at the spawn edge) — exactly a Just-talk session.
  const talk = useMemo<TalkTarget>(
    () => ({ cwd: repoPath, workbenchProjectRoot: workbenchDir, label }),
    [repoPath, workbenchDir, label],
  );

  return (
    <div className="planning">
      <div className="planning__left">
        <div className="planning__stagebar">
          <span className="planning__stagelabel">Plan {label}:</span>
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
          {parsed !== null && (
            <>
              {parsed.frontmatter.length > 0 && (
                <div className="planning__frontmatter">
                  {parsed.frontmatter.map((f, i) => (
                    <span key={i} className="planning__fm">
                      {f.key !== '' && <span className="planning__fm-key">{f.key}</span>}
                      <span className="planning__fm-value">{f.value}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="planning__render">
                {parsed.blocks.map((block, i) => (
                  <Block key={i} block={block} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
