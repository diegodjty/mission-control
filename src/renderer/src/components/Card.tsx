/**
 * Card primitive (issue 123, ADR-0020) — the Atlas glass surface: token
 * background, border, radius, and shadow in one place. `raised` uses the
 * stronger surface for hover-elevated or active cards.
 */
import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  raised?: boolean;
}

export function Card({ raised = false, className, children, ...props }: CardProps): JSX.Element {
  return (
    <div
      className={`ui-card${raised ? ' ui-card--raised' : ''}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </div>
  );
}
