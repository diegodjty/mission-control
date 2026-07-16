/**
 * Input primitive (issue 123, ADR-0020) — a single-line text input on the
 * Atlas tokens (`ui-input` in index.css): quiet border, teal focus ring,
 * correct in both themes.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
): JSX.Element {
  return <input ref={ref} className={`ui-input${className ? ` ${className}` : ''}`} {...props} />;
});
