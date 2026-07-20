import { useEffect, useId, useState } from 'react';
import './RichViewer.css';
import {
  parseInline,
  parseRichDoc,
  type RichBlock,
} from '../../../shared/rich-viewer-model';

/**
 * The shared rich viewer (issue 179, ADR-0023) — the one renderer for every
 * read-only doc surface (PlanningView's live preview, the curator-report
 * view, the CORE-proposal diff). Grown out of PlanningView's hand-rolled
 * markdown block renderer (issue 83) once a second, then third, caller
 * needed the exact same rendering (issue 151) — this is that renderer's one
 * home instead of a fourth copy. Renders three content kinds, no webview and
 * no charting library: markdown blocks, `mermaid` fences (lazy-loaded SVG,
 * degrading to raw text on a malformed diagram), and — via the sibling
 * `Charts` module — hand-rolled SVG chart primitives callers feed data to
 * directly (charts don't come from markdown text, so they aren't part of
 * the parse; a caller composes `<RichViewer>` alongside a `<BarChart>` etc.
 * in the same pane).
 */
export interface RichViewerProps {
  /** Raw document text — optional leading frontmatter + markdown body. */
  text: string;
}

/** Render one block's text with inline code/bold runs made legible. */
export function InlineText({ text }: { text: string }): JSX.Element {
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

/** Read the Atlas design tokens as mermaid `themeVariables` so a diagram's
 *  own inline SVG styling (mermaid bakes colours into the SVG at render
 *  time, it can't just inherit our CSS) matches the active theme. */
function mermaidThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string): string => style.getPropertyValue(name).trim();
  return {
    background: v('--surface') || v('--bg1'),
    primaryColor: v('--surface-2'),
    primaryTextColor: v('--fg'),
    primaryBorderColor: v('--border-strong'),
    lineColor: v('--fg-mute'),
    secondaryColor: v('--surface-3'),
    tertiaryColor: v('--bg1'),
    textColor: v('--fg-soft'),
    fontFamily: v('--font-sans'),
  };
}

/**
 * One ```mermaid fence, lazy-rendered to inline SVG. `mermaid` is imported
 * dynamically so it never lands in the initial critical bundle — only a
 * pane that actually has a diagram on screen pays for it. A malformed
 * diagram (or a `mermaid.render` rejection) falls back to the raw fenced
 * text instead of crashing the viewer.
 */
function MermaidBlock({ text }: { text: string }): JSX.Element {
  const domId = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const [themeTick, setThemeTick] = useState(0);
  const [result, setResult] = useState<{ svg: string } | { failed: true } | null>(null);

  // Re-render when the app's light/dark toggle flips <html data-theme>
  // (App.tsx mirrors the Atlas theme there) — mermaid bakes theme colours
  // into the SVG at render time, so it needs a fresh render, not just CSS.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: mermaidThemeVariables(),
        });
        const { svg } = await mermaid.render(`richviewer-mermaid-${domId}`, text);
        if (!cancelled) setResult({ svg });
      } catch {
        if (!cancelled) setResult({ failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, domId, themeTick]);

  if (result === null) return <div className="richviewer__mermaid-loading">Rendering diagram…</div>;
  if ('failed' in result) return <pre className="richviewer__mermaid-fallback">{text}</pre>;
  // The SVG string comes from mermaid's own `strict` sanitizer, rendering
  // our own local doc text (never remote/untrusted content) — safe to inject.
  return <div className="richviewer__mermaid" dangerouslySetInnerHTML={{ __html: result.svg }} />;
}

/** One parsed rich-doc block. */
export function RichBlockView({ block }: { block: RichBlock }): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(block.level, 4);
      return (
        <div className={`richviewer__h richviewer__h--${level}`}>
          <InlineText text={block.text} />
        </div>
      );
    }
    case 'code':
      return <pre className="richviewer__code">{block.text}</pre>;
    case 'mermaid':
      return <MermaidBlock text={block.text} />;
    case 'quote':
      return (
        <blockquote className="richviewer__quote">
          <InlineText text={block.text} />
        </blockquote>
      );
    case 'rule':
      return <hr className="richviewer__rule" />;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'richviewer__task'}>
          {item.checked !== null && (
            <span className="richviewer__checkbox">{item.checked ? '☑' : '☐'}</span>
          )}
          <InlineText text={item.text} />
        </li>
      ));
      return block.ordered ? (
        <ol className="richviewer__list">{items}</ol>
      ) : (
        <ul className="richviewer__list">{items}</ul>
      );
    }
    case 'para':
      return (
        <p className="richviewer__para">
          <InlineText text={block.text} />
        </p>
      );
  }
}

/**
 * Render one document's frontmatter chips + markdown/mermaid blocks. The
 * one shared component every read-only doc pane (PlanningView, the
 * curator-report view, the CORE-proposal diff) renders through.
 */
export function RichViewer({ text }: RichViewerProps): JSX.Element {
  const parsed = parseRichDoc(text);
  return (
    <>
      {parsed.frontmatter.length > 0 && (
        <div className="richviewer__frontmatter">
          {parsed.frontmatter.map((f, i) => (
            <span key={i} className="richviewer__fm">
              {f.key !== '' && <span className="richviewer__fm-key">{f.key}</span>}
              <span className="richviewer__fm-value">{f.value}</span>
            </span>
          ))}
        </div>
      )}
      <div className="richviewer__render">
        {parsed.blocks.map((block, i) => (
          <RichBlockView key={i} block={block} />
        ))}
      </div>
    </>
  );
}
