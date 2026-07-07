/**
 * Notion-style empty-state pill rendered when a descriptor's autoFocus-flagged
 * required prop is empty (e.g. fresh `<img src="" />`). Pure UI: no editor
 * knowledge, no popover knowledge — the parent (`JsxComponentView`) wraps it
 * in `<PopoverAnchor asChild>` and supplies `onClick` to drive the popover.
 *
 * Click bubbles up; the parent's `handleBodyClick` short-circuits when
 * `showPlaceholder` is true so the same click does not double-fire setNodeSelection.
 *
 * Root element is a `<div role="button">`, NOT a native `<button>`. Native
 * buttons capture mousedown for activation, which prevents the wrapper's
 * HTML5 drag (`data-drag-handle="" draggable="true"`) from initiating drag-
 * to-reorder. A non-button div lets mousedown propagate to the wrapper so
 * drag works through the pill the same way it works through a configured
 * `<img>` / `<video>`. Keyboard activation is handled by the wrapper's
 * `handleKeyDown` (Enter/Space when selected), so no per-element keyboard
 * wiring is needed here.
 */
import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

interface DescriptorPlaceholderProps extends Omit<React.ComponentProps<'div'>, 'onClick'> {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  selected?: boolean;
}

export function DescriptorPlaceholder({
  label,
  Icon,
  onClick,
  selected,
  className,
  ...rest
}: DescriptorPlaceholderProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <button> intercepts mousedown and breaks the wrapper's HTML5 drag-to-reorder. The wrapper's handleKeyDown also covers Enter/Space activation when selected; the local onKeyDown below provides a self-contained a11y story.
    <div
      {...rest}
      role="button"
      tabIndex={-1}
      contentEditable={false}
      data-descriptor-placeholder=""
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      // Without preventDefault on mousedown, browsers move focus out of the
      // PM-managed wrapper when the click target is contentEditable={false}
      // — that focus reroute fires before openPanel can dispatch its
      // setNodeSelection, and PM's selectionUpdate handler wipes the
      // selection before it is read. `preventDefault` keeps focus inside the
      // editor; `stopPropagation` keeps PM's own mousedown handler from
      // running its own selection logic. Mirrors the chrome bar's defense at
      // `.jsx-component-chrome` `onMouseDown`.
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-transparent px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
