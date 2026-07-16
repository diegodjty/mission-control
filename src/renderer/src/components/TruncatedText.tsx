/**
 * TruncatedText primitive (issue 126, ADR-0020) — the shared "graceful
 * truncation" pattern the responsive base establishes: text that clips to one
 * line with an ellipsis and reveals its full self through the Tooltip primitive
 * *only when it's actually cut off*. Long Project names, issue titles, and Run
 * labels use this so a narrow layout degrades legibly instead of overflowing.
 *
 * Overflow is measured (scrollWidth vs clientWidth) rather than assumed, so a
 * label that fits carries no tooltip noise; a ResizeObserver re-measures on
 * every container resize (rail collapse, Dispatcher-panel drag, window resize),
 * so the tooltip appears/disappears as the available width changes. Requires a
 * TooltipProvider mounted at the app root (the AppShell mounts one).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';

export interface TruncatedTextProps {
  /** The full text — clipped with an ellipsis, revealed via tooltip when cut. */
  text: string;
  /** Extra class(es) for the visible element (e.g. a view's typographic style). */
  className?: string;
  /** Preferred tooltip side (Radix flips it when space runs out). */
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export function TruncatedText({ text, className, side = 'bottom' }: TruncatedTextProps): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // +1 absorbs sub-pixel rounding so a label that exactly fits isn't judged
    // truncated (which would attach a pointless tooltip).
    const measure = (): void => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const label = (
    <span ref={ref} className={`ui-truncate${className ? ` ${className}` : ''}`}>
      {text}
    </span>
  );

  // Only wrap in a Tooltip when the text is genuinely clipped; the ref stays on
  // the same element across the transition, so measurement keeps working.
  return truncated ? (
    <Tooltip content={text} side={side}>
      {label}
    </Tooltip>
  ) : (
    label
  );
}
