import { Slot } from 'radix-ui';
import type * as React from 'react';
import type { PaneId } from '@/lib/pane-visibility-store';
import { cn } from '@/lib/utils';

export type PaneCardVariant = 'card' | 'flat';

export const PANE_CARD_GAP_PX = 8;
export const PANE_CARD_DIVIDER_PX = 1;
export const PANE_CARD_INSET_PX = PANE_CARD_GAP_PX - PANE_CARD_DIVIDER_PX;
export const PANE_CARD_GAP_LEAD_INSET_PX = 4;
export const PANE_CARD_GAP_TRAIL_INSET_PX = PANE_CARD_INSET_PX - PANE_CARD_GAP_LEAD_INSET_PX;
export const PANE_CARD_TOP_BAR_CLASS = 'h-11 shrink-0';
export const SECONDARY_PANEL_SURFACE_CLASS = cn(
  'bg-sidebar [:is(html[data-color-theme=solarized],html[data-color-theme=monokai])_&]:[--muted-foreground:var(--sidebar-foreground)]',
  '[html[data-color-theme=gruvbox]_&]:[--secondary-panel-accent:color-mix(in_srgb,var(--primary),white_10%)]',
  '[html[data-color-theme=solarized]_&]:[--secondary-panel-accent:color-mix(in_srgb,var(--primary),white_15%)]',
  '[html[data-color-theme=catppuccin-latte]_&]:[--secondary-panel-accent:color-mix(in_srgb,var(--primary),black_10%)]',
);

const PANE_CARD_DIVIDER_CLASS: Record<'horizontal' | 'vertical', string> = {
  vertical: 'z-10 bg-transparent after:w-2!',
  horizontal: 'z-10 bg-transparent aria-[orientation=horizontal]:after:h-2!',
};

export function paneCardDividerClass(
  variant: PaneCardVariant,
  orientation: 'horizontal' | 'vertical',
): string | undefined {
  return variant === 'card' ? PANE_CARD_DIVIDER_CLASS[orientation] : undefined;
}

const PANE_CARD_BASE_CLASS =
  'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background';
const PANE_CARD_SHAPE_CLASS =
  'rounded-xl shadow-[0_2px_8px_0_rgb(0_0_0/0.08),0_1px_2px_-1px_rgb(0_0_0/0.1)]';

interface PaneCardProps extends React.ComponentProps<'div'> {
  readonly pane: PaneId;
  readonly variant?: PaneCardVariant;
  readonly asChild?: boolean;
}

function PaneCard({ pane, variant = 'card', asChild = false, className, ...props }: PaneCardProps) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="pane-card"
      data-pane={pane}
      data-variant={variant}
      className={cn(PANE_CARD_BASE_CLASS, variant === 'card' && PANE_CARD_SHAPE_CLASS, className)}
      {...props}
    />
  );
}

export { PaneCard };
