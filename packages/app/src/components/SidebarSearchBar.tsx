/**
 * Sidebar search affordance — a labeled `<button>` styled to look like an
 * input. Visible label, leading magnifying-glass icon, trailing always-visible
 * keyboard-shortcut keycap. Clicking invokes the consumer's `onClick` handler;
 * the component owns no semantics beyond that. The keycap is presentational —
 * the component does NOT install a key listener. Callers wire the keyboard
 * binding separately (the editor app registers the global ⌘K/Ctrl+K listener
 * inside CommandPalette at the App root).
 *
 * Accessibility: no `aria-label` on the button — the visible "Search" span is
 * contained in the button's accessible name (WCAG 2.5.3 Label in Name; voice-
 * input tools like macOS Voice Control and Dragon match "Click Search" against
 * the substring). The leading Search icon carries `aria-hidden="true"` —
 * decorative, the visible label is the accessible name. The kbd's content is
 * also picked up into the accessible name; that's a minor verbosity, not a
 * violation. (kbd intentionally lacks aria-hidden — Biome's
 * a11y/noAriaHiddenOnFocusable rule flags `aria-hidden="true"` on `<kbd>`
 * because the element has no implicit-role-map entry, so the rule
 * conservatively treats it as potentially interactive. `<kbd>` isn't
 * actually focusable by default, but the outcome — keeping the kbd's
 * content in the accessible name — is what we want regardless.)
 *
 * The kbd's foreground is `text-foreground/70` (not the inherited
 * `text-muted-foreground` from the parent Button) so the keyboard hint hits
 * WCAG 1.4.3 AA contrast (~5.3:1 over `bg-muted` in light theme; ~6.5:1 in
 * dark). The hint is informational — without it, the "discoverable from
 * the surface itself" promise fails for low-vision sighted users. The parent
 * Button's `text-muted-foreground` "Search" label still sits at ~3:1 against
 * the same backgrounds; that's a codebase-wide muted-foreground token
 * concern (also affects every other muted-text-on-muted-bg surface), not
 * fixable here without touching the design-token system.
 */

import { incrementJsxRenderFailure } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import type { ErrorInfo } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
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
  return (
    <Button
      variant="outline"
      onClick={onClick}
      // First use of `data-telemetry-event` in the codebase. Convention:
      // `ok.<surface>.<element>.<interaction>` (dot-separated, snake_case
      // for multi-word segments — same shape as the existing `ok.*` OTel
      // span/metric namespace in packages/server/src/telemetry.ts and
      // packages/app/src/telemetry-impl.ts). Stable DOM selector for
      // future click-analytics; not auto-consumed by the existing
      // UserInteractionInstrumentation.
      data-telemetry-event="ok.sidebar.search_pill.click"
      className={cn(
        'rounded-lg h-9 w-full justify-start gap-2 px-3 font-normal text-muted-foreground',
        className,
      )}
    >
      <Search aria-hidden="true" />
      <span className="flex-1 text-left text-sm">
        <Trans>Search</Trans>
      </span>
      <Kbd className="text-foreground/70">{formatShortcut('command-palette')}</Kbd>
    </Button>
  );
}
