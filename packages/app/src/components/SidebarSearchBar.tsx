/**
 * Sidebar search affordance — an icon-only `<button>` (magnifying glass) that
 * sits at the trailing edge of the Files/Skills chrome row. Clicking invokes the
 * consumer's `onClick` handler; the component owns no semantics beyond that. The
 * component does NOT install a key listener — callers wire the keyboard binding
 * separately (the editor app registers the global ⌘K/Ctrl+K listener inside
 * CommandPalette at the App root); the shortcut shown in the tooltip is
 * presentational.
 *
 * Accessibility: icon-only, so the button carries a translated `aria-label`
 * ("Search") as its accessible name (WCAG 2.5.3 Label in Name; voice-input tools
 * like macOS Voice Control and Dragon match "Click Search" against it). The
 * Search icon is `aria-hidden`. The keyboard hint moves into the tooltip (with a
 * `text-foreground/70` kbd for WCAG 1.4.3 AA contrast over the dark tooltip
 * surface); it is discoverable on hover/focus rather than always-visible.
 */

import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import type { ErrorInfo } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut } from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';

interface SidebarSearchBarProps {
  onClick: () => void;
  className?: string;
}

/**
 * ErrorBoundary `onError` handler for the pill. Extracted from the JSX so
 * the observability emission is reachable as a standalone function rather
 * than only through a render throw.
 *
 * Shape matches MathInlineView + JsxComponentView (the other two
 * `react-error-boundary` consumers): `event: 'jsx-render-failure'`,
 * `component: '<stable-surface-identifier>'`, structured JSON to
 * `console.warn`, paired with `incrementJsxRenderFailure(<component>)` so
 * a single dashboard / alert rule covers every render-throw surface. The
 * pill isn't a JSX component, so `component` and `rawComponentName`
 * collapse to the same value — keeping the field present (rather than
 * absent) lets a single log query
 * `event='jsx-render-failure' AND rawComponentName=...` cover every
 * surface uniformly.
 */
export function onPillRenderError(error: unknown, info: ErrorInfo): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.warn(
    JSON.stringify({
      event: 'jsx-render-failure',
      component: 'sidebarSearchPill',
      rawComponentName: 'sidebarSearchPill',
      error: String(err),
      stack: info.componentStack,
    }),
  );
  incrementJsxRenderFailure('sidebarSearchPill');
}

export function SidebarSearchBar({ onClick, className }: SidebarSearchBarProps) {
  const { t } = useLingui();
  const label = t`Search`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          // `data-telemetry-event` convention:
          // `ok.<surface>.<element>.<interaction>` (dot-separated, snake_case
          // for multi-word segments — same shape as the existing `ok.*` OTel
          // span/metric namespace in packages/server/src/telemetry.ts and
          // packages/app/src/telemetry-impl.ts). Stable DOM selector for
          // future click-analytics; not auto-consumed by the existing
          // UserInteractionInstrumentation. Kept as `search_pill` so historical
          // analytics stay on one key across the pill→icon redesign.
          data-telemetry-event="ok.sidebar.search_pill.click"
          className={cn('shrink-0 text-muted-foreground', className)}
        >
          <Search aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <Kbd className="text-foreground/70">{formatShortcut('command-palette')}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
