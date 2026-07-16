/**
 * Button primitive (issue 123, ADR-0020) — hand-rolled (no headless behavior
 * to borrow), styled only via Atlas tokens (`ui-btn` in index.css).
 *
 *   primary   — the teal go-ahead (confirm, open, run)
 *   danger    — a destructive/interrupting act (red family)
 *   secondary — a neutral bordered alternative beside a primary
 *   ghost     — the quiet bordered dismiss/cancel
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'danger' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className, type, children, ...props },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      // Never accidentally a submit button inside a form.
      type={type ?? 'button'}
      className={`ui-btn ui-btn--${variant}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </button>
  );
});
