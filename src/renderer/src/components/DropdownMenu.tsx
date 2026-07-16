/**
 * DropdownMenu primitive (issue 123, ADR-0020) — Radix DropdownMenu for
 * behavior (portal, positioning, typeahead, keyboard navigation, dismissal),
 * Atlas tokens for the visuals (`ui-menu` in index.css).
 */
import * as RadixMenu from '@radix-ui/react-dropdown-menu';

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;

/** The floating panel, portaled and token-styled. */
export function DropdownMenuContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: RadixMenu.DropdownMenuContentProps): JSX.Element {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={`ui-menu${className ? ` ${className}` : ''}`}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

/** One selectable row. */
export function DropdownMenuItem({
  className,
  children,
  ...props
}: RadixMenu.DropdownMenuItemProps): JSX.Element {
  return (
    <RadixMenu.Item className={`ui-menu__item${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixMenu.Item>
  );
}

/** A quiet group heading. */
export function DropdownMenuLabel({
  className,
  children,
  ...props
}: RadixMenu.DropdownMenuLabelProps): JSX.Element {
  return (
    <RadixMenu.Label className={`ui-menu__label${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixMenu.Label>
  );
}

/** A hairline between groups. */
export function DropdownMenuSeparator({
  className,
  ...props
}: RadixMenu.DropdownMenuSeparatorProps): JSX.Element {
  return (
    <RadixMenu.Separator
      className={`ui-menu__separator${className ? ` ${className}` : ''}`}
      {...props}
    />
  );
}
