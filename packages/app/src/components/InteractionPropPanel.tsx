/**
 * InteractionPropPanel — shared primitive for InteractionLayer PropPanels.
 *
 * Wraps shadcn `Popover` (Radix Popover) with a virtual anchor that tracks
 * the active chip's bounding rect via `@floating-ui/dom` `autoUpdate`. We
 * can't use `<PopoverTrigger>` directly because chips render as plain DOM
 * (precedent #18 — 768 React portals collapses
 * to one singleton). Instead, a zero-pointer-events `<PopoverAnchor>` span
 * follows the chip's rect; Radix anchors `<PopoverContent>` to it with
 * built-in flip + shift collision handling and focus management.
 *
 * **Trigger model:** open state is controlled externally by the
 * InteractionLayer's hover/focus state machine — chips don't toggle the
 * popover directly. The layer calls `store.setActiveNode(id)` from
 * pointerover/focusin/long-press; Radix sees `open=true` and mounts content.
 * Radix's own `onInteractOutside` / Escape handling routes to
 * `onOpenChange(false)` → `onDeactivate()` → `setActiveNode(null)`.
 *
 * **Focus discipline:** `onOpenAutoFocus={(e) => e.preventDefault()}` keeps
 * focus on the originating chip when the popover opens via hover. Keyboard
 * focus into the popover is driven by the layer's Tab interception (see
 * `interaction-layer.tsx`) so the chip stays the keyboard tabstop.
 * `onCloseAutoFocus={(e) => e.preventDefault()}` lets our own focus-
 * restoration in the layer handle the post-close target.
 */

import { autoUpdate, type VirtualElement } from '@floating-ui/dom';
import { type FC, type ReactNode, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';

type InteractionPropPanelKind =
  | 'internal-link'
  | 'wiki-link'
  | 'raw-mdx-fallback'
  | 'jsx-component';

interface InteractionPropPanelProps {
  kind: InteractionPropPanelKind;
  ariaLabel: string;
  onDeactivate: () => void;
  children: ReactNode;
  triggerReference: VirtualElement;
  layout?: 'standard' | 'wide';
  className?: string;
  'data-slot'?: string;
}

export const InteractionPropPanel: FC<InteractionPropPanelProps> = ({
  kind,
  ariaLabel,
  onDeactivate,
  children,
  triggerReference,
  layout = 'standard',
  className,
  'data-slot': dataSlot,
}) => {
  const anchorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const stop = autoUpdate(triggerReference, anchor, () => {
      const rect = triggerReference.getBoundingClientRect();
      if (!anchor.isConnected) return;
      anchor.style.left = `${rect.left}px`;
      anchor.style.top = `${rect.top}px`;
      anchor.style.width = `${rect.width}px`;
      anchor.style.height = `${rect.height}px`;
    });
    return stop;
  }, [triggerReference]);

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onDeactivate();
      }}
    >
      <PopoverAnchor asChild>
        <span
          ref={anchorRef}
          aria-hidden="true"
          style={{
            position: 'fixed',
            pointerEvents: 'none',
            left: '-9999px',
            top: '-9999px',
            width: 0,
            height: 0,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-label={ariaLabel}
        data-ok-prop-panel={kind}
        data-ok-declines-keyboard=""
        data-slot={dataSlot}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest('[data-ok-layer-spawned]')) {
            e.preventDefault();
          }
        }}
        onFocusOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest('[data-ok-layer-spawned]')) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest('[data-ok-layer-spawned]')) {
            e.preventDefault();
          }
        }}
        className={cn(
          'ok-interaction-prop-panel pointer-events-auto p-3',
          layout === 'wide' ? 'w-[min(720px,calc(100%-1rem))]' : 'w-80',
          className,
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
};
