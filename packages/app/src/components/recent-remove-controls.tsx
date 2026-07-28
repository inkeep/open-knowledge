/**
 * Shared per-recent removal affordances used by the project switcher and the
 * command palette — the VS Code "Open Recent" remove controls:
 *   - `RecentRemoveButton`: a trailing "×" revealed on row hover. Rendered as a
 *     SIBLING of the row's menu/option item (never nested inside it) so its click
 *     can't fall through to the item's open action. `tabIndex={-1}` keeps it out
 *     of the menu's Tab order (Radix/cmdk trap Tab), and `aria-hidden` keeps this
 *     mouse-only control out of the accessibility tree so it isn't a non-menuitem
 *     control owned by the enclosing `role="menu"`/`role="listbox"` (an axe
 *     `aria-required-children` violation). `aria-hidden` + `tabIndex={-1}` is the
 *     documented-safe pairing — no `aria-hidden-focus` regression. Keyboard / AT
 *     users remove via the context menu.
 *   - `RecentItemContextMenu`: wraps a row so right-click (or the context-menu
 *     key on the focused row) offers "Remove from recent projects" — the
 *     Welcome-page affordance and the keyboard-reachable path the mouse-only ×
 *     can't provide.
 *
 * Removal itself (the `bridge.project.removeRecent` call + optimistic list
 * update) lives in each surface's owner; these controls only wire the gesture
 * to the passed `onRemoveRecent`. `testIdPrefix` namespaces the emitted
 * `data-testid`s per surface (`project-switcher-recent` / `command-palette-recent`).
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export function RecentRemoveButton({
  path,
  name,
  onRemoveRecent,
  testIdPrefix,
}: {
  path: string;
  name: string;
  onRemoveRecent: (path: string) => void;
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      tabIndex={-1}
      // Hidden from the accessibility tree (see file header): a mouse-only "×"
      // owned by a role="menu"/"listbox" would otherwise trip axe
      // aria-required-children. The context menu is the keyboard / AT removal
      // path, and the aria-label stays for the visible title + as intent doc.
      aria-hidden="true"
      aria-label={t`Remove ${name} from recent projects`}
      title={t`Remove from recent projects`}
      onClick={(e) => {
        e.stopPropagation();
        onRemoveRecent(path);
      }}
      className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/recent:opacity-100 focus-visible:opacity-100"
      data-testid={`${testIdPrefix}-remove-${path}`}
    >
      <X aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

export function RecentItemContextMenu({
  path,
  onRemoveRecent,
  testIdPrefix,
  children,
}: {
  path: string;
  onRemoveRecent: (path: string) => void;
  testIdPrefix: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => onRemoveRecent(path)}
          data-testid={`${testIdPrefix}-context-remove-${path}`}
        >
          <X aria-hidden="true" />
          <Trans>Remove from recent projects</Trans>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
