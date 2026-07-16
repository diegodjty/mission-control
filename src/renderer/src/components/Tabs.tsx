/**
 * Tabs primitive (issue 123, ADR-0020) — Radix Tabs for behavior (roving
 * focus, arrow keys, aria wiring), Atlas tokens for the visuals (`ui-tabs`
 * in index.css). The look mirrors the shell's tab language: quiet glass
 * buttons, teal active state.
 */
import * as RadixTabs from '@radix-ui/react-tabs';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, children, ...props }: RadixTabs.TabsListProps): JSX.Element {
  return (
    <RadixTabs.List className={`ui-tabs__list${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixTabs.List>
  );
}

export function TabsTrigger({
  className,
  children,
  ...props
}: RadixTabs.TabsTriggerProps): JSX.Element {
  return (
    <RadixTabs.Trigger className={`ui-tabs__tab${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabsContent({
  className,
  children,
  ...props
}: RadixTabs.TabsContentProps): JSX.Element {
  return (
    <RadixTabs.Content className={`ui-tabs__panel${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </RadixTabs.Content>
  );
}
