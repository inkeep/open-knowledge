import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Inset notice box: an icon column, a title, a description, and an optional
 * corner action.
 *
 * Vendored from shadcn/ui's `radix-nova` alert. One deliberate divergence from
 * upstream, recorded so a future `shadcn diff` reviewer knows the drift is
 * intentional rather than rot: the two physical-direction utilities that
 * position the action slot (`pr-18` reserving room for it, `right-2` placing
 * it) are written as their logical equivalents `pe-18` / `end-2`, so the corner
 * action follows the reading direction. Enforced for JSX class strings by the
 * no-physical-direction-utility lint rule; applied to the variant string too so
 * the reserved padding and the action stay on the same side.
 *
 * `role="alert"` is an assertive live region: inserting one of these into a
 * live page interrupts the screen reader with its whole contents. That is right
 * for something the user must hear now and wrong for a notice that simply
 * arrives alongside the surface it belongs to. Props spread last, so a passive
 * notice passes `role="note"` to opt out.
 */
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pe-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive:
          'bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-balance text-muted-foreground text-sm md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-action" className={cn('absolute top-2 end-2', className)} {...props} />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
