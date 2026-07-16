/**
 * Dialog primitive (issue 123, ADR-0020) — the ONE way the app presents a
 * modal: Radix Dialog for behavior (portal, overlay, focus trap, Escape,
 * aria wiring), Atlas tokens for every visual (see the `ui-dialog` styles in
 * index.css). Views compose these parts instead of hand-rolling overlays, so
 * every modal looks and behaves identically in both themes by construction.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

/** The dialog root — controlled via `open` / `onOpenChange`, like Radix. */
export const Dialog = RadixDialog.Root;

/** Wrap the element that opens the dialog (uncontrolled usage). */
export const DialogTrigger = RadixDialog.Trigger;

/** Wrap any element that should close the dialog (e.g. a Cancel button). */
export const DialogClose = RadixDialog.Close;

/**
 * The dialog panel: portal + dimmed overlay + centered content, focus-trapped
 * with Escape and outside-click closing (both land on `onOpenChange(false)`,
 * so a controlled caller treats them as Cancel).
 */
export function DialogContent({
  className,
  children,
  ...props
}: RadixDialog.DialogContentProps): JSX.Element {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="ui-dialog__overlay" />
      <RadixDialog.Content
        className={`ui-dialog${className ? ` ${className}` : ''}`}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/** The dialog's heading — Radix labels the dialog with it for assistive tech. */
export function DialogTitle({
  className,
  children,
  ...props
}: RadixDialog.DialogTitleProps): JSX.Element {
  return (
    <RadixDialog.Title
      className={`ui-dialog__title${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </RadixDialog.Title>
  );
}

/** The dialog's body text — wired as the accessible description. */
export function DialogDescription({
  className,
  children,
  ...props
}: RadixDialog.DialogDescriptionProps): JSX.Element {
  return (
    <RadixDialog.Description
      className={`ui-dialog__text${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </RadixDialog.Description>
  );
}

/** The action row at the dialog's foot: buttons, wrap-friendly. */
export function DialogActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ui-dialog__actions">{children}</div>;
}
