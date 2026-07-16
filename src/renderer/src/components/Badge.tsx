/**
 * Badge primitive (issue 123, ADR-0020) — a small status chip. Tones map to
 * the Atlas semantic state tokens; `neutral` is the quiet glass default.
 */
import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'teal' | 'amber' | 'red' | 'green' | 'violet';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, children, ...props }: BadgeProps): JSX.Element {
  return (
    <span
      className={`ui-badge ui-badge--${tone}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </span>
  );
}
