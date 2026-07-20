import { useEffect, useMemo, useRef, useState } from 'react';
import './Docs.css';
import { Badge, RichViewer, type BadgeTone } from './components';
import type { DocEntry, DocGroup } from '../../shared/docs-model';

interface DocsViewProps {
  /** The active project's default code repo — ARCHITECTURE.md/CONTEXT.md/ADRs live here. */
  repoPath: string;
}

/** A short, human label for a doc's picker group. */
function groupLabel(group: DocGroup): string {
  switch (group) {
    case 'architecture':
      return 'architecture';
    case 'context':
      return 'context';
    case 'adr':
      return 'adr';
  }
}

/** The shared-Badge tone for a doc's picker group. */
function groupTone(group: DocGroup): BadgeTone {
  switch (group) {
    case 'architecture':
      return 'teal';
    case 'context':
      return 'neutral';
    case 'adr':
      return 'amber';
  }
}

/**
 * The Docs tab (issue 182, ADR-0023) — browse the active repo's documentation
 * through the shared rich viewer (issue 179), diagrams live: `docs/
 * ARCHITECTURE.md` (the four living diagrams) first, then `CONTEXT.md`, then
 * the `docs/adr/` list. File-watched (the Planning-view watch pattern, issue
 * 83): an edit on disk refreshes the view without a restart.
 */
export function DocsView({ repoPath }: DocsViewProps): JSX.Element {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string | null; error: string | null } | null>(
    null,
  );

  // Start the Docs watch for this repo; the initial entry list arrives
  // immediately, then on every debounced change. Leaving the view (unmount /
  // project switch) stops the watch.
  useEffect(() => {
    window.mc.watchDocs({ repoPath });
    const off = window.mc.onDocsChanged((msg) => {
      if (msg.repoPath === repoPath) setDocs(msg.docs);
    });
    return () => {
      off();
      window.mc.watchDocs({ repoPath: '' });
    };
  }, [repoPath]);

  // The selected doc: the user's pick while it still exists, else
  // ARCHITECTURE.md's spot (docs[0] — the primary surface, issue 182).
  const activePath = useMemo(() => {
    if (selectedPath !== null && docs.some((d) => d.path === selectedPath)) return selectedPath;
    return docs[0]?.path ?? null;
  }, [docs, selectedPath]);

  // Re-fetch the selected doc's content on every doc-set push (an edit on
  // disk bumps the pushed set, per docs-model's mtimeMs) and on selection
  // change. Stale responses (the selection moved while the read was in
  // flight) are discarded by path.
  const fetchSeq = useRef(0);
  useEffect(() => {
    if (activePath === null) {
      setContent(null);
      return;
    }
    const seq = ++fetchSeq.current;
    void window.mc
      .readDoc({ path: activePath })
      .then((res) => {
        if (fetchSeq.current !== seq) return;
        setContent({ path: res.path, text: res.content, error: res.error });
      })
      .catch((err: unknown) => {
        if (fetchSeq.current !== seq) return;
        setContent({
          path: activePath,
          text: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activePath, docs]);

  return (
    <div className="docs">
      <div className="docs__list">
        <div className="docs__list-head">Docs · {docs.length} document{docs.length === 1 ? '' : 's'}</div>
        {docs.length === 0 && (
          <p className="docs__empty">
            No docs found yet — add `docs/ARCHITECTURE.md`, `CONTEXT.md`, or `docs/adr/` files to
            this repo and they appear here.
          </p>
        )}
        <ul className="docs__items">
          {docs.map((d) => (
            <li key={d.path}>
              <button
                className={`docs__item${activePath === d.path ? ' docs__item--active' : ''}`}
                onClick={() => setSelectedPath(d.path)}
                title={d.path}
              >
                <Badge tone={groupTone(d.group)}>{groupLabel(d.group)}</Badge>
                <span className="docs__item-label">{d.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="docs__detail">
        {content === null && docs.length > 0 && <p className="docs__empty">Select a document.</p>}
        {content !== null && content.error !== null && <p className="docs__error">{content.error}</p>}
        {content?.text != null && <RichViewer text={content.text} />}
      </div>
    </div>
  );
}
