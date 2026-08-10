import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Card — bordered content shell with Header / Title / Description / Action /
 * Content / Footer slots.
 *
 * Taken from this project's configured `radix-nova` style rather than the
 * default one. Unlike that style's Spinner, its Card imports nothing but `cn`,
 * so it resolves here as-is and there was no reason to hand-author from the
 * default source.
 *
 * One deliberate divergence from upstream, recorded so a future `shadcn diff`
 * reviewer knows the drift is intentional rather than rot: `asChild` on the
 * root. Upstream Card is always a `<div>`, but the call sites here are named
 * `<section>` region landmarks, and swapping them for divs would drop a
 * landmark screen-reader users navigate by. `asChild` is the same Slot escape
 * hatch Button, Badge, and Sidebar already use in this directory. (Dialog and
 * Sheet also take an `asChild` prop, but theirs forwards to Radix's own
 * primitives rather than rendering through Slot here.)
 *
 * `size="sm"` drives the `--card-spacing` custom property, which every slot
 * reads for its padding. It is the right default for the narrow sidebar and
 * settings surfaces this app puts cards on; `default` is upstream's roomier
 * content-card spacing.
 */
function Card({
  className,
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm'; asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp
      data-slot="card"
      data-size={size}
      className={cn(
        'group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        'cn-font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm',
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-content" className={cn('px-(--card-spacing)', className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        'flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)',
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
