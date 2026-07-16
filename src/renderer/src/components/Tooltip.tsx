/**
 * Tooltip primitive (issue 123, ADR-0020) — Radix Tooltip for behavior
 * (hover/focus timing, positioning, dismissal), Atlas tokens for the visuals
 * (`ui-tooltip` in index.css). Mount ONE TooltipProvider near the app root;
 * wrap any trigger in <Tooltip content="...">.
 */
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** App-level provider: one delay policy for every tooltip. */
export function TooltipProvider({ children }: { children: ReactNode }): JSX.Element {
  return <RadixTooltip.Provider delayDuration={350}>{children}</RadixTooltip.Provider>;
}

export interface TooltipProps {
  /** The tip's content — usually the full text a truncated label elides. */
  content: ReactNode;
  /** Which side to prefer (Radix flips when space runs out). */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger element (rendered as-is via asChild). */
  children: ReactNode;
}

export function Tooltip({ content, side = 'top', children }: TooltipProps): JSX.Element {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="ui-tooltip" side={side} sideOffset={6}>
          {content}
          <RadixTooltip.Arrow className="ui-tooltip__arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
