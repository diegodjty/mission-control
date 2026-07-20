/**
 * The component primitives library (issue 123, ADR-0020) — the ONLY place
 * visual identity lives. Behavior comes from headless Radix primitives
 * (Dialog, DropdownMenu, Tabs, Tooltip, Toast); Button/Card/Badge/Input are
 * hand-rolled in the same pattern. Every visual is an Atlas design token
 * (index.css), so both themes render correctly by construction. Views
 * compose these instead of hand-rolling chrome.
 */
export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription, DialogActions } from './Dialog';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './DropdownMenu';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export { Tooltip, TooltipProvider } from './Tooltip';
export { TruncatedText, type TruncatedTextProps } from './TruncatedText';
export { Toast, ToastProvider, ToastTitle, ToastDescription } from './Toast';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, type CardProps } from './Card';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Input, type InputProps } from './Input';
export { RichViewer, RichBlockView, InlineText, type RichViewerProps } from './RichViewer';
export {
  BarChart,
  StackedBarChart,
  LineChart,
  type BarChartDatum,
  type BarChartProps,
  type StackedBarSegment,
  type StackedBarDatum,
  type StackedBarChartProps,
  type LinePoint,
  type LineSeries,
  type LineChartProps,
} from './Charts';
