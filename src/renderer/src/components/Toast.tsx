/**
 * Toast primitive (issue 123, ADR-0020) — Radix Toast for behavior (timed
 * dismissal, swipe, hotkey-reachable viewport, aria live region), Atlas
 * tokens for the visuals (`ui-toast` in index.css). Mount ONE ToastProvider
 * (it carries the viewport); render a <Toast> per transient confirmation.
 */
import * as RadixToast from '@radix-ui/react-toast';
import type { ReactNode } from 'react';

/** App-level provider + the fixed viewport toasts stack into. */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <RadixToast.Provider swipeDirection="right" duration={5000}>
      {children}
      <RadixToast.Viewport className="ui-toast__viewport" />
    </RadixToast.Provider>
  );
}

/** One transient toast, token-styled. Control with open/onOpenChange. */
export function Toast({
  className,
  children,
  ...props
}: RadixToast.ToastProps): JSX.Element {
  return (
    <RadixToast.Root className={`ui-toast${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixToast.Root>
  );
}

export function ToastTitle({
  className,
  children,
  ...props
}: RadixToast.ToastTitleProps): JSX.Element {
  return (
    <RadixToast.Title className={`ui-toast__title${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixToast.Title>
  );
}

export function ToastDescription({
  className,
  children,
  ...props
}: RadixToast.ToastDescriptionProps): JSX.Element {
  return (
    <RadixToast.Description
      className={`ui-toast__text${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </RadixToast.Description>
  );
}
